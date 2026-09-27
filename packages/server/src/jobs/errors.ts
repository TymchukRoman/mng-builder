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
