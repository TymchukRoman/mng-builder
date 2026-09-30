// packages/server/src/workflows/episode/validation.ts
import type { z } from 'zod';
import {
  BreakdownOutputSchema, LetteringOutputSchema, OutlineOutputSchema, PremiseOutputSchema, RenderOutputSchema,
  breakdownSchemaFor, outlineSchemaFor, panelIds, promptsSchemaFor, scriptsSchemaFor, type EpisodeRun, type EpisodeStepName,
} from '@manga/shared';
import type { Store } from '../../store/index.js';
import { chapterPanels, storyPages } from './chapter.js';
import { requireOutput } from './steps.js';

/**
 * Who wrote the output being validated (required, so every caller decides). `llm`: the step's own answer, whose scripts
 * may name a character the manga lacks or give a page another panel count than the breakdown (materialization drops
 * the name and fits the layout, so one stray detail never fails the run). `user`: an edit, which stays strict.
 */
export interface ValidationOptions { source: 'llm' | 'user' }

/** The schema a step's output must satisfy right now. LLM answers and user edits differ only for the scripts. */
export function validationSchema(store: Store, run: EpisodeRun, step: EpisodeStepName, { source }: ValidationOptions): z.ZodType<unknown> {
  switch (step) {
    case 'premise':
      return PremiseOutputSchema;
    case 'outline':
      return outlineSchemaFor({ knownNames: knownNames(store, run) });
    case 'breakdown':
      return breakdownSchemaFor({ pages: run.input.pages, sceneCount: requireOutput(run, 'outline', OutlineOutputSchema).scenes.length });
    case 'scripts':
      return scriptsSchemaFor({ ...scriptsPanelCounts(store, run, source), knownNames: knownNames(store, run), lenient: source === 'llm' });
    case 'prompts': {
      const chapter = store.chapters.require(run.chapterId);
      const manga = store.mangas.require(chapter.mangaId);
      return promptsSchemaFor({ panelIds: chapterPanels(store, chapter.id, manga.readingDirection).map((e) => e.panel.id) });
    }
    case 'render':
      return RenderOutputSchema;
    case 'lettering':
      return LetteringOutputSchema;
  }
}

/**
 * The panel count each script page must have. An answer follows the breakdown (materialization fits any difference).
 * A user edit of materialized pages rewrites them in place (applyScripts), so it follows their layouts, which may
 * differ from the breakdown once the answer was fitted; with no (or other) pages, the breakdown again.
 */
function scriptsPanelCounts(store: Store, run: EpisodeRun, source: ValidationOptions['source']): { panelCounts: number[]; panelSource?: string } {
  const planned = requireOutput(run, 'breakdown', BreakdownOutputSchema).pages.map((p) => p.panelCount);
  if (source === 'llm') return { panelCounts: planned };
  const pages = storyPages(store, run.chapterId);
  if (pages.length === 0 || pages.length !== planned.length) return { panelCounts: planned };
  return { panelCounts: pages.map((p) => panelIds(p.layout).length), panelSource: 'its page layout' };
}

/** Every character of the run's manga: the outline and the scripts may use any of them (outline approval can add some). */
export function knownNames(store: Store, run: EpisodeRun): string[] {
  const chapter = store.chapters.require(run.chapterId);
  return store.characters.listByManga(chapter.mangaId).map((c) => c.name);
}
