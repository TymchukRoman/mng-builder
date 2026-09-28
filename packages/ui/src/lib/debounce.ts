export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: A | undefined;
  const run = (): void => {
    timer = undefined;
    const args = last;
    last = undefined;
    if (args) fn(...args);
  };
  const d = ((...args: A) => {
    last = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced<A>;
  d.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    last = undefined;
  };
  d.pending = () => timer !== undefined;
  return d;
}
