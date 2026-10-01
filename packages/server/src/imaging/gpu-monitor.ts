import { GPU_BUSY_REASON } from '@manga/shared';
import { GPU_RESUME_FREE_BYTES, type GpuProbe, type JobQueue } from '../jobs/index.js';

/** W1 R2: the gpu lane resumes once ComfyUI could use GPU_RESUME_FREE_BYTES of VRAM (jobs/gpu-room.ts, the GPU-room
 *  check shared by imaging and AI). Re-exported here with the probe type. */
export { GPU_RESUME_FREE_BYTES, type GpuProbe };
export const GPU_MONITOR_INTERVAL_MS = 30_000;

export interface GpuMonitorOptions {
  queue: Pick<JobQueue, 'pauseOf' | 'resumeLane' | 'onLanesChanged'>;
  probe: GpuProbe;
  intervalMs?: number;
  resumeFreeBytes?: number;
}

export type GpuCheck = 'idle' | 'waiting' | 'resumed';

/**
 * While the gpu lane is paused as busy (GPU_BUSY_REASON), polls ComfyUI every `intervalMs`. It resumes the lane when
 * ComfyUI has `resumeFreeBytes` of VRAM again, or on the poll after one that found ComfyUI unreachable: ComfyUI was
 * restarted, or it is down and holds no VRAM (W1 F12: nothing else would ever relaunch it, since only a job does). The
 * next job's own check pauses the lane again if the memory is still taken. Any other pause (the user's, the Claude
 * quota's) is never touched. Idle, it does not poll at all.
 */
export class GpuMonitor {
  private readonly intervalMs: number;
  private readonly resumeFreeBytes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The last poll of this pause found ComfyUI unreachable. */
  private sawDown = false;
  private inFlight: Promise<GpuCheck> | null = null;
  /** Task 3 M5: set by stop(); a probe still in flight then never resumes the lane. */
  private stopped = false;

  constructor(private readonly opts: GpuMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? GPU_MONITOR_INTERVAL_MS;
    this.resumeFreeBytes = opts.resumeFreeBytes ?? GPU_RESUME_FREE_BYTES;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = this.opts.queue.onLanesChanged(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll (the timer's, or a test's); concurrent calls share it. */
  check(): Promise<GpuCheck> {
    this.inFlight ??= this.poll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private busy(): boolean {
    return this.opts.queue.pauseOf('gpu')?.reason === GPU_BUSY_REASON;
  }

  private sync(): void {
    if (this.busy() && this.timer === null) {
      this.sawDown = false; // a new busy pause: ComfyUI has not been seen down yet
      this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
      this.timer.unref();
    } else if (!this.busy() && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<GpuCheck> {
    if (!this.busy()) return 'idle';
    let free: number | null;
    try {
      free = await this.opts.probe.availableVram();
    } catch {
      free = null;
    }
    const wasDown = this.sawDown;
    this.sawDown = free === null;
    // Unreachable for the first time: wait one more poll. Reachable with too little room after being up: keep waiting.
    if (!wasDown && (free === null || free < this.resumeFreeBytes)) return 'waiting';
    if (!this.busy()) return 'idle'; // the user paused (or resumed) while the probe ran: theirs wins
    if (this.stopped) return 'idle'; // stopped (shutting down) while the probe ran
    this.opts.queue.resumeLane('gpu');
    return 'resumed';
  }
}
