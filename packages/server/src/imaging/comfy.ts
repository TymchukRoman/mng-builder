import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ServiceState } from '@manga/shared';
import { PermanentError, TransientError } from '../jobs/index.js';
import { abortError, sleep } from '../util/abort.js';
import type { ComfyGraph } from './comfy-graph.js';
import type { ComfyLauncher } from './launcher.js';

export type { ComfyGraph } from './comfy-graph.js';

/** Uploads land in ComfyUI/input/manga-builder/<imageId>.png (overwrite: image ids are unique). */
export const UPLOAD_SUBFOLDER = 'manga-builder';

export interface ComfyRunOptions {
  signal?: AbortSignal;
  onProgress?: (label: string, value?: number, max?: number) => void;
}
export interface ComfyRunResult { promptId: string; images: Uint8Array[]; durationMs: number }

/** ComfyUI refused the graph at validation (HTTP 400). Never retried; `details` is the raw body. */
export class ComfyRejectedError extends PermanentError {
  constructor(message: string, readonly details: unknown) {
    super(message);
    this.name = 'ComfyRejectedError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const LOADER = /Loader(Simple|GGUF|ModelOnly)?$/;
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced']);

/** Maps the node ComfyUI is executing to the status shown to the user (spec §7). */
export function stageLabel(classType: string): string {
  if (LOADER.test(classType)) return 'Loading model';
  if (SAMPLERS.has(classType)) return 'Sampling';
  if (classType === 'VAEDecode') return 'Decoding';
  if (classType === 'SaveImage') return 'Saving';
  if (classType === 'ImageUpscaleWithModel') return 'Upscaling';
  return 'Preparing';
}

interface NodeError { class_type?: string; errors?: Array<{ message?: string; details?: string }> }

export function formatRejection(body: unknown): string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: { message?: string; details?: string }; node_errors?: Record<string, NodeError> };
  const lines = [`ComfyUI rejected the graph: ${b.error?.message ?? 'unknown error'}${b.error?.details ? ` (${b.error.details})` : ''}`];
  for (const [id, nodeError] of Object.entries(b.node_errors ?? {})) {
    const reasons = (nodeError.errors ?? []).map((e) => [e.message, e.details].filter(Boolean).join(': ')).join('; ');
    lines.push(`node ${id} (${nodeError.class_type ?? '?'}): ${reasons}`);
  }
  return lines.join('\n');
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
}

export function executionError(entry: HistoryEntry): string {
  const error = entry.status?.messages?.find(([type]) => type === 'execution_error')?.[1];
  if (!error) return 'ComfyUI reported an error without details';
  return `ComfyUI failed in ${String(error['node_type'] ?? '?')} (node ${String(error['node_id'] ?? '?')}): ${String(error['exception_message'] ?? '').trim()}`;
}

/** `rel` ('/'-separated, as ComfyUI reports it) under `base`, or null when it would resolve outside it. */
function inside(base: string, rel: string): string | null {
  const root = resolve(base);
  const full = resolve(root, ...rel.split(/[\\/]/));
  const back = relative(root, full);
  return back === '' || back.startsWith('..') || isAbsolute(back) ? null : full;
}

export class ComfyClient {
  readonly url: string;
  private readonly launcher: ComfyLauncher | null;
  private readonly pollMs: number;
  /** The ComfyUI folder (<comfyRoot>/ComfyUI) when it is on this machine; null for fakes and tests (cleanup off). */
  private readonly dataDir: string | null;
  private starting: Promise<void> | null = null;
  /** Model family last prepared for (via prepareFor) or resident from a run; null once free() has cleared it. */
  private lastFamily: string | null = null;

  constructor(opts: { url: string; launcher?: ComfyLauncher | null; pollMs?: number; dataDir?: string | null }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.launcher = opts.launcher ?? null;
    this.pollMs = opts.pollMs ?? 400;
    this.dataDir = opts.dataDir ?? null;
  }

  async health(): Promise<ServiceState> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      return { ok: false, detail: this.launcher ? 'not running (starts automatically on the first image)' : `not reachable at ${this.url}` };
    }
    if (!res.ok) return { ok: false, detail: `ComfyUI answered ${res.status}` };
    const stats = (await res.json()) as { devices?: Array<{ name?: string; vram_free?: number }> };
    const device = stats.devices?.[0];
    return { ok: true, detail: device ? `${device.name ?? 'GPU'} · ${((device.vram_free ?? 0) / 1e9).toFixed(1)} GB free` : 'running' };
  }

  async ensureServer(onStatus?: (label: string) => void): Promise<void> {
    if (await this.isUp()) return;
    const launcher = this.launcher;
    if (!launcher) throw new TransientError(`ComfyUI is not reachable at ${this.url}`);
    this.starting ??= (async (): Promise<void> => {
      onStatus?.('Starting image server');
      launcher.start();
      const deadline = Date.now() + launcher.timeoutMs;
      while (Date.now() < deadline) {
        await sleep(launcher.pollMs);
        if (await this.isUp()) return;
      }
      throw new PermanentError(`ComfyUI did not come up within ${Math.round(launcher.timeoutMs / 1000)} s. See ${launcher.logPath}`);
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  async uploadImage(absPath: string): Promise<string> {
    const bytes = await readFile(absPath);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), basename(absPath));
    form.append('subfolder', UPLOAD_SUBFOLDER);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form });
    if (!res.ok) throw new PermanentError(`ComfyUI refused the upload of ${basename(absPath)}: HTTP ${res.status}`);
    const body = (await res.json()) as { name: string; subfolder?: string };
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  async run(graph: ComfyGraph, opts: ComfyRunOptions = {}): Promise<ComfyRunResult> {
    const { signal, onProgress } = opts;
    if (signal?.aborted) throw abortError(signal);
    const clientId = randomUUID();
    const promptId = randomUUID();
    const started = Date.now();
    let last = '';
    const say = (label: string, value?: number, max?: number): void => {
      if (value === undefined && label === last) return;
      last = label;
      onProgress?.(label, value, max);
    };
    const socket = await this.openSocket(clientId);
    if (signal?.aborted) {
      socket?.close();
      throw abortError(signal);
    }
    socket?.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: { type?: string; data?: { prompt_id?: string; node?: unknown; value?: unknown; max?: unknown } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      const d = message.data;
      if (!d || d.prompt_id !== promptId || typeof d.node !== 'string') return;
      const classType = graph[d.node]?.class_type ?? '';
      if (message.type === 'executing') say(stageLabel(classType));
      else if (message.type === 'progress' && typeof d.value === 'number' && typeof d.max === 'number') {
        say(classType === 'ImageUpscaleWithModel' ? 'Upscaling' : 'Sampling', d.value, d.max);
      }
    });
    try {
      say('Queued');
      const res = await this.request('/prompt', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
      }, 60_000, signal);
      if (res.status === 400) {
        const body: unknown = await res.json().catch(() => null);
        throw new ComfyRejectedError(formatRejection(body), body);
      }
      if (!res.ok) throw new PermanentError(`ComfyUI answered ${res.status} on /prompt`);
      const entry = await this.waitForHistory(promptId, signal);
      // I3: the PNG lives in the library now; ComfyUI's own copy is removed once downloaded (or given up on).
      const images = await this.fetchOutputs(entry, signal).finally(() => this.removeOutputs(entry));
      if (images.length === 0) throw new PermanentError('ComfyUI finished without producing an image');
      return { promptId, images, durationMs: Date.now() - started };
    } catch (err) {
      if (signal?.aborted) {
        await this.cancelPrompt(promptId);
        throw abortError(signal);
      }
      throw err;
    } finally {
      socket?.close();
    }
  }

  /** POST /free {unload_models, free_memory}. Never throws: a down ComfyUI holds no VRAM (G2), so a stopped or
   *  unreachable server must not block the GpuArbiter from handing the GPU to ollama. Logs either way, so a
   *  persistent failure (wrong URL, API mismatch) is still visible instead of silently swallowed.
   *  Also clears `lastFamily`: whoever calls free() (prepareFor on a family switch, or the GPU arbiter's
   *  releaser handing the GPU to ollama) means nothing stays resident in ComfyUI afterwards. */
  async free(): Promise<void> {
    this.lastFamily = null;
    let res: Response;
    try {
      res = await fetch(`${this.url}/free`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(`[manga] comfy free: not reachable at ${this.url}, treating as already released:`, err);
      return;
    }
    if (!res.ok) console.error(`[manga] comfy free: ${this.url} answered ${res.status}, treating as already released`);
  }

  /**
   * Called before running a graph of `family`. ComfyUI's IP-Adapter/CLIP-Vision loaders are cached node outputs,
   * outside ComfyUI's own model manager, so it does not evict them by itself when a different model family loads
   * next — live evidence: qwen-edit-ref loaded only partially with an SDXL+IP-Adapter graph left resident (100 s
   * per sampling step; 13 s/step after `/free`). Same family as last time → no-op. On a switch, frees and then
   * waits for the unload to actually take effect: ComfyUI applies `/free` asynchronously (its prompt worker
   * processes the flag on its next wake-up), so VRAM is reported unchanged for a few seconds right after the
   * POST. Never throws: an unreachable ComfyUI just stops waiting (G2) — the next call surfaces the real problem.
   */
  async prepareFor(family: string): Promise<void> {
    if (this.lastFamily !== null && this.lastFamily !== family) {
      await this.free();
      await this.waitForVramFreed();
    }
    this.lastFamily = family;
  }

  /** Polls GET /system_stats every `pollMs` until `devices[0].torch_vram_total` drops below 512 MiB, or 15 s
   *  have passed. Never throws (G2): any fetch failure, non-OK status, or missing field just ends the wait. */
  private async waitForVramFreed(): Promise<void> {
    const deadline = Date.now() + 15_000;
    const threshold = 512 * 1024 * 1024;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(3_000) });
      } catch {
        return;
      }
      if (!res.ok) return;
      const stats = (await res.json().catch(() => null)) as { devices?: Array<{ torch_vram_total?: number }> } | null;
      const total = stats?.devices?.[0]?.torch_vram_total;
      if (typeof total !== 'number' || total < threshold) return;
      if (Date.now() >= deadline) return;
      await sleep(this.pollMs);
    }
  }

  /**
   * I3, best-effort: removes inputs this client uploaded (names as `uploadImage` returned them) from
   * <dataDir>/input. Never throws; a name that would resolve outside input/ is refused. No-op without a dataDir.
   */
  async removeInputs(names: readonly string[]): Promise<void> {
    await this.removeUnder('input', names);
  }

  /** I3, best-effort: removes a finished run's SaveImage files from <dataDir>/output. Never throws. */
  private async removeOutputs(entry: HistoryEntry): Promise<void> {
    const rels = Object.values(entry.outputs ?? {}).flatMap((node) => (node.images ?? [])
      .filter((image) => (image.type ?? 'output') === 'output')
      .map((image) => (image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename)));
    await this.removeUnder('output', rels);
  }

  /** Removes each file under <dataDir>/<kind>; a missing file is fine. Logs failures once per call, never throws. */
  private async removeUnder(kind: 'input' | 'output', rels: readonly string[]): Promise<void> {
    if (this.dataDir === null || rels.length === 0) return;
    const base = join(this.dataDir, kind);
    const failed: string[] = [];
    for (const rel of rels) {
      const file = inside(base, rel);
      if (file === null) {
        failed.push(`${rel} (outside ${kind}/)`);
        continue;
      }
      try {
        await rm(file, { force: true });
      } catch (err) {
        failed.push(`${rel} (${(err as Error).message})`);
      }
    }
    if (failed.length > 0) console.error(`[manga] comfy cleanup: could not remove from ${base}: ${failed.join('; ')}`);
  }

  /** With a prompt id ComfyUI interrupts only that prompt, and only if it is the one running. */
  async interrupt(promptId?: string): Promise<void> {
    try {
      await fetch(`${this.url}/interrupt`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(promptId ? { prompt_id: promptId } : {}), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // best effort
    }
  }

  private async isUp(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      return false;
    }
  }

  /** `signal` is the caller's abort signal (run()'s opts.signal), composed with the per-call timeout so an
   *  abort interrupts the in-flight fetch immediately instead of waiting for it to settle. A caller abort is
   *  always reported as `abortError(signal)`, never as a `TransientError`, so run()'s catch block can tell
   *  "user cancelled" from "network trouble" and still run the cancel path either way. */
  private async request(path: string, init: RequestInit, timeoutMs = 60_000, signal?: AbortSignal): Promise<Response> {
    const composite = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: composite });
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      throw new TransientError(`ComfyUI not reachable at ${this.url} (${(err as Error).message})`);
    }
    if (res.status >= 500) throw new TransientError(`ComfyUI answered ${res.status} on ${path}`);
    return res;
  }

  private async waitForHistory(promptId: string, signal: AbortSignal | undefined): Promise<HistoryEntry> {
    const path = `/history/${encodeURIComponent(promptId)}`;
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const res = await this.request(path, { method: 'GET' }, 60_000, signal);
      // Not 5xx (already thrown by request()) but still not OK: an unexpected status (e.g. 404) must not be
      // parsed as a history body — it isn't retryable by polling again, so it's permanent, not transient.
      if (!res.ok) throw new PermanentError(`ComfyUI ${path} answered ${res.status}`);
      const body = (await res.json()) as Record<string, HistoryEntry>;
      const entry = body[promptId];
      if (entry) {
        if (entry.status?.status_str === 'error') throw new PermanentError(executionError(entry));
        if (entry.status?.completed || entry.status?.status_str === 'success') return entry;
      }
      await sleep(this.pollMs, signal);
    }
  }

  private async fetchOutputs(entry: HistoryEntry, signal?: AbortSignal): Promise<Uint8Array[]> {
    const images: Uint8Array[] = [];
    for (const node of Object.values(entry.outputs ?? {})) {
      for (const image of node.images ?? []) {
        if ((image.type ?? 'output') !== 'output') continue;
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: 'output' });
        const res = await this.request(`/view?${query.toString()}`, { method: 'GET' }, 120_000, signal);
        if (!res.ok) throw new TransientError(`ComfyUI could not serve ${image.filename}: HTTP ${res.status}`);
        images.push(new Uint8Array(await res.arrayBuffer()));
      }
    }
    return images;
  }

  private async cancelPrompt(promptId: string): Promise<void> {
    try {
      await fetch(`${this.url}/queue`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // best effort
    }
    await this.interrupt(promptId);
  }

  /** Progress only; completion is decided by /history, so a missing socket costs labels, not results. */
  private openSocket(clientId: string): Promise<WebSocket | null> {
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 5_000);
      ws.once('open', () => {
        clearTimeout(timer);
        ws.on('error', () => { /* the run continues without progress */ });
        resolve(ws);
      });
      ws.once('error', () => { clearTimeout(timer); resolve(null); });
    });
  }
}
