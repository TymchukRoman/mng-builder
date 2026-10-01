import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Job, Page } from '@manga/shared';
import { JobWaiters, applyServerEvent, toastsFailure, eventsUrl, nextBackoff, parseEvent, upsertJob } from '../src/events';
import { fetchableId, qk } from '../src/queryKeys';
import { makeDetail, makeJob, makeManga } from './fixtures';

describe('socket helpers', () => {
  it('builds ws and wss URLs from the page location', () => {
    expect(eventsUrl({ protocol: 'http:', host: '127.0.0.1:5173' })).toBe('ws://127.0.0.1:5173/api/events');
    expect(eventsUrl({ protocol: 'https:', host: 'x' })).toBe('wss://x/api/events');
  });
  it('backoff grows and caps at 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(nextBackoff)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
  it('parses only known event shapes', () => {
    expect(parseEvent('{"type":"hello","serverTime":"t"}')).toEqual({ type: 'hello', serverTime: 't' });
    expect(parseEvent('{"type":"nope"}')).toBeNull();
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent(42)).toBeNull();
  });
  it('upserts jobs newest first and in place', () => {
    const a = makeJob({ id: 'a' });
    const b = makeJob({ id: 'b' });
    expect(upsertJob([a], b).map((j) => j.id)).toEqual(['b', 'a']);
    const a2 = makeJob({ id: 'a', status: 'running' });
    expect(upsertJob([b, a], a2)).toEqual([b, a2]);
    expect(upsertJob([a, b], makeJob({ id: 'c' }), 2).map((j) => j.id)).toEqual(['c', 'a']);
    expect(upsertJob(undefined, a)).toEqual([a]);
  });
});

describe('JobWaiters', () => {
  it('resolves on a terminal job event, not on progress', async () => {
    const w = new JobWaiters();
    const p = w.wait('jb_1', async () => makeJob({ id: 'jb_1', status: 'running' }));
    await Promise.resolve();
    w.notify(makeJob({ id: 'jb_1', status: 'running' }));
    expect(w.pending()).toEqual(['jb_1']);
    w.notify(makeJob({ id: 'jb_1', status: 'succeeded', result: { imageId: 'im_1' } }));
    await expect(p).resolves.toMatchObject({ status: 'succeeded', result: { imageId: 'im_1' } });
    expect(w.pending()).toEqual([]);
  });
  it('resolves immediately when the job already finished before we subscribed', async () => {
    const w = new JobWaiters();
    await expect(w.wait('jb_2', async () => makeJob({ id: 'jb_2', status: 'failed', error: 'x' }))).resolves.toMatchObject({ status: 'failed' });
  });
  it('rechecks pending waiters after reconnect', async () => {
    const w = new JobWaiters();
    const p = w.wait('jb_3', async () => makeJob({ id: 'jb_3', status: 'running' }));
    await Promise.resolve();
    w.recheck(async (id) => makeJob({ id, status: 'cancelled' }));
    await expect(p).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('rejects when the job cannot be fetched', async () => {
    const w = new JobWaiters();
    await expect(w.wait('jb_4', async () => { throw new Error('404'); })).rejects.toThrow('404');
  });
});

describe('applyServerEvent', () => {
  const deps = () => ({
    waiters: new JobWaiters(),
    fetchJob: vi.fn(async (id: string) => makeJob({ id })),
    onJobFailed: vi.fn(),
    reported: new Set<string>(),
    helloSeen: { value: false },
    deletedIds: new Set<string>(),
  });

  it('upserts jobs into the jobs cache and reports failures once', () => {
    const qc = new QueryClient();
    const d = deps();
    qc.setQueryData<Job[]>(qk.jobs(), []);
    const failed = makeJob({ id: 'jb_9', status: 'failed', error: 'boom' });
    applyServerEvent(qc, { type: 'job', job: failed }, d);
    applyServerEvent(qc, { type: 'job', job: failed }, d);
    expect(qc.getQueryData<Job[]>(qk.jobs())?.map((j) => j.id)).toEqual(['jb_9']);
    expect(d.onJobFailed).toHaveBeenCalledTimes(1);
  });
  it('invalidates only the page that owns an updated panel', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.page('pg_1'), makeDetail('pg_1'));
    qc.setQueryData(qk.page('pg_2'), { ...makeDetail('pg_2'), panels: [] });
    applyServerEvent(qc, { type: 'entity', entity: 'panel', id: 'pn_a', op: 'updated', mangaId: 'mg_1' }, deps());
    expect(qc.getQueryState(qk.page('pg_1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.page('pg_2'))?.isInvalidated).toBe(false);
  });
  // preflight F5b: a `deleted` entity event must not invalidate (and thus 404-refetch) the entity's
  // own detail query; it should be dropped outright, while unrelated caches and the list keys are
  // handled normally.
  it('removes a deleted entity\'s own detail query and invalidates its lists, without touching unrelated caches', () => {
    const qc = new QueryClient();
    const d = deps();
    qc.setQueryData(qk.manga('mg_1'), makeManga());
    qc.setQueryData(qk.mangas(), [makeManga()]);
    qc.setQueryData(qk.manga('mg_2'), makeManga({ id: 'mg_2' }));
    applyServerEvent(qc, { type: 'entity', entity: 'manga', id: 'mg_1', op: 'deleted', mangaId: 'mg_1' }, d);
    expect(qc.getQueryData(qk.manga('mg_1'))).toBeUndefined();
    expect(qc.getQueryState(qk.mangas())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.manga('mg_2'))?.isInvalidated).toBe(false);
  });
  // Task 18 review finding 10: a page cascade (page delete, chapter delete, an episode re-run) emits `panel deleted` for each
  // panel before `page deleted`. Invalidating the owning page per panel refetched a page the cascade was deleting (404s).
  it('a deleted panel removes its own images query and leaves its page to the page event', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.page('pg_1'), makeDetail('pg_1'));
    qc.setQueryData(qk.panelImages('pn_a'), []);
    qc.setQueryData(qk.panelImages('pn_b'), []);
    applyServerEvent(qc, { type: 'entity', entity: 'panel', id: 'pn_a', op: 'deleted', mangaId: 'mg_1' }, deps());
    expect(qc.getQueryState(qk.page('pg_1'))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['page'])).toBeUndefined();
    expect(qc.getQueryData(qk.panelImages('pn_a'))).toBeUndefined();
    expect(qc.getQueryState(qk.panelImages('pn_b'))?.isInvalidated).toBe(false);
    qc.setQueryData(qk.pages('ch_1'), [makeDetail('pg_1').page, makeDetail('pg_2').page]);
    applyServerEvent(qc, { type: 'entity', entity: 'page', id: 'pg_1', op: 'deleted', mangaId: 'mg_1' }, deps());
    expect(qc.getQueryData(qk.page('pg_1'))).toBeUndefined();
    // The page leaves the chapter's list at once, so the editor moves on before anything refetches it (then the list is refetched).
    expect(qc.getQueryData<Page[]>(qk.pages('ch_1'))?.map((p) => p.id)).toEqual(['pg_2']);
    expect(qc.getQueryState(qk.pages('ch_1'))?.isInvalidated).toBe(true);
  });
  it('a deleted panel or page can no longer fetch, even if a view still shows it (residual N2)', () => {
    const qc = new QueryClient();
    const deleted = new Set<string>();
    expect(fetchableId('pn_a', deleted)).toBe(true);
    applyServerEvent(qc, { type: 'entity', entity: 'panel', id: 'pn_a', op: 'deleted', mangaId: 'mg_1' }, { ...deps(), deletedIds: deleted });
    applyServerEvent(qc, { type: 'entity', entity: 'page', id: 'pg_1', op: 'deleted', mangaId: 'mg_1' }, { ...deps(), deletedIds: deleted });
    applyServerEvent(qc, { type: 'entity', entity: 'panel', id: 'pn_b', op: 'updated', mangaId: 'mg_1' }, { ...deps(), deletedIds: deleted });
    expect(fetchableId('pn_a', deleted)).toBe(false);
    expect(fetchableId('pg_1', deleted)).toBe(false);
    expect(fetchableId('pn_b', deleted)).toBe(true);
    expect(fetchableId(null, deleted)).toBe(false);
    // A re-created observer (the inspector re-rendering between `panel deleted` and `page deleted`) stays idle
    const fetch = vi.fn(async () => []);
    const observer = new QueryObserver(qc, { queryKey: qk.panelImages('pn_a'), queryFn: fetch, enabled: fetchableId('pn_a', deleted) });
    const stop = observer.subscribe(() => undefined);
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });
  // preflight F5c: the first `hello` of a session must not trigger a full resync (everything was
  // just fetched); only a later `hello` (a reconnect) should.
  it('stores status, and re-syncs everything starting on the second hello, not the first', () => {
    const qc = new QueryClient();
    const d = deps();
    qc.setQueryData(qk.mangas(), []);
    const status = { claude: { ok: true, detail: '' }, ollama: { ok: false, detail: 'down' }, comfy: { ok: true, detail: '' }, queue: { queued: 0, running: 0, pausedLanes: [] } };
    applyServerEvent(qc, { type: 'status', status }, d);
    expect(qc.getQueryData(qk.status())).toEqual(status);
    applyServerEvent(qc, { type: 'hello', serverTime: 't1' }, d);
    expect(qc.getQueryState(qk.mangas())?.isInvalidated).toBe(false);
    applyServerEvent(qc, { type: 'hello', serverTime: 't2' }, d);
    expect(qc.getQueryState(qk.mangas())?.isInvalidated).toBe(true);
  });
  // M6: a UI that loaded before the server (npm run dev) has failed queries; the first hello refetches only those.
  it('the first hello refetches the queries that failed, and leaves the fresh ones alone', async () => {
    const qc = new QueryClient();
    const d = deps();
    let up = false;
    let mangaFetches = 0;
    const failing = new QueryObserver(qc, { queryKey: qk.settings(), retry: false, queryFn: async () => { if (!up) throw new Error('Server not reachable'); return { ok: true }; } });
    const fresh = new QueryObserver(qc, { queryKey: qk.mangas(), queryFn: async () => { mangaFetches += 1; return []; } });
    const stop = [failing.subscribe(() => undefined), fresh.subscribe(() => undefined)];
    await vi.waitFor(() => expect(qc.getQueryState(qk.settings())?.status).toBe('error'));
    await vi.waitFor(() => expect(mangaFetches).toBe(1));
    up = true;
    applyServerEvent(qc, { type: 'hello', serverTime: 't1' }, d);
    await vi.waitFor(() => expect(qc.getQueryData(qk.settings())).toEqual({ ok: true }));
    expect(mangaFetches).toBe(1);
    for (const s of stop) s();
  });
});

describe('failure toasts (W1 F21)', () => {
  it('skips a failed chapter summary: it never fails its run', () => {
    expect(toastsFailure(makeJob({ kind: 'llm.step', payload: { type: 'chapter-summary', chapterId: 'ch_1', runId: 'er_1' } }))).toBe(false);
    expect(toastsFailure(makeJob({ kind: 'llm.step', payload: { type: 'story', runId: 'er_1' } as never }))).toBe(true);
    expect(toastsFailure(makeJob())).toBe(true);
  });

  it('does not throw on an llm.step whose payload is null or not an object (Task 9 minor 1)', () => {
    expect(toastsFailure(makeJob({ kind: 'llm.step', payload: null }))).toBe(true);
    expect(toastsFailure(makeJob({ kind: 'llm.step', payload: 'chapter-summary' as never }))).toBe(true);
  });
});
