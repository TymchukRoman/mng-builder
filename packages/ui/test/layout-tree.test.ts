import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, PRESET_NAMES, buildPreset, computeRects, mirrorLayout, presetPanelCount, type LayoutNode } from '@manga/shared';
import { areSiblings, mergeState, newPanelId, pathKey, presetState, ratioFromPointer, splitState } from '../src/editor/layoutTree';
import { presetRects } from '../src/editor/presets';
import { PAGE_SELECTION, clickPanel, frameSelection, panelSelection, reconcileSelection, selectedPanelId } from '../src/editor/selection';
import { makeDetail, makeFrame } from './fixtures';

// (a | (b over c)) : a and the (b,c) group are siblings; b and c are siblings; a and b are not.
const tree: LayoutNode = {
  type: 'split', dir: 'v', ratio: 0.5,
  a: { type: 'panel', id: 'pn_a' },
  b: { type: 'split', dir: 'h', ratio: 0.5, a: { type: 'panel', id: 'pn_b' }, b: { type: 'panel', id: 'pn_c' } },
};

describe('layout tree helpers', () => {
  it('detects sibling leaves in either order', () => {
    expect(areSiblings(tree, 'pn_b', 'pn_c')).toBe(true);
    expect(areSiblings(tree, 'pn_c', 'pn_b')).toBe(true);
    expect(areSiblings(tree, 'pn_a', 'pn_b')).toBe(false);
    expect(areSiblings({ type: 'panel', id: 'pn_a' }, 'pn_a', 'pn_a')).toBe(false);
  });
  it('treats unknown panels as not siblings instead of throwing', () => {
    expect(areSiblings(tree, 'pn_b', 'pn_gone')).toBe(false);
    expect(areSiblings(tree, 'pn_b', 'pn_b')).toBe(false);
  });
  it('explains why merge is enabled or not', () => {
    expect(mergeState(tree, PAGE_SELECTION)).toEqual({ enabled: false, reason: 'Merge: select a panel, then shift-click its neighbour' });
    expect(mergeState(tree, panelSelection('pn_a', { mergeWith: 'pn_b' }))).toEqual({ enabled: false, reason: 'Merge: only two panels from the same split can merge' });
    expect(mergeState(tree, panelSelection('pn_b', { mergeWith: 'pn_c' }))).toEqual({ enabled: true, reason: 'Merge panels (cannot be undone)' });
    expect(splitState(PAGE_SELECTION).enabled).toBe(false);
    expect(splitState(panelSelection('pn_a')).enabled).toBe(true);
  });
  it('disables split, merge and preset on cover pages', () => {
    const locked = { enabled: false, reason: 'Not available on a cover page' };
    expect(splitState(panelSelection('pn_a'), 'cover')).toEqual(locked);
    expect(mergeState(tree, panelSelection('pn_b', { mergeWith: 'pn_c' }), 'cover')).toEqual(locked);
    expect(presetState('cover')).toEqual(locked);
    expect(presetState('page').enabled).toBe(true);
    expect(splitState(panelSelection('pn_a'), 'page').enabled).toBe(true);
  });
  it('computes and clamps the ratio from the pointer', () => {
    const parent = { x: 0.1, y: 0.2, w: 0.8, h: 0.6 };
    expect(ratioFromPointer({ dir: 'v', parent }, { x: 0.5, y: 0 })).toBeCloseTo(0.5, 9);
    expect(ratioFromPointer({ dir: 'h', parent }, { x: 0, y: 0.35 })).toBeCloseTo(0.25, 9);
    expect(ratioFromPointer({ dir: 'v', parent }, { x: -1, y: 0 })).toBe(0.08);
    expect(ratioFromPointer({ dir: 'h', parent }, { x: 0, y: 5 })).toBe(0.92);
  });
  it('falls back to the minimum ratio for a zero-size parent', () => {
    const flat = { x: 0.5, y: 0.5, w: 0, h: 0 };
    expect(ratioFromPointer({ dir: 'v', parent: flat }, { x: 0.5, y: 0.5 })).toBe(0.08);
    expect(ratioFromPointer({ dir: 'h', parent: flat }, { x: 0.5, y: 0.5 })).toBe(0.08);
  });
  it('names paths and finds the panel a split created', () => {
    expect(pathKey([])).toBe('root');
    expect(pathKey(['b', 'a'])).toBe('ba');
    const after: LayoutNode = { ...tree, a: { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_new' } } };
    expect(newPanelId(tree, after)).toBe('pn_new');
    expect(newPanelId(tree, tree)).toBeNull();
  });
});

describe('preset previews', () => {
  it('builds one rect per preset panel', () => {
    for (const name of PRESET_NAMES) expect(presetRects(name, 'ltr', DEFAULT_PAGE_FORMAT)).toHaveLength(presetPanelCount(name));
  });
  it('previews RTL as the mirror of the LTR tree, not the LTR rects', () => {
    let differs = 0;
    for (const name of PRESET_NAMES) {
      let n = 0;
      const ltr = buildPreset(name, 'ltr', () => `pv${n++}`);
      const mirrored = computeRects(mirrorLayout(ltr), DEFAULT_PAGE_FORMAT).map((r) => r.rect);
      const rtl = presetRects(name, 'rtl', DEFAULT_PAGE_FORMAT);
      expect(rtl).toEqual(mirrored);
      if (JSON.stringify(rtl) !== JSON.stringify(presetRects(name, 'ltr', DEFAULT_PAGE_FORMAT))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });
});

describe('selection', () => {
  it('shift-click on a second panel records the merge partner', () => {
    const a = clickPanel(PAGE_SELECTION, 'pn_a', false);
    expect(a).toEqual({ kind: 'panel', panelId: 'pn_a', mergeWith: null, adjust: false });
    expect(clickPanel(a, 'pn_b', true)).toEqual({ kind: 'panel', panelId: 'pn_a', mergeWith: 'pn_b', adjust: false });
    expect(clickPanel(a, 'pn_b', false)).toEqual({ kind: 'panel', panelId: 'pn_b', mergeWith: null, adjust: false });
    expect(clickPanel(PAGE_SELECTION, 'pn_b', true)).toEqual({ kind: 'panel', panelId: 'pn_b', mergeWith: null, adjust: false });
  });
  it('re-clicking the selected panel keeps adjust mode', () => {
    const s = panelSelection('pn_a', { adjust: true });
    expect(clickPanel(s, 'pn_a', false)).toEqual(s);
  });
  it('drops selections that no longer exist on the page', () => {
    const detail = makeDetail('pg_1', [makeFrame('tf_1')]);
    expect(reconcileSelection(panelSelection('pn_gone'), detail)).toEqual(PAGE_SELECTION);
    expect(reconcileSelection(panelSelection('pn_a', { mergeWith: 'pn_gone' }), detail)).toEqual(panelSelection('pn_a'));
    expect(reconcileSelection(frameSelection('tf_1'), detail)).toEqual(frameSelection('tf_1'));
    expect(reconcileSelection(frameSelection('tf_x'), detail)).toEqual(PAGE_SELECTION);
    expect(selectedPanelId(panelSelection('pn_a'))).toBe('pn_a');
    expect(selectedPanelId(frameSelection('tf_1'))).toBeNull();
  });
});
