import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  CreateFrameSchema,
  ChapterSchema,
  CreateMangaSchema,
  DEFAULT_PAGE_FORMAT,
  DEFAULT_SETTINGS,
  EMPTY_SCRIPT,
  EPISODE_ACTIVE_STATUSES,
  EpisodeInputSchema,
  EpisodeRunStatusSchema,
  LayoutNodeSchema,
  PageFormatSchema,
  PanelScriptSchema,
  SettingsPatchSchema,
  SettingsSchema,
  StartEpisodeSchema,
  StepStatusSchema,
  UpdateChapterSchema,
  UpdateMangaSchema,
} from '@manga/shared';

describe('schemas', () => {
  it('accept the defaults they ship with', () => {
    expect(PageFormatSchema.parse(DEFAULT_PAGE_FORMAT)).toEqual(DEFAULT_PAGE_FORMAT);
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(PanelScriptSchema.parse(EMPTY_SCRIPT)).toEqual(EMPTY_SCRIPT);
  });

  it('validate layout trees recursively and reject degenerate ratios and empty ids', () => {
    const ok = {
      type: 'split', dir: 'h', ratio: 0.5,
      a: { type: 'panel', id: 'pn_a' },
      b: { type: 'split', dir: 'v', ratio: 0.3, a: { type: 'panel', id: 'pn_b' }, b: { type: 'panel', id: 'pn_c' } },
    };
    expect(LayoutNodeSchema.parse(ok)).toEqual(ok);
    expect(LayoutNodeSchema.safeParse({ ...ok, ratio: 1 }).success).toBe(false);
    expect(LayoutNodeSchema.safeParse({ ...ok, b: { type: 'panel', id: '' } }).success).toBe(false);
  });

  it('fill request defaults', () => {
    expect(CreateMangaSchema.parse({ title: 'Oni' })).toEqual({
      title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset: 'manga-bw', imageModel: null,
    });
    expect(CreateFrameSchema.parse({ kind: 'speech' })).toEqual({
      kind: 'speech', text: '', panelId: null, speakerId: null, rotation: 0, autoFit: true, align: 'center',
    });
    expect(EpisodeInputSchema.parse({ prompt: 'x' })).toEqual({ prompt: 'x', characterIds: [], pages: 8, tone: '' });
    expect(StartEpisodeSchema.parse({ input: { prompt: 'x' } }).mode).toBe('review');
    expect(AppConfigSchema.parse({ libraryPath: '/lib' }).port).toBe(4317);
  });

  it('keep partial updates partial', () => {
    expect(UpdateMangaSchema.parse({ title: 'New' })).toEqual({ title: 'New' });
    expect(SettingsPatchSchema.parse({ engine: { tasks: { story: 'local' } } })).toEqual({ engine: { tasks: { story: 'local' } } });
    expect(SettingsPatchSchema.safeParse({ engine: { mode: 'gpt' } }).success).toBe(false);
  });
});

describe('W1 schema additions', () => {
  it('a run and a step can be paused; paused runs are live', () => {
    expect(StepStatusSchema.parse('paused')).toBe('paused');
    expect(EpisodeRunStatusSchema.parse('paused')).toBe('paused');
    expect(EPISODE_ACTIVE_STATUSES.has('paused')).toBe(true);
  });

  it('previewFirst: absent on a stored input (off), true by default when a run is started through the API', () => {
    expect(EpisodeInputSchema.parse({ prompt: 'p' }).previewFirst).toBeUndefined();
    expect(StartEpisodeSchema.parse({ input: { prompt: 'p' } }).input.previewFirst).toBe(true);
    expect(StartEpisodeSchema.parse({ input: { prompt: 'p', previewFirst: false } }).input.previewFirst).toBe(false);
  });

  it('a chapter row read before migration 2 gets an empty summary; the summary is patchable', () => {
    const row = { id: 'ch_aaaaaaaaaa', mangaId: 'mg_aaaaaaaaaa', number: 1, title: 'T', synopsis: '', coverPageId: null, status: 'draft', order: 0, createdAt: '', updatedAt: '' };
    expect(ChapterSchema.parse(row).summary).toBe('');
    expect(UpdateChapterSchema.parse({ summary: 'Aiko found the cat.' })).toEqual({ summary: 'Aiko found the cat.' });
  });

  it('settings.episode.confirmRenderMinutes defaults to 45 and is patchable', () => {
    expect(DEFAULT_SETTINGS.episode.confirmRenderMinutes).toBe(45);
    expect(SettingsPatchSchema.parse({ episode: { confirmRenderMinutes: 90 } })).toEqual({ episode: { confirmRenderMinutes: 90 } });
    expect(SettingsSchema.shape.episode.safeParse({ confirmRenderMinutes: 0 }).success).toBe(false);
  });
});
