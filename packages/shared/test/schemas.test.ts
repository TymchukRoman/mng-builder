import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  CreateFrameSchema,
  CreateMangaSchema,
  DEFAULT_PAGE_FORMAT,
  DEFAULT_SETTINGS,
  EMPTY_SCRIPT,
  EpisodeInputSchema,
  LayoutNodeSchema,
  PageFormatSchema,
  PanelScriptSchema,
  SettingsPatchSchema,
  SettingsSchema,
  StartEpisodeSchema,
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
      title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset: 'manga-bw',
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
