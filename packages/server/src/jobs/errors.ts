/** Retried with backoff: network hiccups, ComfyUI restarting, 5xx responses. */
export class TransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/** Failed immediately with the details attached. Any other thrown error is treated the same way. */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/**
 * W1 R2: the GPU has no room for image work (another app, e.g. a game, holds its memory). The queue pauses the job's lane
 * and puts the job back without spending an attempt; the GPU monitor resumes the lane when there is room again.
 * `stalled`: thrown by the stall watchdog after the prompt was on the GPU (not by the check before submitting). The queue
 * caps those requeues per job (W1 F1), so a stall with another cause cannot loop forever.
 */
export class GpuBusyError extends TransientError {
  readonly stalled: boolean;

  constructor(message: string, options?: ErrorOptions & { stalled?: boolean }) {
    super(message, options);
    this.name = 'GpuBusyError';
    this.stalled = options?.stalled ?? false;
  }
}
