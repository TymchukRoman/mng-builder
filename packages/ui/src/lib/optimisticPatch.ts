import { useMutation, useQueryClient, type QueryClient, type QueryKey, type UseMutationOptions } from '@tanstack/react-query';

/**
 * One optimistic PATCH pattern (M4) for a cached value that the server replaces nested objects of whole (manga
 * styleGuide/pageFormat, settings engine.tasks). Every save of one value shares `mutationKey`, so the rules below
 * count all of them, from every component:
 * - onMutate: cancel refetches, then write `apply(prev, body)` at once. The next edit builds on the cache, so it carries this one.
 * - onError: roll back to the value before this save, unless another save of the value is still in flight (then the
 *   rollback would drop that save's optimistic value; the refetch on the last settle restores the server truth instead).
 * - onSettled: refetch only when the LAST save settles, so an early refetch cannot remove an in-flight edit's value.
 */
export interface OptimisticPatch<T, B, R> {
  queryKey: QueryKey;
  mutationKey: QueryKey;
  send(body: B): Promise<R>;
  apply(prev: T, body: B): T;
  /** Other queries refreshed on the last settle (say the manga list). */
  alsoInvalidate?: readonly QueryKey[];
}

interface Ctx<T> { previous: T | undefined }

/** The optimistic cache value, or undefined when nothing is cached yet (then nothing is written). */
export function optimisticValue<T, B>(prev: T | undefined, body: B, apply: (prev: T, body: B) => T): T | undefined {
  return prev === undefined ? undefined : apply(prev, body);
}

/** The value a failed save restores, or undefined for "leave the cache alone". `inFlight` counts this save too. */
export function rollbackValue<T>(previous: T | undefined, inFlight: number): T | undefined {
  return inFlight <= 1 ? previous : undefined;
}

/** Whether a settling save is the last one in flight (`inFlight` counts this save too). */
export function isLastSettle(inFlight: number): boolean {
  return inFlight <= 1;
}

/** The mutation options, apart from the hook, so tests can drive them with a plain QueryClient. */
export function optimisticPatchOptions<T, B, R>(qc: QueryClient, o: OptimisticPatch<T, B, R>): UseMutationOptions<R, Error, B, Ctx<T>> {
  const inFlight = (): number => qc.isMutating({ mutationKey: o.mutationKey });
  return {
    mutationKey: o.mutationKey,
    mutationFn: o.send,
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: o.queryKey });
      const previous = qc.getQueryData<T>(o.queryKey);
      const next = optimisticValue(previous, body, o.apply);
      if (next !== undefined) qc.setQueryData(o.queryKey, next);
      return { previous };
    },
    onError: (_err, _body, ctx) => {
      const restore = rollbackValue(ctx?.previous, inFlight());
      if (restore !== undefined) qc.setQueryData(o.queryKey, restore);
    },
    onSettled: () => {
      if (!isLastSettle(inFlight())) return;
      for (const key of [o.queryKey, ...(o.alsoInvalidate ?? [])]) void qc.invalidateQueries({ queryKey: key });
    },
  };
}

export function useOptimisticPatch<T, B, R>(o: OptimisticPatch<T, B, R>) {
  const qc = useQueryClient();
  return useMutation(optimisticPatchOptions(qc, o));
}
