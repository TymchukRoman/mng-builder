import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { isLastSettle, optimisticPatchOptions, optimisticValue, rollbackValue } from '../src/lib/optimisticPatch';

interface Doc { a: number; nested: { x: number; y: number } }
type Body = Partial<{ a: number; nested: Partial<Doc['nested']> }>;
const apply = (prev: Doc, b: Body): Doc => ({ a: b.a ?? prev.a, nested: { ...prev.nested, ...b.nested } });
const KEY = ['doc'] as const;
const MKEY = ['doc', 'patch'] as const;

describe('optimistic patch rules (M4)', () => {
  it('merge: applies the body to the cached value, and writes nothing when nothing is cached', () => {
    expect(optimisticValue<Doc, Body>({ a: 1, nested: { x: 1, y: 1 } }, { nested: { x: 2 } }, apply)).toEqual({ a: 1, nested: { x: 2, y: 1 } });
    expect(optimisticValue<Doc, Body>(undefined, { a: 2 }, apply)).toBeUndefined();
  });
  it('rollback: restores the previous value only when no other save is in flight', () => {
    const prev: Doc = { a: 1, nested: { x: 1, y: 1 } };
    expect(rollbackValue(prev, 1)).toBe(prev);
    expect(rollbackValue(prev, 2)).toBeUndefined();
  });
  it('last settle: only the last save in flight refetches', () => {
    expect(isLastSettle(1)).toBe(true);
    expect(isLastSettle(2)).toBe(false);
  });
});

describe('optimisticPatchOptions with a QueryClient', () => {
  function setup() {
    const qc = new QueryClient();
    qc.setQueryData<Doc>(KEY, { a: 1, nested: { x: 1, y: 1 } });
    const gates: Array<{ resolve(): void; reject(e: Error): void }> = [];
    const send = (_b: Body): Promise<null> => new Promise((resolve, reject) => { gates.push({ resolve: () => resolve(null), reject }); });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const opts = optimisticPatchOptions<Doc, Body, null>(qc, { queryKey: KEY, mutationKey: MKEY, send, apply, alsoInvalidate: [['list']] });
    const mutate = (b: Body): Promise<unknown> => new MutationObserver(qc, opts).mutate(b).catch(() => undefined);
    const doc = (): Doc | undefined => qc.getQueryData<Doc>(KEY);
    return { qc, gates, invalidate, mutate, doc };
  }

  it('overlapping nested edits both show at once, and only the last settle refetches', async () => {
    const { gates, invalidate, mutate, doc } = setup();
    const first = mutate({ nested: { x: 2 } });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const second = mutate({ nested: { y: 3 } });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(doc()).toEqual({ a: 1, nested: { x: 2, y: 3 } });

    gates[0]?.resolve();
    await first;
    expect(invalidate).not.toHaveBeenCalled();
    gates[1]?.resolve();
    await second;
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([KEY, ['list']]);
  });

  it('a lone failed save rolls back and refetches', async () => {
    const { gates, invalidate, mutate, doc } = setup();
    const p = mutate({ a: 5 });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(doc()?.a).toBe(5);
    gates[0]?.reject(new Error('500'));
    await p;
    expect(doc()?.a).toBe(1);
    expect(invalidate).toHaveBeenCalled();
  });

  it('a failed save does not drop a later in-flight edit: the rollback waits for the last settle', async () => {
    const { gates, invalidate, mutate, doc } = setup();
    const first = mutate({ nested: { x: 2 } });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const second = mutate({ nested: { y: 3 } });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]?.reject(new Error('500'));
    await first;
    expect(doc()?.nested).toEqual({ x: 2, y: 3 });
    expect(invalidate).not.toHaveBeenCalled();
    gates[1]?.resolve();
    await second;
    expect(invalidate).toHaveBeenCalled();
  });
});
