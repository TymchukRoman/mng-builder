import { abortError, sleep } from '../util/abort.js';
import { GpuBusyError } from './errors.js';

/**
 * W1 R2 / final I1: the one GPU-room check of the gpu lane, shared by imaging (ComfyClient, before it submits a prompt
 * and after a stall) and AI (the ollama engine, before a call and after a timeout).
 */

/** Below this much VRAM left (not taken by another app), gpu-lane work does not start: another app, e.g. a game, is
 *  using the GPU, and the work would crawl. The job pauses the gpu lane instead. Generic: every model family needs more. */
export const GPU_PAUSE_FREE_BYTES = 3e9;
/** The gpu lane resumes once this much VRAM is left: enough for the largest routed recipe. A stall (or an ollama
 *  timeout) with less than this left afterwards counts as caused by another app (W1 F1). */
export const GPU_RESUME_FREE_BYTES = 8e9;
/** Appended to every busy or stall reason the user sees. */
export const GPU_BUSY_ADVICE = 'GPU memory is probably full; close games or other GPU apps';

/** The VRAM gpu-lane work could use now (not taken by another app), in bytes, or null when it cannot be read.
 *  ComfyClient.availableVram is the probe: ComfyUI's /system_stats sees the whole device. */
export interface GpuProbe { availableVram(signal?: AbortSignal): Promise<number | null> }

/** The text of a refusal before any work started (the job bar and the error both show it). */
export function gpuBusyReason(room: number): string {
  return `GPU busy: only ${(room / 1e9).toFixed(1)} GB of GPU memory free (${GPU_BUSY_ADVICE})`;
}

export interface GpuRoomOptions {
  /** Refuse below this (default GPU_PAUSE_FREE_BYTES). */
  pauseFreeBytes?: number;
  /** W1 F13: while the room is below the limit, read it again every `pollMs` until this bound has passed, so memory
   *  that is being released right now (an unload that does not wait for the drop) does not pause the lane. */
  waitMs: number;
  pollMs: number;
  signal?: AbortSignal;
  /** Called with the reason just before the GpuBusyError is thrown (ComfyClient shows it as the job's progress). */
  onBusy?: (reason: string) => void;
}

/**
 * Reads the room with `read` and throws a GpuBusyError (not stalled: nothing was started, so the queue requeues the job
 * without spending an attempt and pauses the gpu lane) when it stays below the limit. Returns the room, or null when it
 * could not be read: no reading means go (ComfyUI may simply not be running yet). Rejects with the abort error when
 * `signal` aborts.
 */
export async function ensureGpuRoom(
  read: (signal?: AbortSignal) => Promise<number | null>,
  opts: GpuRoomOptions,
): Promise<number | null> {
  const limit = opts.pauseFreeBytes ?? GPU_PAUSE_FREE_BYTES;
  const deadline = Date.now() + opts.waitMs;
  let room = await read(opts.signal);
  while (room !== null && room < limit) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(opts.pollMs, left), opts.signal);
    room = await read(opts.signal);
  }
  if (opts.signal?.aborted) throw abortError(opts.signal);
  if (room !== null && room < limit) {
    const reason = gpuBusyReason(room);
    opts.onBusy?.(reason);
    throw new GpuBusyError(reason);
  }
  return room;
}

/**
 * After gpu-lane work stalled or timed out: true when another app most likely holds the memory, i.e. the room read
 * afterwards is below GPU_RESUME_FREE_BYTES. `unreadableIsBusy`: ComfyUI answered a moment ago, so a read that fails now
 * (a slow /system_stats under a game's load, W1 final M3) counts as busy; the stall cap (MAX_STALL_REQUEUES) bounds it.
 */
export function busyAfterStall(after: number | null, unreadableIsBusy: boolean): boolean {
  if (after === null) return unreadableIsBusy;
  return after < GPU_RESUME_FREE_BYTES;
}
