export interface ExitControl {
  /** POST /api/shutdown: stop, then exit. */
  request(): void;
  /** SIGINT/SIGTERM: the first stops, then exits; the second exits at once with 130. */
  signal(): void;
}

/**
 * How main.ts ends the process. The first stop request (signal or API) runs `stop()` then exits 0, or 1 if stopping
 * failed; later requests wait for it. A second signal means "now": exit 130 without waiting.
 */
export function exitControl(stop: () => Promise<void>, exit: (code: number) => void, log: (message: string) => void = console.error): ExitControl {
  let stopping = false;
  let signals = 0;
  const request = (): void => {
    if (stopping) return;
    stopping = true;
    stop().then(
      () => exit(0),
      (err: unknown) => {
        log(`manga server failed to stop: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        exit(1);
      },
    );
  };
  return {
    request,
    signal() {
      signals += 1;
      if (signals === 1) {
        request();
        return;
      }
      log('manga server: second interrupt, exiting now');
      exit(130);
    },
  };
}
