import { describe, expect, it, vi } from 'vitest';
import type { EditorCommand } from '../src/editor/commands';
import { History } from '../src/editor/history';
import { PAGE_SELECTION, frameSelection, panelSelection } from '../src/editor/selection';
import {
  COVER_FRAME_KINDS, CHAPTER_FRAME_KINDS, autoLetterFlow, deletePageFlow, escapeSelection, exportTarget, frameInsert, insertBody, neighbourAfterDelete, nudgePatch, pageAfterRemoval, nudgeStep, pageToShow,
  removedPanelCount, resolveCurrentPage,
} from '../src/editor/editorModel';
import { makeFrame } from './fixtures';

describe('editor model', () => {
  it('reads the needs_confirm details', () => {
    expect(removedPanelCount({ removedPanelIds: ['pn_1', 'pn_2'] })).toBe(2);
    expect(removedPanelCount(undefined)).toBe(0);
    expect(removedPanelCount({ other: 1 })).toBe(0);
  });
  it('resolves the current page from the URL, falling back to the first', () => {
    expect(resolveCurrentPage(['a', 'b'], 'b')).toBe('b');
    expect(resolveCurrentPage(['a', 'b'], 'zz')).toBe('a');
    expect(resolveCurrentPage([], null)).toBeNull();
  });
  it('picks the neighbour after a delete', () => {
    expect(neighbourAfterDelete(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourAfterDelete(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbourAfterDelete(['a'], 'a')).toBeNull();
  });
  it('anchors new frames to the selected panel', () => {
    expect(frameInsert('speech', panelSelection('pn_1'))).toEqual({ kind: 'speech', panelId: 'pn_1' });
    expect(frameInsert('narration', PAGE_SELECTION)).toEqual({ kind: 'narration', panelId: null });
  });
  it('inserts new pages after the current one', () => {
    expect(insertBody(['a', 'b', 'c'], 'b')).toEqual({ index: 2 });
    expect(insertBody(['a'], null)).toEqual({});
  });
  it('limits the cover editor to title frames', () => {
    expect(CHAPTER_FRAME_KINDS).toEqual(['speech', 'thought', 'shout', 'narration', 'sfx']);
    expect(COVER_FRAME_KINDS).toEqual(['title']);
  });
});

describe('escape and export target', () => {
  it('leaves adjust mode first, then clears the selection', () => {
    expect(escapeSelection(panelSelection('pn_1', { adjust: true }))).toEqual(panelSelection('pn_1'));
    expect(escapeSelection(panelSelection('pn_1', { mergeWith: 'pn_2' }))).toEqual(PAGE_SELECTION);
    expect(escapeSelection(frameSelection('tf_1'))).toEqual(PAGE_SELECTION);
    expect(escapeSelection(PAGE_SELECTION)).toEqual(PAGE_SELECTION);
  });
  it('exports the chapter in the chapter editor and the page in the cover editor', () => {
    expect(exportTarget('ch_1', 'pg_1')).toEqual({ type: 'chapter', id: 'ch_1' });
    expect(exportTarget(null, 'pg_1')).toEqual({ type: 'page', id: 'pg_1' });
    expect(exportTarget(null, null)).toBeNull();
  });
});

describe('arrow-key nudges', () => {
  const size = { w: 1000, h: 500 };
  it('moves the box by screen pixels and carries the tail with it', () => {
    const frame = makeFrame('tf_1', 'pg_1', { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, tail: { x: 0.15, y: 0.4 } });
    const s = nudgeStep(null, frame, 10, -5, size);
    expect(s.frameId).toBe('tf_1');
    expect(s.before).toEqual({ box: frame.box, tail: frame.tail });
    expect(s.after.box.x).toBeCloseTo(0.11);
    expect(s.after.box.y).toBeCloseTo(0.09);
    expect(s.after.tail?.x).toBeCloseTo(0.16);
    expect(s.after.tail?.y).toBeCloseTo(0.39);
  });
  it('accumulates a burst on the same frame from the first position', () => {
    const frame = makeFrame('tf_1', 'pg_1', { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    const s1 = nudgeStep(null, frame, 1, 0, size);
    const s2 = nudgeStep(s1, frame, 1, 0, size);
    expect(s2.before.box).toEqual(frame.box);
    expect(s2.after.box.x).toBeCloseTo(0.102);
  });
  it('starts over for a different frame', () => {
    const a = makeFrame('tf_a', 'pg_1', { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    const b = makeFrame('tf_b', 'pg_1', { box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } });
    const s = nudgeStep(nudgeStep(null, a, 1, 0, size), b, 0, 10, size);
    expect(s.frameId).toBe('tf_b');
    expect(s.before.box).toEqual(b.box);
    expect(s.after.box.y).toBeCloseTo(0.52);
  });
  it('stays on the page', () => {
    const frame = makeFrame('tf_1', 'pg_1', { box: { x: 0.79, y: 0, w: 0.2, h: 0.2 } });
    expect(nudgeStep(null, frame, 100, -10, size).after.box).toMatchObject({ x: 0.8, y: 0 });
  });
  it('patches the tail only when the frame has one', () => {
    const plain = nudgeStep(null, makeFrame('tf_1'), 1, 0, size);
    expect(Object.keys(nudgePatch(plain).after)).toEqual(['box']);
    const tailed = nudgeStep(null, makeFrame('tf_2', 'pg_1', { tail: { x: 0.2, y: 0.4 } }), 1, 0, size);
    expect(nudgePatch(tailed).before).toEqual({ box: tailed.before.box, tail: { x: 0.2, y: 0.4 } });
    expect(Object.keys(nudgePatch(tailed).after)).toEqual(['box', 'tail']);
  });
});

describe('undo and redo show the command page', () => {
  it('switches to another page of the chapter, and stays put otherwise', () => {
    expect(pageToShow('pg_2', 'pg_1', ['pg_1', 'pg_2'])).toBe('pg_2');
    expect(pageToShow('pg_1', 'pg_1', ['pg_1', 'pg_2'])).toBeNull();
    expect(pageToShow(null, 'pg_1', ['pg_1'])).toBeNull();
    expect(pageToShow('pg_gone', 'pg_1', ['pg_1'])).toBeNull();
  });
});

describe('auto-letter', () => {
  const cmd = (log: string[]): EditorCommand => ({
    label: 'A', pageId: 'pg_1', apply: async () => { log.push('apply A'); }, revert: async () => { log.push('revert A'); },
  });

  it('flushes the nudge, runs the request as a barrier that clears the history, and toasts nothing', async () => {
    const log: string[] = [];
    const h = new History();
    await h.run(cmd(log));
    await autoLetterFlow('pg_1', {
      flush: () => log.push('flush'), barrier: (fn) => h.barrier(fn),
      run: async (id) => { log.push(`letter ${id}`); }, fail: (err) => log.push(`fail ${String(err)}`),
    });
    expect(log).toEqual(['apply A', 'flush', 'letter pg_1']);
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('a refused request is reported and keeps the history', async () => {
    const log: string[] = [];
    const h = new History();
    await h.run(cmd(log));
    const fail = vi.fn();
    await autoLetterFlow('pg_1', {
      flush: () => undefined, barrier: (fn) => h.barrier(fn),
      run: async () => { throw new Error('404'); }, fail,
    });
    expect(fail).toHaveBeenCalledOnce();
    expect(String(fail.mock.calls[0]?.[0])).toContain('404');
    expect(h.snapshot()).toMatchObject({ canUndo: true });
  });
});

describe('page delete', () => {
  const cmd = (label: string, log: string[], pageId: string): EditorCommand => ({
    label, pageId, apply: async () => { log.push(`apply ${label}`); }, revert: async () => { log.push(`revert ${label}`); },
  });

  it('flushes the nudge, waits for queued commands, deletes, clears the history, then cleans up', async () => {
    const log: string[] = [];
    const h = new History();
    await h.run(cmd('A', log, 'pg_2'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = h.run({ label: 'slow', pageId: 'pg_2', apply: async () => { await gate; log.push('apply slow'); }, revert: async () => undefined });
    const done = deletePageFlow('pg_2', {
      flush: () => log.push('flush'),
      barrier: (fn) => h.barrier(fn),
      view: () => ({ currentId: 'pg_1', pageIds: ['pg_1', 'pg_2'] }),
      remove: async (id) => { log.push(`delete ${id}`); },
      after: (id, show) => log.push(`after ${id} ${String(show)}`),
    });
    release();
    await Promise.all([slow, done]);
    expect(log).toEqual(['apply A', 'flush', 'apply slow', 'delete pg_2', 'after pg_2 undefined']);
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('a refused delete keeps the history and skips the cleanup', async () => {
    const log: string[] = [];
    const h = new History();
    await h.run(cmd('A', log, 'pg_2'));
    await expect(deletePageFlow('pg_2', {
      flush: () => undefined,
      barrier: (fn) => h.barrier(fn),
      view: () => ({ currentId: 'pg_2', pageIds: ['pg_1', 'pg_2'] }),
      remove: async () => { throw new Error('404'); },
      after: () => log.push('after'),
    })).rejects.toThrow('404');
    expect(log).toEqual(['apply A']);
    expect(h.snapshot()).toMatchObject({ canUndo: true, undoPageId: 'pg_2' });
  });

  // Fix round 2: the server's `page deleted` event can arrive (and trim the cached list, so the editor falls back to page 1)
  // before the DELETE response. The neighbour comes from the list as it was when the request was sent.
  it('shows the neighbour from the list as it was before the request, even when the event trimmed the list first', async () => {
    const state = { currentId: 'pg_2' as string | null, pageIds: ['pg_1', 'pg_2', 'pg_3'] };
    const shown: Array<string | null | undefined> = [];
    await deletePageFlow('pg_2', {
      flush: () => undefined,
      barrier: (fn) => fn(),
      view: () => ({ ...state }),
      remove: async () => {
        // The socket event lands first: the list loses the page and the editor falls back to the first page.
        state.pageIds = ['pg_1', 'pg_3'];
        state.currentId = 'pg_1';
      },
      after: (_id, show) => shown.push(show),
    });
    expect(shown).toEqual(['pg_3']);
  });

  it('deleting the last page shows the one before it; deleting the only page shows none', async () => {
    const run = async (pageIds: string[], id: string): Promise<string | null | undefined> => {
      let out: string | null | undefined;
      await deletePageFlow(id, { flush: () => undefined, barrier: (fn) => fn(), view: () => ({ currentId: id, pageIds }), remove: async () => undefined, after: (_i, show) => { out = show; } });
      return out;
    };
    expect(await run(['pg_1', 'pg_2'], 'pg_2')).toBe('pg_1');
    expect(await run(['pg_1'], 'pg_1')).toBeNull();
  });

  it('moves the URL off a page that left the list elsewhere (an episode re-run, another tab)', () => {
    expect(pageAfterRemoval(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
    expect(pageAfterRemoval(['a', 'b', 'c'], ['a'], 'b')).toBe('a');
    expect(pageAfterRemoval(['a', 'b'], [], 'a')).toBeNull();
    expect(pageAfterRemoval(['a', 'b'], ['x'], 'a')).toBe('x');
    expect(pageAfterRemoval(['a', 'b'], ['a'], 'a')).toBeUndefined(); // still there
    expect(pageAfterRemoval(['a'], ['a', 'n'], 'n')).toBeUndefined(); // a new page not listed yet before
    expect(pageAfterRemoval(['a', 'b'], ['a'], null)).toBeUndefined();
  });
});
