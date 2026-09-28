import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSFORM, type LayoutNode, type PageDetail, type Panel, type TextFrame } from '@manga/shared';
import { queryCache } from '../src/editor/cacheAdapter';
import { IdMap } from '../src/editor/history';
import { createOps, type OpsApi } from '../src/editor/ops';
import { qk } from '../src/queryKeys';
import { makeDetail, makeFrame, makePanel } from './fixtures';

type Handler = (body: unknown) => unknown;
type SplitNode = Extract<LayoutNode, { type: 'split' }>;

function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const handle = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    const fn = Array.isArray(r) ? r.shift() : r;
    if (!fn) throw new Error(`unexpected ${method} ${path}`);
    return fn(body);
  };
  const api: OpsApi = {
    get: <T,>(p: string) => handle('GET', p) as Promise<T>,
    post: <T,>(p: string, b?: unknown) => handle('POST', p, b) as Promise<T>,
    patch: <T,>(p: string, b: unknown) => handle('PATCH', p, b) as Promise<T>,
    delete: <T,>(p: string) => handle('DELETE', p) as Promise<T>,
  };
  return { api, calls };
}

const base = (): PageDetail => makeDetail('pg_1', [makeFrame('tf_1')]);
const withRatio = (ratio: number): PageDetail => {
  const d = base();
  return { ...d, page: { ...d.page, layout: { ...(d.page.layout as SplitNode), ratio } } };
};
const splitDetail = (newId: string): PageDetail => {
  const d = base();
  const layout: LayoutNode = {
    type: 'split', dir: 'v', ratio: 0.5,
    a: { type: 'split', dir: 'h', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: newId } },
    b: { type: 'panel', id: 'pn_b' },
  };
  return { ...d, page: { ...d.page, layout }, panels: [...d.panels, makePanel(newId)] };
};

function setup(routes: Record<string, Handler | Handler[]>, initial: PageDetail = base()) {
  const qc = new QueryClient();
  qc.setQueryData(qk.page('pg_1'), initial);
  const ids = new IdMap();
  const { api, calls } = fakeApi(routes);
  const ops = createOps({ api, ids, cache: queryCache(qc) });
  const page = (): PageDetail => qc.getQueryData<PageDetail>(qk.page('pg_1')) as PageDetail;
  const ratio = (): number => (page().page.layout as SplitNode).ratio;
  return { ids, calls, ops, page, ratio };
}

describe('editor ops', () => {
  it('resize is optimistic and reverts to the old ratio', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { ops, calls, ratio } = setup({
      'POST /api/pages/pg_1/layout/resize': [
        async (b) => { await gate; return withRatio((b as { ratio: number }).ratio); },
        (b) => withRatio((b as { ratio: number }).ratio),
      ],
    });
    const cmd = ops.resize('pg_1', [], 0.5, 0.7);
    const applying = cmd.apply();
    await vi.waitFor(() => expect(ratio()).toBe(0.7));
    open();
    await applying;
    await cmd.revert();
    expect(calls.map((c) => c.body)).toEqual([{ path: [], ratio: 0.7 }, { path: [], ratio: 0.5 }]);
    expect(ratio()).toBe(0.5);
  });

  it('rolls an optimistic resize back when the server refuses', async () => {
    const { ops, ratio } = setup({ 'POST /api/pages/pg_1/layout/resize': () => { throw new Error('400'); } });
    await expect(ops.resize('pg_1', [], 0.5, 0.8).apply()).rejects.toThrow('400');
    expect(ratio()).toBe(0.5);
  });

  it('split reverts through merge, and redo remaps the recreated panel id', async () => {
    const { ops, calls, ids, page } = setup({
      'POST /api/pages/pg_1/layout/split': [() => splitDetail('pn_n1'), () => splitDetail('pn_n2')],
      'POST /api/pages/pg_1/layout/merge': [() => base(), () => base()],
    });
    const cmd = ops.split('pg_1', 'pn_a', 'h');
    await cmd.apply();
    expect(page().panels.map((p) => p.id)).toContain('pn_n1');
    expect(calls[0]?.body).toEqual({ panelId: 'pn_a', dir: 'h' });
    await cmd.revert();
    expect(calls[1]).toEqual({ method: 'POST', path: '/api/pages/pg_1/layout/merge', body: { panelIdA: 'pn_a', panelIdB: 'pn_n1' } });
    await cmd.apply();
    expect(ids.resolve('pn_n1')).toBe('pn_n2');
    await cmd.revert();
    expect(calls[3]?.body).toEqual({ panelIdA: 'pn_a', panelIdB: 'pn_n2' });
  });

  it('addFrame deletes on revert and re-creates the same frame on redo', async () => {
    const created = makeFrame('tf_new', 'pg_1', { panelId: 'pn_a', text: '', box: { x: 0.3, y: 0.3, w: 0.3, h: 0.12 } });
    const { ops, calls, ids, page } = setup({
      'POST /api/pages/pg_1/frames': [() => created, () => ({ ...created, id: 'tf_new2' })],
      'DELETE /api/frames/tf_new': () => ({ ok: true }),
    });
    const cmd = ops.addFrame('pg_1', { kind: 'speech', panelId: 'pn_a' });
    await cmd.apply();
    expect(cmd.createdId).toBe('tf_new');
    expect(calls[0]?.body).toEqual({ kind: 'speech', panelId: 'pn_a' });
    expect(page().frames.map((f) => f.id)).toEqual(['tf_1', 'tf_new']);
    await cmd.revert();
    expect(page().frames.map((f) => f.id)).toEqual(['tf_1']);
    await cmd.apply();
    expect(calls[2]?.body).toEqual({
      kind: 'speech', text: '', panelId: 'pn_a', speakerId: null, box: { x: 0.3, y: 0.3, w: 0.3, h: 0.12 },
      tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center',
    });
    expect(ids.resolve('tf_new')).toBe('tf_new2');
    expect(cmd.createdId).toBe('tf_new2');
  });

  it('deleteFrame restores the frame and later commands follow its new id', async () => {
    const { ops, calls, ids, page } = setup({
      'DELETE /api/frames/tf_1': () => ({ ok: true }),
      'POST /api/pages/pg_1/frames': () => makeFrame('tf_back', 'pg_1', { order: 3 }),
      'PATCH /api/frames/tf_back': [
        (b) => makeFrame('tf_back', 'pg_1', b as Partial<TextFrame>),
        (b) => makeFrame('tf_back', 'pg_1', b as Partial<TextFrame>),
      ],
    });
    const original = page().frames[0]!;
    const del = ops.deleteFrame(original);
    const edit = ops.updateFrame('pg_1', 'tf_1', { text: 'Hi' }, { text: 'Bye' });
    await del.apply();
    expect(page().frames).toEqual([]);
    await del.revert();
    expect(calls[2]).toEqual({ method: 'PATCH', path: '/api/frames/tf_back', body: { order: 0 } });
    expect(ids.resolve('tf_1')).toBe('tf_back');
    expect(page().frames.map((f) => f.id)).toEqual(['tf_back']);
    await edit.apply();
    expect(calls[3]).toEqual({ method: 'PATCH', path: '/api/frames/tf_back', body: { text: 'Bye' } });
  });

  it('a restored frame slots back by its order, and a frame patch follows a remapped panel', async () => {
    const two = makeDetail('pg_1', [makeFrame('tf_1', 'pg_1', { order: 0 }), makeFrame('tf_2', 'pg_1', { order: 1 })]);
    const { ops, calls, ids, page } = setup({
      'DELETE /api/frames/tf_1': () => ({ ok: true }),
      'POST /api/pages/pg_1/frames': () => makeFrame('tf_back', 'pg_1', { order: 2 }),
      'PATCH /api/frames/tf_back': (b) => makeFrame('tf_back', 'pg_1', b as Partial<TextFrame>),
      'PATCH /api/frames/tf_2': (b) => makeFrame('tf_2', 'pg_1', { order: 1, ...(b as Partial<TextFrame>) }),
    }, two);
    const del = ops.deleteFrame(two.frames[0]!);
    await del.apply();
    await del.revert();
    expect(page().frames.map((f) => f.id)).toEqual(['tf_back', 'tf_2']);
    ids.set('pn_old', 'pn_a');
    await ops.updateFrame('pg_1', 'tf_2', {}, { panelId: 'pn_old' }).apply();
    expect(calls.at(-1)?.body).toEqual({ panelId: 'pn_a' });
  });

  it('updateFrame is optimistic and rolls back on failure', async () => {
    const { ops, page } = setup({ 'PATCH /api/frames/tf_1': () => { throw new Error('500'); } });
    await expect(ops.updateFrame('pg_1', 'tf_1', { text: 'Hi' }, { text: 'Bye' }).apply()).rejects.toThrow('500');
    expect(page().frames[0]?.text).toBe('Hi');
  });

  it('transform patches the panel; activeImage patches then reloads the page', async () => {
    const moved = { x: 0.1, y: 0, scale: 1.5 };
    const { ops, calls, page } = setup({
      'PATCH /api/panels/pn_a': [
        (b) => makePanel('pn_a', 'pg_1', b as Partial<Panel>),
        (b) => makePanel('pn_a', 'pg_1', b as Partial<Panel>),
        (b) => makePanel('pn_a', 'pg_1', b as Partial<Panel>),
      ],
      'GET /api/pages/pg_1': () => base(),
    });
    const t = ops.transform('pg_1', 'pn_a', DEFAULT_TRANSFORM, moved);
    await t.apply();
    expect(page().panels[0]?.imageTransform).toEqual(moved);
    await t.revert();
    expect(calls.map((c) => c.body)).toEqual([{ imageTransform: moved }, { imageTransform: DEFAULT_TRANSFORM }]);
    await ops.activeImage('pg_1', 'pn_a', null, 'im_2').apply();
    expect(calls.slice(-2).map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /api/panels/pn_a', 'GET /api/pages/pg_1']);
    expect(calls.at(-2)?.body).toEqual({ activeImageId: 'im_2' });
  });

  it('merge and preset helpers resolve ids and store the result', async () => {
    const { ops, calls, ids } = setup({
      'POST /api/pages/pg_1/layout/merge': () => base(),
      'POST /api/pages/pg_1/layout/preset': () => base(),
    });
    ids.set('pn_old', 'pn_a');
    await ops.merge('pg_1', 'pn_old', 'pn_b');
    await ops.applyPreset('pg_1', '3-rows', true);
    expect(calls.map((c) => c.body)).toEqual([{ panelIdA: 'pn_a', panelIdB: 'pn_b' }, { preset: '3-rows', confirm: true }]);
  });
});
