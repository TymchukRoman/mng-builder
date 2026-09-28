/** The error to throw when `signal` aborted: its reason if that is an Error, else a plain "Cancelled". */
export function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

/** `work`, or a rejection with `abortError(signal)` as soon as the signal aborts (`work` itself keeps going). */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  // R1: always attach a handler to `work`, even on the early-return path below. Otherwise, when the signal is
  // already aborted, this function returns a fresh rejected promise and never subscribes to `work` — so if `work`
  // is a shared promise nobody else is watching (e.g. ComfyClient.ensureServer's launch, cancelled during the
  // isUp() check) and it later rejects, nothing ever handles that rejection and the process crashes.
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** setTimeout as a promise that rejects with `abortError(signal)` when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
