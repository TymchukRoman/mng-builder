import { describe, expect, it } from 'vitest';
import {
  AutoMangaInputSchema, IMAGE_MODELS, IMAGE_MODEL_IDS, ImageModelFieldSchema, applyImageModel, chapterModelFor, chapterPrompt, effectiveImageModel,
  estimateChapter, estimateManga, formatMangaEstimate, imageModelById, mangaPlanSchemaFor, DEFAULT_SETTINGS, type MangaPlan,
} from '../src/index.js';

const character = { name: 'Aiko', role: 'main' as const, personality: 'curious', speechStyle: 'lively', appearanceTags: '1girl, short black hair' };
const plan = (chapters: number, over: Partial<MangaPlan> = {}): MangaPlan => ({
  title: 'T', synopsis: 'S', tone: '', notes: '', styleTags: '', negativeTags: '', characters: [character],
  chapters: Array.from({ length: chapters }, (_, i) => ({ title: `C${i + 1}`, synopsis: 's', plot: 'p' })),
  poster: { action: 'a', background: '' }, ...over,
});

describe('image models', () => {
  it('lists presets with three routes each and looks them up by id', () => {
    expect(IMAGE_MODEL_IDS).toEqual(['sdxl', 'flux2', 'qwen', 'anima', 'anima-turbo']);
    for (const m of Object.values(IMAGE_MODELS)) expect(Object.keys(m.routing).sort()).toEqual(['multiChar', 'noChars', 'oneChar']);
    expect(imageModelById('flux2')?.label).toContain('FLUX');
    expect([imageModelById(null), imageModelById('nope'), imageModelById('toString')]).toEqual([null, null, null]);
  });

  it('applies a model over the routing and leaves everything else', () => {
    const applied = applyImageModel(DEFAULT_SETTINGS, 'anima');
    expect(applied.routing).toEqual({ ...DEFAULT_SETTINGS.routing, noChars: 'anima', oneChar: 'anima', multiChar: 'anima' });
    expect(applyImageModel(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(applyImageModel(DEFAULT_SETTINGS, 'nope')).toBe(DEFAULT_SETTINGS);
  });

  it('prefers the chapter, then the manga', () => {
    expect(effectiveImageModel({ imageModel: 'anima' }, { imageModel: 'flux2' })).toBe('anima');
    expect(effectiveImageModel({ imageModel: null }, { imageModel: 'flux2' })).toBe('flux2');
    expect(effectiveImageModel(null, { imageModel: null })).toBeNull();
  });

  it('validates the API field', () => {
    expect(ImageModelFieldSchema.safeParse(null).success).toBe(true);
    expect(ImageModelFieldSchema.safeParse('qwen').success).toBe(true);
    expect(ImageModelFieldSchema.safeParse('nope').success).toBe(false);
  });

  it('changes the chapter estimate', () => {
    const slow = estimateChapter(8, DEFAULT_SETTINGS, 'bw', 'qwen').seconds;
    const fast = estimateChapter(8, DEFAULT_SETTINGS, 'bw', 'anima-turbo').seconds;
    expect(fast).toBeLessThan(slow);
    expect(estimateChapter(8, DEFAULT_SETTINGS, 'bw', null)).toEqual(estimateChapter(8, DEFAULT_SETTINGS, 'bw'));
  });
});

describe('auto-created manga input and plan', () => {
  it('fills defaults and refuses an empty brief or too many chapters', () => {
    expect(AutoMangaInputSchema.parse({ brief: '  A cat  ' })).toEqual({
      brief: 'A cat', chapters: 3, pagesPerChapter: 8, title: '', language: 'en', readingDirection: 'rtl', stylePreset: 'manga-bw',
      imageModel: null, chapterModels: [], poster: true,
    });
    expect(AutoMangaInputSchema.safeParse({ brief: ' ' }).success).toBe(false);
    expect(AutoMangaInputSchema.safeParse({ brief: 'x', chapters: 21 }).success).toBe(false);
    expect(AutoMangaInputSchema.safeParse({ brief: 'x', chapterModels: ['nope'] }).success).toBe(false);
  });

  it('takes a chapter model from its slot, else the manga', () => {
    const input = { imageModel: 'flux2', chapterModels: [null, 'anima'] };
    expect([1, 2, 3].map((n) => chapterModelFor(input, n))).toEqual(['flux2', 'anima', 'flux2']);
  });

  it('requires exactly the asked chapters and distinct names', () => {
    const schema = mangaPlanSchemaFor({ chapters: 2 });
    expect(schema.safeParse(plan(2)).success).toBe(true);
    expect(schema.safeParse(plan(3)).success).toBe(false);
    expect(schema.safeParse(plan(2, { characters: [character, { ...character, name: ' aiko ' }] })).success).toBe(false);
    expect(schema.safeParse({ ...plan(2), notes: undefined, styleTags: undefined }).success).toBe(true);
  });

  it('words each chapter from the plan', () => {
    const p = plan(3);
    expect(chapterPrompt(p, p.chapters[0]!, 1, 3)).toBe('T, chapter 1 of 3: "C1". p');
    expect(chapterPrompt(p, p.chapters[2]!, 3, 3)).toContain('the final chapter');
  });

  it('estimates every chapter at its own model', () => {
    const base = { chapters: 3, pagesPerChapter: 4, imageModel: null, chapterModels: [] };
    const all = estimateManga(base, DEFAULT_SETTINGS, 'bw');
    expect(all.panels).toBe(3 * estimateChapter(4, DEFAULT_SETTINGS, 'bw').panels);
    expect(estimateManga({ ...base, chapterModels: ['anima-turbo', 'anima-turbo', 'anima-turbo'] }, DEFAULT_SETTINGS, 'bw').seconds).toBeLessThan(all.seconds);
    expect(formatMangaEstimate({ ...base, chapters: 1, pagesPerChapter: 1 }, DEFAULT_SETTINGS)).toMatch(/^1 chapter × 1 page ≈ \d+ panels ≈ /);
  });
});
