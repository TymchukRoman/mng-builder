// packages/server/test/helpers/episode-fixtures.ts
import {
  CHAPTER_TITLE_FROM_PREMISE, DEFAULT_PAGE_FORMAT, EPISODE_STEPS, PRESET_NAMES, STYLE_PRESETS, presetPanelCount, stepIndex,
  type BreakdownOutput, type Chapter, type EpisodeInput, type EpisodeRun, type EpisodeStepName, type Language, type Manga,
  type NewCharacterDraft, type OutlineOutput, type PremiseOutput, type ReadingDirection, type ScriptsOutput,
} from '@manga/shared';
import type { Store } from '../../src/store/index.js';
import { freshSteps } from '../../src/workflows/episode/steps.js';

export const STAMP = '2026-09-27T00:00:00.000Z';

export interface EpisodeWorld { manga: Manga; chapter: Chapter }

/** A manga with one empty chapter (no pages): the starting point of every episode run. Its title is left to the premise (M4 final M6) unless given. */
export function seedEpisodeWorld(
  store: Store, opts: { language?: Language; direction?: ReadingDirection; mangaTitle?: string; chapterTitle?: string } = {},
): EpisodeWorld {
  const preset = STYLE_PRESETS['manga-bw']!;
  const manga = store.mangas.create({
    title: opts.mangaTitle ?? 'Rain Town', synopsis: 'Quiet stories from a harbour town.', language: opts.language ?? 'en',
    colorMode: 'bw', readingDirection: opts.direction ?? 'rtl', pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
  const chapter = store.chapters.create({
    mangaId: manga.id, number: 1, title: opts.chapterTitle ?? CHAPTER_TITLE_FROM_PREMISE, synopsis: '', coverPageId: null, status: 'draft', order: 0,
  });
  return { manga, chapter };
}

export interface SeedRunOptions {
  input?: Partial<EpisodeInput>;
  mode?: 'review' | 'autopilot';
  /** Steps given an output are stored as done. */
  outputs?: Partial<Record<EpisodeStepName, unknown>>;
  currentStep?: EpisodeStepName;
  status?: EpisodeRun['status'];
}

export function seedRun(store: Store, chapterId: string, opts: SeedRunOptions = {}): EpisodeRun {
  const input: EpisodeInput = { prompt: 'A lost cat in the rain', characterIds: [], pages: 2, tone: '', ...opts.input };
  const steps = freshSteps().map((s) => {
    const output = opts.outputs?.[s.name];
    return output === undefined ? s : { ...s, status: 'done' as const, output, startedAt: STAMP, finishedAt: STAMP };
  });
  const firstPending = steps.findIndex((s) => s.status === 'pending');
  const currentStep = opts.currentStep ? stepIndex(opts.currentStep) : firstPending < 0 ? EPISODE_STEPS.length - 1 : firstPending;
  return store.episodes.create({ chapterId, input, mode: opts.mode ?? 'review', steps, currentStep, status: opts.status ?? 'running' });
}

export const PREMISE: PremiseOutput = {
  title: 'The Cat in the Rain', synopsis: 'Aiko finds a stray cat and takes it home.', tone: 'gentle', setting: 'A rainy harbour town at dusk',
};

export function outline(names: string[], newCharacters: NewCharacterDraft[] = []): OutlineOutput {
  return {
    scenes: [
      { summary: 'Aiko finds the cat.', purpose: 'setup', location: 'alley', characterNames: names },
      { summary: 'She takes it home.', purpose: 'resolution', location: 'apartment', characterNames: names },
    ],
    newCharacters,
  };
}

export const TWO_PANEL_PRESET = PRESET_NAMES.find((n) => presetPanelCount(n) === 2)!;

export function breakdown(pages: number, preset = TWO_PANEL_PRESET): BreakdownOutput {
  return {
    pages: Array.from({ length: pages }, (_, i) => ({ sceneIdx: [Math.min(i, 1)], panelCount: presetPanelCount(preset), pacing: 'steady', layoutPreset: preset })),
  };
}

/** One panel script per breakdown panel; `speaker` (a character name) speaks in every panel, or narration when null. */
export function scripts(bd: BreakdownOutput, speaker: string | null): ScriptsOutput {
  return {
    pages: bd.pages.map((p, i) => ({
      panels: Array.from({ length: p.panelCount }, (_, j) => ({
        action: `Page ${i + 1} panel ${j + 1}`, shot: 'medium' as const, angle: 'eye' as const,
        characters: speaker ? [{ name: speaker, pose: 'standing', expression: 'calm', position: 'left' as const }] : [],
        background: 'street',
        dialogue: speaker
          ? [{ speaker, kind: 'speech' as const, text: `Line ${i + 1}.${j + 1}` }]
          : [{ speaker: null, kind: 'narration' as const, text: `Narration ${i + 1}.${j + 1}` }],
      })),
    })),
  };
}
