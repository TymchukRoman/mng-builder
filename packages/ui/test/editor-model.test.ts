import { describe, expect, it } from 'vitest';
import { PAGE_SELECTION, frameSelection, panelSelection } from '../src/editor/selection';
import {
  COVER_FRAME_KINDS, CHAPTER_FRAME_KINDS, escapeSelection, exportTarget, frameInsert, insertBody, neighbourAfterDelete, nudgePatch, nudgeStep,
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
