import { describe, expect, it } from 'vitest';
import { raceAbort } from '../src/util/abort.js';

/** Runs `fn` with a temporary 'unhandledRejection' listener and returns whatever reasons it saw, instead of
 *  letting a real unhandled rejection crash the test process. */
async function unhandledRejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // Node reports an unhandled rejection on the next microtask/macrotask turn, not synchronously when the
    // promise rejects, so give it a turn to surface before we check.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('raceAbort (R1)', () => {
  it('never leaves `work` unhandled when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let rejectWork!: (err: Error) => void;
    const work = new Promise<void>((_resolve, reject) => { rejectWork = reject; });

    const seen = await unhandledRejectionsDuring(async () => {
      const raced = raceAbort(work, controller.signal);
      await expect(raced).rejects.toThrow(); // the abort wins immediately, as before
      // `work` itself is a separate, shared promise (e.g. ComfyClient's shared launch) that keeps going and can
      // still reject later — that must never become an unhandled rejection.
      rejectWork(new Error('the shared launch failed later'));
    });

    expect(seen).toEqual([]);
  });

  it('still resolves/rejects with `work`s own outcome when the signal never aborts', async () => {
    const work = Promise.resolve('done');
    await expect(raceAbort(work)).resolves.toBe('done');
    await expect(raceAbort(work, new AbortController().signal)).resolves.toBe('done');
  });

  it('still aborts immediately once the signal fires after the race starts', async () => {
    const controller = new AbortController();
    const work = new Promise<void>(() => {}); // never settles on its own
    const raced = raceAbort(work, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(raced).rejects.toThrow();
  });
});
