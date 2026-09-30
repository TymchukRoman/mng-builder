import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ServiceState } from '@manga/shared';
import { GpuBusyError, PermanentError, TransientError } from '../jobs/index.js';
import { abortError, raceAbort, sleep } from '../util/abort.js';
import type { ComfyGraph } from './comfy-graph.js';
import { GPU_RESUME_FREE_BYTES } from './gpu-monitor.js';
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

/** Every this-many history polls, run() checks GET /queue that ComfyUI still knows the prompt (M4). */
const LIVENESS_EVERY_POLLS = 10;
const OUT_OF_MEMORY = /out of memory|OutOfMemoryError/i;

export function executionError(entry: HistoryEntry): string {
  const error = entry.status?.messages?.find(([type]) => type === 'execution_error')?.[1];
  if (!error) return 'ComfyUI reported an error without details';
  return `ComfyUI failed in ${String(error['node_type'] ?? '?')} (node ${String(error['node_id'] ?? '?')}): ${String(error['exception_message'] ?? '').trim()}`;
}

/**
 * Stall watchdog: the longest wait from submitting a prompt to its first sampling step (`progress` message). Model
 * loading can legitimately take minutes before that step, so this limit is generous.
 */
export const FIRST_PROGRESS_TIMEOUT_MS = 10 * 60_000;
/** Stall watchdog: once sampling started, the longest allowed gap between two progress signals of the prompt. Live
 *  case: with a game holding most of the VRAM, ComfyUI spilled to system RAM and sat at "Sampling 3/8" for 21 min. */
export const STALL_TIMEOUT_MS = 3 * 60_000;
/** W1 R2: below this much VRAM left for ComfyUI (free plus what it holds itself), a run does not start: another app is
 *  using the GPU, and the run would crawl. The job pauses the gpu lane instead. Generic: every image model family needs more. */
export const GPU_PAUSE_FREE_BYTES = 3e9;
/** Socket messages that show the prompt is moving. */
const PROGRESS_SIGNALS: ReadonlySet<string> = new Set(['progress', 'executing', 'executed', 'execution_cached']);
const STALL_ADVICE = 'GPU memory is probably full; close games or other GPU apps';

function span(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${ms} ms`;
}

interface DeviceStats { vram_free?: number; torch_vram_total?: number; torch_vram_free?: number }

/** torch_vram_total below this counts as "nothing resident" (the VRAM waits). */
const VRAM_EMPTY_BYTES = 512 * 1024 * 1024;
/** Families whose model is small enough to sit beside any other: preparing for them frees nothing (M3a). */
const NEUTRAL_FAMILIES: ReadonlySet<string> = new Set(['upscale']);
/** `lastFamily` before this process prepared anything: ComfyUI is shared and outlives the server, so what it holds
 *  is unknown (M1). */
const UNKNOWN_FAMILY = Symbol('unknown family');

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
  /** Hard bound on the wait for ComfyUI to drop its VRAM after /free (M3b). */
  private readonly vramWaitMs: number;
  private readonly firstProgressTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly pauseFreeBytes: number;
  private starting: Promise<void> | null = null;
  /** Model family last prepared for (via prepareFor) or resident from a run; null once free() has cleared it;
   *  UNKNOWN_FAMILY until this process prepared anything. */
  private lastFamily: string | null | typeof UNKNOWN_FAMILY = UNKNOWN_FAMILY;

  constructor(opts: {
    url: string; launcher?: ComfyLauncher | null; pollMs?: number; dataDir?: string | null; vramWaitMs?: number;
    firstProgressTimeoutMs?: number; stallTimeoutMs?: number; pauseFreeBytes?: number;
  }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.launcher = opts.launcher ?? null;
    this.pollMs = opts.pollMs ?? 400;
    this.dataDir = opts.dataDir ?? null;
    this.vramWaitMs = opts.vramWaitMs ?? 15_000;
    this.firstProgressTimeoutMs = opts.firstProgressTimeoutMs ?? FIRST_PROGRESS_TIMEOUT_MS;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    this.pauseFreeBytes = opts.pauseFreeBytes ?? GPU_PAUSE_FREE_BYTES;
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

  /**
   * `signal` (M5): a cancelled job stops waiting at once with the abort error. The launch poll itself is shared and
   * keeps going, so the next job joins it instead of spawning a second ComfyUI.
   */
  async ensureServer(onStatus?: (label: string) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (await this.isUp()) return;
    if (signal?.aborted) throw abortError(signal); // R1: isUp() takes up to 3 s; don't start a launch for a dead job
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
    await raceAbort(this.starting, signal);
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
    // Stall watchdog: when the prompt stops moving (a game holding the VRAM makes ComfyUI spill to system RAM and
    // crawl), stalled aborts the wait. The catch below decides what it was (W1 F1): a GpuBusyError when another app
    // still holds the memory (the lane pauses), else a TransientError (the job spends an attempt).
    const stalled = new AbortController();
    const watch = { submittedAt: Date.now(), lastSignalAt: Date.now(), stepped: false };
    socket?.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: { type?: string; data?: { prompt_id?: string; node?: unknown; value?: unknown; max?: unknown } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      const d = message.data;
      if (!d || d.prompt_id !== promptId) return;
      const type = message.type ?? '';
      // The prompt waited behind another client's in ComfyUI's queue until now: the first-step clock starts here.
      if (type === 'execution_start' && !watch.stepped) watch.submittedAt = Date.now();
      if (PROGRESS_SIGNALS.has(type)) {
        watch.lastSignalAt = Date.now();
        if (type === 'progress') watch.stepped = true;
      }
      if (typeof d.node !== 'string') return;
      const classType = graph[d.node]?.class_type ?? '';
      if (type === 'executing') say(stageLabel(classType));
      else if (type === 'progress' && typeof d.value === 'number' && typeof d.max === 'number') {
        say(classType === 'ImageUpscaleWithModel' ? 'Upscaling' : 'Sampling', d.value, d.max);
      }
    });
    let watchdog: ReturnType<typeof setInterval> | null = null;
    // Without the socket there are no signals to watch: the run then relies on the history poll alone, as before.
    socket?.on('close', () => { if (watchdog) clearInterval(watchdog); });
    const waitSignal = signal ? AbortSignal.any([signal, stalled.signal]) : stalled.signal;
    let accepted = false;
    try {
      const room = await this.roomForRun(signal);
      if (room !== null && room < this.pauseFreeBytes) {
        const reason = `GPU busy: only ${(room / 1e9).toFixed(1)} GB of GPU memory free (${STALL_ADVICE})`;
        say(reason);
        throw new GpuBusyError(reason); // nothing submitted: the catch below has no prompt to cancel
      }
      say('Queued');
      watch.submittedAt = Date.now();
      watch.lastSignalAt = watch.submittedAt;
      const res = await this.request('/prompt', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
      }, 60_000, signal);
      if (res.status === 400) {
        const body: unknown = await res.json().catch(() => null);
        throw new ComfyRejectedError(formatRejection(body), body);
      }
      if (!res.ok) throw new PermanentError(`ComfyUI answered ${res.status} on /prompt`);
      accepted = true;
      if (socket && socket.readyState === socket.OPEN) watchdog = this.startWatchdog(watch, stalled, say);
      const entry = await this.waitForHistory(promptId, waitSignal);
      if (watchdog) clearInterval(watchdog);
      // I3: the PNG lives in the library now; ComfyUI's own copy is removed once downloaded (or given up on).
      const images = await this.fetchOutputs(entry, signal).finally(() => this.removeOutputs(entry));
      if (images.length === 0) throw new PermanentError('ComfyUI finished without producing an image');
      return { promptId, images, durationMs: Date.now() - started };
    } catch (err) {
      if (watchdog) clearInterval(watchdog);
      if (signal?.aborted) {
        await this.cancelPrompt(promptId);
        throw abortError(signal);
      }
      if (stalled.signal.aborted) {
        // Stop the crawling prompt (or drop it if it is still queued), then unload the models so the next attempt,
        // and the next job in the lane, start from a clean GPU.
        await this.cancelPrompt(promptId);
        await this.free();
        const stall = abortError(stalled.signal);
        // W1 F1: only a stall while another app still holds the memory (read after the unload) pauses the lane.
        const after = await this.vramAvailable(undefined, 3_000);
        if (after !== null && after < GPU_RESUME_FREE_BYTES) throw new GpuBusyError(stall.message, { stalled: true });
        throw stall;
      }
      // M6: whatever failed after ComfyUI accepted the prompt, take it out of ComfyUI's queue before the job is
      // retried, so a retry never runs next to (or after) the old prompt. A no-op for a prompt that already ended.
      if (accepted) await this.cancelPrompt(promptId);
      throw err;
    } finally {
      socket?.close();
    }
  }

  /**
   * Checks `watch` a few times per limit. Before the first sampling step the prompt gets `firstProgressTimeoutMs`
   * from submission (model loading); after it, at most `stallTimeoutMs` between two progress signals. A tripped limit
   * shows its reason as the progress label and aborts `stalled` with a TransientError carrying it (run() turns it into a
   * GpuBusyError when another app holds the memory, W1 F1).
   */
  private startWatchdog(
    watch: { submittedAt: number; lastSignalAt: number; stepped: boolean },
    stalled: AbortController,
    say: (label: string) => void,
  ): ReturnType<typeof setInterval> {
    const tickMs = Math.max(10, Math.min(1_000, Math.floor(Math.min(this.firstProgressTimeoutMs, this.stallTimeoutMs) / 5)));
    const timer = setInterval(() => {
      const now = Date.now();
      let reason: string | null = null;
      if (watch.stepped) {
        if (now - watch.lastSignalAt > this.stallTimeoutMs) reason = `GPU stalled: no progress for ${span(this.stallTimeoutMs)} (${STALL_ADVICE})`;
      } else if (now - watch.submittedAt > this.firstProgressTimeoutMs) {
        reason = `GPU stalled: no progress for ${span(this.firstProgressTimeoutMs)} after queueing (${STALL_ADVICE})`;
      }
      if (reason === null) return;
      clearInterval(timer);
      console.error(`[manga] comfy: ${reason}`);
      say(reason);
      stalled.abort(new TransientError(reason));
    }, tickMs);
    return timer;
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
   * per sampling step; 13 s/step after `/free`). Same family as last time → no-op. On a switch, `release()`s.
   * - M1: the first call of this process doesn't know what the shared ComfyUI holds, so it releases when
   *   `/system_stats` reports torch_vram_total ≥ 512 MiB, and not when VRAM is already empty.
   * - M3a: `upscale` is family-neutral (a tiny model beside the checkpoint): no free, `lastFamily` unchanged.
   * Never throws (G2: an unreachable ComfyUI just stops waiting), except the abort error when `signal` aborts (M5).
   */
  async prepareFor(family: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (NEUTRAL_FAMILIES.has(family)) return;
    const last = this.lastFamily;
    const mustFree = last === UNKNOWN_FAMILY
      ? ((await this.vramTotal(signal, 3_000)) ?? 0) >= VRAM_EMPTY_BYTES
      : last !== null && last !== family;
    if (mustFree) await this.release(signal);
    this.lastFamily = family;
  }

  /**
   * `free()`, then the bounded wait for the unload to actually take effect: ComfyUI applies `/free` asynchronously
   * (its prompt worker processes the flag on its next wake-up), so VRAM is reported unchanged for a few seconds right
   * after the POST. prepareFor's family switch and the GPU arbiter's releaser (handing the GPU to ollama, M2) use it.
   * Never throws (G2), except the abort error when `signal` aborts (M5).
   */
  async release(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    await this.free();
    await this.waitForVramFreed(signal);
  }

  /** Polls GET /system_stats every `pollMs` until `devices[0].torch_vram_total` drops below 512 MiB. `vramWaitMs`
   *  (15 s) is a hard bound (M3b): the deadline is checked before each poll, and each poll only gets the time left.
   *  Never throws (G2): any fetch failure, non-OK status, or missing field just ends the wait — except the abort
   *  error when `signal` aborts (M5). */
  private async waitForVramFreed(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.vramWaitMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const total = await this.vramTotal(signal, Math.min(3_000, remaining));
      if (total === null || total < VRAM_EMPTY_BYTES) return;
      const left = deadline - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(this.pollMs, left), signal);
    }
  }

  /** `devices[0].torch_vram_total` from GET /system_stats, or null when it can't be read in `timeoutMs` (down,
   *  non-OK, missing field). Rejects only with the abort error when `signal` aborts. */
  private async vramTotal(signal: AbortSignal | undefined, timeoutMs: number): Promise<number | null> {
    const total = (await this.device(signal, timeoutMs))?.torch_vram_total;
    return typeof total === 'number' ? total : null;
  }

  /**
   * W1 F13: the VRAM available for a run, read again every `pollMs` until the `vramWaitMs` bound while it is below
   * `pauseFreeBytes`: memory that is being released right now (the GPU arbiter's ollama unload does not wait for the
   * drop) must not pause the lane. Null when it can't be read; rejects only with the abort error.
   */
  private async roomForRun(signal: AbortSignal | undefined): Promise<number | null> {
    const deadline = Date.now() + this.vramWaitMs;
    let room = await this.vramAvailable(signal, 3_000);
    while (room !== null && room < this.pauseFreeBytes) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(this.pollMs, left), signal);
      room = await this.vramAvailable(signal, 3_000);
    }
    return room;
  }

  /** W1 R2 (the GPU monitor): the VRAM ComfyUI could use now, or null when ComfyUI cannot be reached. */
  availableVram(signal?: AbortSignal): Promise<number | null> {
    return this.vramAvailable(signal, 3_000);
  }

  /**
   * The VRAM ComfyUI could use for the next run: the device's free memory plus what ComfyUI's own torch holds
   * (`vram_free` already counts torch's reserved-but-unused part, so that part is not added twice). Its own resident
   * model is not "taken": only other apps are. Null when it can't be read; rejects only with the abort error.
   */
  private async vramAvailable(signal: AbortSignal | undefined, timeoutMs: number): Promise<number | null> {
    const device = await this.device(signal, timeoutMs);
    if (typeof device?.vram_free !== 'number') return null;
    const torchHeld = (device.torch_vram_total ?? 0) - (device.torch_vram_free ?? 0);
    return device.vram_free + Math.max(0, torchHeld);
  }

  /** `devices[0]` from GET /system_stats, or null when it can't be read in `timeoutMs` (down, non-OK, no device).
   *  Rejects only with the abort error when `signal` aborts. */
  private async device(signal: AbortSignal | undefined, timeoutMs: number): Promise<DeviceStats | null> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${this.url}/system_stats`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) return null;
      const stats = (await res.json()) as { devices?: DeviceStats[] } | null;
      return stats?.devices?.[0] ?? null;
    } catch {
      if (signal?.aborted) throw abortError(signal);
      return null;
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

  /**
   * Polls /history until the run finished. Liveness (M4): every LIVENESS_EVERY_POLLS polls, a prompt that is in
   * neither GET /queue nor the history (the queue was cleared from the web UI, or by another client of the shared
   * server) fails as a TransientError instead of holding the gpu lane forever.
   */
  private async waitForHistory(promptId: string, signal: AbortSignal | undefined): Promise<HistoryEntry> {
    for (let poll = 1; ; poll += 1) {
      if (signal?.aborted) throw abortError(signal);
      const entry = await this.historyEntry(promptId, signal);
      if (entry) {
        if (entry.status?.status_str === 'error') throw await this.runFailure(entry);
        if (entry.status?.completed || entry.status?.status_str === 'success') return entry;
      } else if (poll % LIVENESS_EVERY_POLLS === 0 && !(await this.isQueued(promptId, signal))) {
        // It may have finished between the two reads: look at the history once more before calling it lost.
        if (!(await this.historyEntry(promptId, signal))) throw new TransientError('ComfyUI lost the prompt');
        continue;
      }
      await sleep(this.pollMs, signal);
    }
  }

  private async historyEntry(promptId: string, signal: AbortSignal | undefined): Promise<HistoryEntry | undefined> {
    const path = `/history/${encodeURIComponent(promptId)}`;
    const res = await this.request(path, { method: 'GET' }, 60_000, signal);
    // Not 5xx (already thrown by request()) but still not OK: an unexpected status (e.g. 404) must not be
    // parsed as a history body — it isn't retryable by polling again, so it's permanent, not transient.
    if (!res.ok) throw new PermanentError(`ComfyUI ${path} answered ${res.status}`);
    return ((await res.json()) as Record<string, HistoryEntry>)[promptId];
  }

  /** True while GET /queue lists the prompt as running or pending. An answer it can't read counts as queued. */
  private async isQueued(promptId: string, signal: AbortSignal | undefined): Promise<boolean> {
    const res = await this.request('/queue', { method: 'GET' }, 60_000, signal);
    if (!res.ok) return true;
    const body = (await res.json().catch(() => null)) as { queue_running?: unknown[]; queue_pending?: unknown[] } | null;
    if (!body) return true;
    return [...(body.queue_running ?? []), ...(body.queue_pending ?? [])].some((item) => Array.isArray(item) && item[1] === promptId);
  }

  /** The error for a run whose history says 'error' (M4): interrupted by someone else → transient; CUDA out of
   *  memory → free VRAM, then transient (a retry after /free usually fits); anything else → permanent. */
  private async runFailure(entry: HistoryEntry): Promise<Error> {
    const messages = entry.status?.messages ?? [];
    if (messages.some(([type]) => type === 'execution_interrupted')) return new TransientError('ComfyUI run was interrupted');
    const message = executionError(entry);
    const error = messages.find(([type]) => type === 'execution_error')?.[1];
    if (OUT_OF_MEMORY.test(`${message} ${String(error?.['exception_type'] ?? '')}`)) {
      await this.free();
      return new TransientError(`${message} (VRAM freed for the retry)`);
    }
    return new PermanentError(message);
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
    // R3: a prompt whose history already reached a terminal state (it finished or errored on its own, e.g. while
    // this call raced a different failure) must not be cancelled or interrupted again — on an older ComfyUI that
    // ignores prompt_id, /interrupt with no argument stops whatever is running, which could be another client's
    // run on the shared server.
    if (await this.isFinished(promptId)) return;
    try {
      await fetch(`${this.url}/queue`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // best effort
    }
    await this.interrupt(promptId);
  }

  /** Best-effort: true when ComfyUI's history already holds a terminal entry (completed or errored) for
   *  `promptId`. Any failure to read it counts as "not known to be finished", so cancelPrompt still runs as
   *  before — this only ever makes cancellation *more* conservative, never less. */
  private async isFinished(promptId: string): Promise<boolean> {
    try {
      const entry = await this.historyEntry(promptId, undefined);
      return entry !== undefined && (entry.status?.completed === true || entry.status?.status_str === 'success' || entry.status?.status_str === 'error');
    } catch {
      return false;
    }
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
