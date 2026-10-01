import { readFile } from 'node:fs/promises';
import type { ServiceState, Settings } from '@manga/shared';
import {
  GPU_BUSY_ADVICE, GpuBusyError, PermanentError, TransientError, busyAfterStall, ensureGpuRoom, type GpuArbiter, type GpuProbe,
} from '../jobs/index.js';
import { abortError } from '../util/abort.js';
import { EngineUnavailableError } from './errors.js';
import { completeStructured, jsonSchemaOf } from './structured.js';
import type { JsonRequest, TextEngine } from './types.js';

export interface OllamaEngineOptions {
  url: string;
  models: () => Settings['ollama'];
  /** Local LLM work shares the GPU with ComfyUI; null in unit tests. */
  gpu: GpuArbiter | null;
  /**
   * W1 final I1: the gpu lane's VRAM probe (ComfyClient.availableVram, shared with imaging). With it, a call refuses
   * with a GpuBusyError while another app (a game) holds the GPU memory, and a timeout while it does is a stalled
   * GpuBusyError, so the queue pauses the gpu lane instead of spending attempts. Null or absent: no check.
   */
  probe?: GpuProbe | null;
  /** The bound on re-reading a low VRAM value before refusing (W1 F13, as ComfyClient); default 15 s. */
  vramWaitMs?: number;
  vramPollMs?: number;
  keepAlive?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** F18: ollama's default context window silently truncates long prompts (an episode's scripts/prompts context). */
export const MIN_NUM_CTX = 8192;
/** A larger KV cache spills a 14B model to the CPU; episode calls are chunked (F18) so real prompts stay far below it. */
export const MAX_NUM_CTX = 32768;
/** Conservative: English runs ~4 characters per token, Cyrillic and JSON fewer. */
const CHARS_PER_TOKEN = 2.5;
/** Room for the answer (a 4-page scripts chunk is ~3k tokens). */
const ANSWER_TOKENS = 4096;

/** The context window for a request of `chars` characters: prompt estimate + answer room, rounded up to a power of
 *  two between MIN_NUM_CTX and MAX_NUM_CTX, so small size changes do not make ollama reload the model. */
export function numCtxFor(chars: number): number {
  const needed = Math.ceil(chars / CHARS_PER_TOKEN) + ANSWER_TOKENS;
  let size = MIN_NUM_CTX;
  while (size < needed && size < MAX_NUM_CTX) size *= 2;
  return size;
}

interface ChatInput {
  format: Record<string, unknown>;
  images: string[] | undefined;
  signal: AbortSignal | undefined;
  onProgress: ((label: string) => void) | undefined;
}

/** Direct ollama calls: native /api/chat with `format: <JSON schema>`, `think: false`, `stream: false`. */
export class OllamaEngine implements TextEngine {
  readonly name = 'local' as const;

  constructor(private readonly opts: OllamaEngineOptions) {}

  private get url(): string {
    return this.opts.url.replace(/\/+$/, '');
  }

  private get http(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  completeJson<T>(req: JsonRequest<T>): Promise<T> {
    const format = jsonSchemaOf(req.schema);
    return completeStructured(
      ({ system, prompt }) => this.chat(system, prompt, { format, images: req.images, signal: req.signal, onProgress: req.onProgress }),
      req,
    );
  }

  /** Frees VRAM: a keep_alive 0 request for every model /api/ps reports as loaded. Never throws: a down
   *  ollama has nothing loaded from this process' point of view, so it counts as already released (G2). */
  async unload(): Promise<void> {
    let loaded: string[];
    try {
      const res = await this.http(`${this.url}/api/ps`, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      loaded = (body.models ?? []).map((m) => m.model ?? m.name).filter((n): n is string => typeof n === 'string');
    } catch (err) {
      console.error(`[manga] ollama unload: not reachable at ${this.url}, treating as already released:`, err);
      return;
    }
    for (const model of loaded) {
      try {
        await this.http(`${this.url}/api/generate`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        console.error(`[manga] ollama unload: could not unload ${model}, treating as already released:`, err);
      }
    }
  }

  async health(): Promise<ServiceState> {
    const { textModel, visionModel } = this.opts.models();
    let res: Response;
    try {
      res = await this.http(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      return { ok: false, detail: `ollama not reachable at ${this.url}` };
    }
    if (!res.ok) return { ok: false, detail: `ollama answered ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = new Set((body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string'));
    const missing = [...new Set([textModel, visionModel])].filter((m) => !names.has(m) && !names.has(`${m}:latest`));
    return missing.length === 0
      ? { ok: true, detail: `${textModel}, ${visionModel}` }
      : { ok: false, detail: `model ${missing.join(', ')} not pulled (run: ollama pull ${missing[0]})` };
  }

  /**
   * W1 final I1: the VRAM this engine could use now, or null when it cannot be read (no probe, ComfyUI not reachable).
   * The probe sees the whole device and counts ollama's own loaded models as taken, so their VRAM is added back: only
   * other apps hold memory that matters here.
   */
  private async room(signal?: AbortSignal): Promise<number | null> {
    const comfy = await this.opts.probe?.availableVram(signal) ?? null;
    if (comfy === null) return null;
    return comfy + await this.residentVram(signal);
  }

  /** The VRAM ollama's loaded models hold (/api/ps size_vram); 0 when it cannot be read. */
  private async residentVram(signal?: AbortSignal): Promise<number> {
    try {
      const timeout = AbortSignal.timeout(5_000);
      const res = await this.http(`${this.url}/api/ps`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = (await res.json()) as { models?: Array<{ size_vram?: unknown }> };
      return (body.models ?? []).reduce((sum, m) => sum + (typeof m.size_vram === 'number' ? m.size_vram : 0), 0);
    } catch {
      if (signal?.aborted) throw abortError(signal);
      return 0;
    }
  }

  /**
   * W1 final I1: an ollama call that timed out while another app holds the GPU memory is a stalled GpuBusyError (the
   * queue pauses the gpu lane; MAX_STALL_REQUEUES bounds it). The model, likely loaded partly on the CPU while the memory
   * was taken, is unloaded so the next call loads it afresh. An unreadable value is not busy here: ComfyUI, the probe,
   * may simply not be running yet. Otherwise a plain TransientError (an attempt is spent).
   */
  private async timedOut(timeoutMs: number): Promise<Error> {
    const message = `ollama did not answer within ${Math.round(timeoutMs / 1000)} s`;
    if (!this.opts.probe) return new TransientError(message);
    const after = await this.room();
    if (!busyAfterStall(after, false)) return new TransientError(message);
    await this.unload();
    return new GpuBusyError(`${message} (${GPU_BUSY_ADVICE})`, { stalled: true });
  }

  private async chat(system: string, prompt: string, input: ChatInput): Promise<string> {
    await this.opts.gpu?.acquire('ollama', input.signal);
    // W1 final I1: after the arbiter released ComfyUI, refuse while another app holds the GPU memory.
    if (this.opts.probe) {
      await ensureGpuRoom((signal) => this.room(signal), {
        waitMs: this.opts.vramWaitMs ?? 15_000, pollMs: this.opts.vramPollMs ?? 400,
        ...(input.onProgress ? { onBusy: input.onProgress } : {}), ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    const { textModel, visionModel } = this.opts.models();
    const paths = input.images ?? [];
    const model = paths.length > 0 ? visionModel : textModel;
    const images = paths.length > 0 ? await Promise.all(paths.map(async (p) => (await readFile(p)).toString('base64'))) : null;
    input.onProgress?.(`Asking ${model}`);
    const body = {
      model, stream: false, think: false, keep_alive: this.opts.keepAlive ?? '10m', format: input.format,
      options: { num_ctx: numCtxFor(system.length + prompt.length) },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt, ...(images ? { images } : {}) }],
    };
    const timeoutMs = this.opts.timeoutMs ?? 300_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.http(`${this.url}/api/chat`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
        signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
      });
    } catch {
      if (input.signal?.aborted) throw abortError(input.signal);
      if (timeout.aborted) throw await this.timedOut(timeoutMs);
      throw new EngineUnavailableError(`ollama not reachable at ${this.url}`);
    }
    const text = await res.text();
    if (res.status === 404 && /not found/i.test(text)) throw new EngineUnavailableError(`model ${model} not pulled (run: ollama pull ${model})`);
    if (res.status >= 500) throw new TransientError(`ollama answered ${res.status}: ${text.slice(0, 300)}`);
    if (!res.ok) throw new PermanentError(`ollama answered ${res.status}: ${text.slice(0, 300)}`);
    let message: { content?: unknown; thinking?: unknown } | undefined;
    try {
      message = (JSON.parse(text) as { message?: { content?: unknown; thinking?: unknown } }).message;
    } catch {
      message = undefined;
    }
    // Live evidence (qwen3-vl:8b, think: false + format: <JSON schema>): the answer sometimes lands in
    // message.thinking with message.content left empty, instead of the other way round. Content still wins
    // whenever it is non-blank; thinking is only a fallback for when content has nothing usable.
    if (typeof message?.content === 'string' && message.content.trim().length > 0) return message.content;
    if (typeof message?.thinking === 'string' && message.thinking.trim().length > 0) return message.thinking;
    throw new TransientError('ollama returned no message content');
  }
}
