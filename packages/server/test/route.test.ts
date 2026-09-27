import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_FORMAT, DEFAULT_SETTINGS, DEFAULT_TRANSFORM, EMPTY_SCRIPT, STYLE_PRESETS,
  type LayoutNode, type Manga, type Page, type Panel, type Settings,
} from '@manga/shared';
import { promptStyleFor, refineFor, routeRecipe } from '../src/imaging/route.js';
import { PORTRAIT_SIZE, panelAspect, panelSize } from '../src/imaging/size.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { PermanentError } from '../src/jobs/index.js';

const STAMP = '2026-09-27T00:00:00.000Z';
const manga = (colorMode: 'bw' | 'color', recipe = 'anime'): Manga => ({
  id: 'mg_route00001', title: 'Route', synopsis: '', language: 'en', colorMode, readingDirection: 'rtl', pageFormat: DEFAULT_PAGE_FORMAT,
  styleGuide: { ...STYLE_PRESETS['manga-bw']!.styleGuide, recipe }, coverPageId: null, createdAt: STAMP, updatedAt: STAMP,
});
const panel = (recipe: string | null = null): Panel => ({
  id: 'pn_route00001', pageId: 'pg_route00001', script: EMPTY_SCRIPT, prompt: { scene: '', negative: '' }, recipe, seedLock: false, seed: 1,
  refCharacterIds: [], activeImageId: null, imageTransform: DEFAULT_TRANSFORM, createdAt: STAMP, updatedAt: STAMP,
});
const custom: Settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, multiChar: 'klein-ref', bwRefine: null } };
const withRefine: Settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, bwRefine: 'anime-refine' } };

describe('routeRecipe', () => {
  const cases: Array<[string, Parameters<typeof routeRecipe>[0], ReturnType<typeof routeRecipe>]> = [
    ['no characters → noChars', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 0, charCount: 0 }, { recipe: 'anime', refineWith: null }],
    ['characters without refs → prompt-only', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 0, charCount: 2 }, { recipe: 'anime', refineWith: null }],
    ['an Anima manga keeps its engine for prompt-only panels', { settings: DEFAULT_SETTINGS, manga: manga('bw', 'anima'), panel: panel(), refCount: 0, charCount: 1 }, { recipe: 'anima', refineWith: null }],
    ['one character with refs → oneChar', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 1, charCount: 1 }, { recipe: 'anime-ref', refineWith: null }],
    ['two characters with refs, B&W → multiChar without refine (default)', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 2, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: null }],
    ['two characters with refs, colour → no refine', { settings: DEFAULT_SETTINGS, manga: manga('color'), panel: panel(), refCount: 2, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: null }],
    ['one of two characters has refs → multiChar without refine (default)', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 1, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: null }],
    ['panel override wins', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel('anima-turbo'), refCount: 2, charCount: 2 }, { recipe: 'anima-turbo', refineWith: null }],
    ['panel override to klein still refines B&W when bwRefine is set', { settings: withRefine, manga: manga('bw'), panel: panel('klein-ref'), refCount: 0, charCount: 0 }, { recipe: 'klein-ref', refineWith: 'anime-refine' }],
    ['routing comes from settings', { settings: custom, manga: manga('bw'), panel: panel(), refCount: 2, charCount: 3 }, { recipe: 'klein-ref', refineWith: null }],
    ['two characters with refs, B&W → multiChar + refine when bwRefine is set', { settings: withRefine, manga: manga('bw'), panel: panel(), refCount: 2, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: 'anime-refine' }],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(routeRecipe(input)).toEqual(expected);
  });

  it('knows which recipes want tags and which want sentences', () => {
    expect(['anime', 'anime-ref', 'anime-pose', 'anime-refine', 'anima', 'anima-turbo'].map(promptStyleFor)).toEqual(Array(6).fill('tags'));
    expect(['qwen-edit-ref', 'klein-ref'].map(promptStyleFor)).toEqual(['natural', 'natural']);
    expect(refineFor(DEFAULT_SETTINGS, manga('bw'), 'anime')).toBeNull();
  });
});

describe('panel sizes', () => {
  const page = (layout: LayoutNode): Page => ({ id: 'pg_size000001', mangaId: 'mg_size000001', chapterId: 'ch_size000001', kind: 'page', order: 0, layout, createdAt: STAMP, updatedAt: STAMP });
  const splash = page({ type: 'panel', id: 'pn_a' });
  const columns = page({ type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } });
  const rows = page({ type: 'split', dir: 'h', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } });

  it('uses millimetres, not normalized units, for the aspect', () => {
    expect(panelAspect(splash, DEFAULT_PAGE_FORMAT, 'pn_a')).toBeCloseTo(162 / 233, 3);
    expect(panelAspect(columns, DEFAULT_PAGE_FORMAT, 'pn_b')).toBeCloseTo(79.5 / 233, 3);
  });

  it('picks the nearest SDXL bucket', () => {
    expect(panelSize(splash, DEFAULT_PAGE_FORMAT, 'pn_a', RECIPES['anime']!)).toEqual([832, 1216]);
    expect(panelSize(columns, DEFAULT_PAGE_FORMAT, 'pn_b', RECIPES['qwen-edit-ref']!)).toEqual([640, 1536]);
    expect(panelSize(rows, DEFAULT_PAGE_FORMAT, 'pn_a', RECIPES['klein-ref']!)).toEqual([1216, 832]);
    expect(PORTRAIT_SIZE).toEqual([832, 1216]);
  });

  it('fails permanently for a panel that is not on the page', () => {
    expect(() => panelAspect(splash, DEFAULT_PAGE_FORMAT, 'pn_zz')).toThrow(PermanentError);
  });
});
