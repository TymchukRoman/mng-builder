import { describe, expect, it } from 'vitest';
import { EMPTY_SCRIPT, FrameKindSchema, type LayoutNode, type RecipeInfo } from '@manga/shared';
import { FRAME_KIND_ICON, FRAME_KIND_LABEL } from '../src/editor/frameKinds';
import { panelJobs, panelNumbers, recipeChoices, reviewSummary, scriptSaveable, toggleId, visibleVariants } from '../src/inspector/inspectorModel';
import { makeImage, makeJob } from './fixtures';

const recipe = (id: string): RecipeInfo => ({
  id, label: id.toUpperCase(), maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
});

describe('inspector model', () => {
  it('refuses to save a script with an empty dialogue line', () => {
    expect(scriptSaveable(EMPTY_SCRIPT)).toBe(true);
    expect(scriptSaveable({ ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'speech', text: '  ' }] })).toBe(false);
    expect(scriptSaveable({ ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'speech', text: 'Hi' }] })).toBe(true);
  });

  it('numbers panels in reading order', () => {
    const tree: LayoutNode = { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_l' }, b: { type: 'panel', id: 'pn_r' } };
    expect([...panelNumbers(tree, 'rtl')]).toEqual([['pn_r', 1], ['pn_l', 2]]);
    expect([...panelNumbers(tree, 'ltr')]).toEqual([['pn_l', 1], ['pn_r', 2]]);
  });

  it('toggles ids', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('summarises a review', () => {
    expect(reviewSummary({ engine: 'claude', pass: true, issues: [], at: '' })).toBe('Review passed');
    expect(reviewSummary({ engine: 'local', pass: false, issues: [{ kind: 'anatomy', note: 'six fingers' }, { kind: 'text', note: 'stray letters' }], at: '' }))
      .toBe('Review flagged: anatomy (six fingers); text (stray letters)');
  });

  it('shows generated and uploaded variants newest first, hiding upscale caches', () => {
    const images = [
      makeImage('im_1', { createdAt: '2026-09-01T00:00:00Z' }),
      makeImage('im_2', { createdAt: '2026-09-03T00:00:00Z', source: 'upscaled', parentImageId: 'im_1' }),
      makeImage('im_3', { createdAt: '2026-09-02T00:00:00Z', source: 'uploaded' }),
    ];
    expect(visibleVariants(images).map((i) => i.id)).toEqual(['im_3', 'im_1']);
  });

  it('splits the unfinished jobs of one panel into image jobs and the AI prompt job', () => {
    const jobs = [
      makeJob({ id: 'jb_gen', status: 'running' }),
      makeJob({ id: 'jb_rev', kind: 'image.review', payload: { imageId: 'im_1', panelId: 'pn_1' } }),
      makeJob({ id: 'jb_txt', kind: 'llm.step', payload: { type: 'panel-prompt', panelId: 'pn_1' } }),
      makeJob({ id: 'jb_other', payload: { target: 'panel', panelId: 'pn_2' } }),
      makeJob({ id: 'jb_done', status: 'succeeded' }),
      makeJob({ id: 'jb_appearance', kind: 'llm.step', payload: { type: 'appearance', characterId: 'ch_1', description: 'x' } }),
    ];
    const { image, prompt } = panelJobs(jobs, 'pn_1');
    expect(image.map((j) => j.id)).toEqual(['jb_gen', 'jb_rev']);
    expect(prompt?.id).toBe('jb_txt');
    expect(panelJobs(undefined, 'pn_1')).toEqual({ image: [], prompt: undefined });
  });

  it('keeps a stored recipe selectable even when it is no longer offered', () => {
    expect(recipeChoices([recipe('anime')], null)).toEqual([{ id: 'anime', label: 'ANIME' }]);
    expect(recipeChoices([recipe('anime')], 'anime').map((r) => r.id)).toEqual(['anime']);
    expect(recipeChoices([recipe('anime')], 'gone').map((r) => r.id)).toEqual(['anime', 'gone']);
  });

  it('has an icon and a label for every frame kind', () => {
    for (const kind of FrameKindSchema.options) {
      expect(FRAME_KIND_ICON[kind]).toBeDefined();
      expect(FRAME_KIND_LABEL[kind]).not.toBe('');
    }
  });
});
