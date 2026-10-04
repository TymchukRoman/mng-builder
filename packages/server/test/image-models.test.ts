import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, IMAGE_MODELS, STYLE_PRESETS, type ApiErrorBody, type Chapter, type Manga } from '@manga/shared';
import { styleLoras } from '../src/handlers/context.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { routeRecipe } from '../src/imaging/route.js';
import { addArtTags } from '../src/workflows/episode/effects.js';
import { call, makeTestApp, type TestApp } from './helpers/app.js';

const STAMP = '2026-09-27T00:00:00.000Z';
const manga = (recipe = 'anime'): Manga => ({
  id: 'mg_model0001', title: 'M', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', pageFormat: { widthMm: 182, heightMm: 257, dpi: 300, marginsMm: { top: 1, bottom: 1, inner: 1, outer: 1 }, gutterColMm: 1, gutterRowMm: 1, borderMm: 1 },
  styleGuide: { ...STYLE_PRESETS['manga-bw']!.styleGuide, recipe }, imageModel: null, coverPageId: null, createdAt: STAMP, updatedAt: STAMP,
});
const panel = { id: 'pn_model0001', recipe: null } as never;
const route = (imageModel: string | null, refCount: number, charCount: number, m = manga()) =>
  routeRecipe({ settings: DEFAULT_SETTINGS, manga: m, panel, refCount, charCount, imageModel }).recipe;

describe('image model presets', () => {
  it('only use recipes that exist, with references where a route needs them', () => {
    for (const model of Object.values(IMAGE_MODELS)) {
      for (const [slot, id] of Object.entries(model.routing)) {
        expect(RECIPES[id], `${model.id}.${slot}`).toBeDefined();
        if (slot === 'noChars') expect(RECIPES[id]!.requiresRefs, `${model.id}.noChars needs references`).toBe(false);
        expect(RECIPES[id]!.family === 'upscale').toBe(false);
      }
      expect(model.usesReferences).toBe(model.routing.oneChar !== 'anima' && model.routing.oneChar !== 'anima-turbo');
    }
  });
});

describe('routeRecipe with an image model', () => {
  it('uses the model for every kind of panel', () => {
    expect([route('flux2', 0, 0), route('flux2', 1, 1), route('flux2', 2, 2)]).toEqual(['klein-ref', 'klein-ref', 'klein-ref']);
    expect([route('qwen', 0, 1), route('qwen', 1, 1), route('qwen', 2, 3)]).toEqual(['klein-ref', 'qwen-edit-ref', 'qwen-edit-ref']);
    expect([route('anima-turbo', 0, 0), route('anima-turbo', 1, 1)]).toEqual(['anima-turbo', 'anima-turbo']);
  });

  it('beats the manga style for panels without references, and leaves Settings alone without a model', () => {
    expect(route(null, 0, 0, manga('anima'))).toBe('anima');
    expect(route('sdxl', 0, 0, manga('anima'))).toBe('anime');
    expect(route(null, 1, 1)).toBe(DEFAULT_SETTINGS.routing.oneChar);
    expect(route('nope', 1, 1)).toBe(DEFAULT_SETTINGS.routing.oneChar);
  });

  it('keeps a panel recipe of its own', () => {
    const own = { id: 'pn_model0001', recipe: 'anima' } as never;
    expect(routeRecipe({ settings: DEFAULT_SETTINGS, manga: manga(), panel: own, refCount: 1, charCount: 1, imageModel: 'flux2' }).recipe).toBe('anima');
  });
});

describe('styleLoras with an image model', () => {
  const count = { boy: 0 } as never;
  it('keeps the manga LoRAs for its own family', () => {
    expect(styleLoras(manga(), 'anime-ref', count, 'sdxl').map((l) => l.name)).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
  });

  it('gives another family the LoRA of its own preset only when a model is chosen', () => {
    expect(styleLoras(manga(), 'anima', count)).toEqual([]);
    expect(styleLoras(manga(), 'anima', count, 'anima').map((l) => l.name)).toEqual(['Mangalike_Anima.safetensors']);
    expect(styleLoras(manga(), 'klein-ref', count, 'flux2')).toEqual([]);
  });
});

describe('addArtTags', () => {
  it('adds the missing tags once, case-insensitively', () => {
    expect(addArtTags('1girl, smile', 'Simple Background, thick outlines')).toBe('1girl, smile, Simple Background, thick outlines');
    expect(addArtTags('1girl, simple background', 'Simple Background, flat colors')).toBe('1girl, simple background, flat colors');
    expect(addArtTags('1girl', '')).toBe('1girl');
  });
});

describe('image model API', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeTestApp(); });
  afterEach(async () => { await t.close(); });

  it('stores a model on a manga and on a chapter, and refuses an unknown one', async () => {
    const created = (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'M', imageModel: 'anima' })).body;
    expect(created.imageModel).toBe('anima');
    expect((await call<Manga>(t.app, 'PATCH', `/api/mangas/${created.id}`, { imageModel: null })).body.imageModel).toBeNull();
    expect((await call<Manga>(t.app, 'PATCH', `/api/mangas/${created.id}`, { imageModel: 'flux2' })).body.imageModel).toBe('flux2');
    const chapter = (await call<Chapter>(t.app, 'POST', `/api/mangas/${created.id}/chapters`, { title: 'One', imageModel: 'qwen' })).body;
    expect(chapter.imageModel).toBe('qwen');
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${chapter.id}`, { imageModel: null })).body.imageModel).toBeNull();
    const bad = await call<ApiErrorBody>(t.app, 'PATCH', `/api/mangas/${created.id}`, { imageModel: 'nope' });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'validation']);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${created.id}`)).body.imageModel).toBe('flux2');
    expect((await call<ApiErrorBody>(t.app, 'POST', '/api/mangas', { title: 'M', imageModel: 'nope' })).status).toBe(400);
  });
});
