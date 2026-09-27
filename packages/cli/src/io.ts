/** Where the CLI writes. Tests inject their own; `signal` ends long-running commands (serve, jobs --watch). */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

export const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Calls `fn` once on Ctrl+C, SIGTERM, or when `signal` aborts. Returns a disposer that removes the listeners. */
export function onInterrupt(signal: AbortSignal | undefined, fn: () => void): () => void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    dispose();
    fn();
  };
  const dispose = (): void => {
    process.off('SIGINT', fire);
    process.off('SIGTERM', fire);
    signal?.removeEventListener('abort', fire);
  };
  process.on('SIGINT', fire);
  process.on('SIGTERM', fire);
  if (signal?.aborted) queueMicrotask(fire);
  else signal?.addEventListener('abort', fire);
  return dispose;
}
