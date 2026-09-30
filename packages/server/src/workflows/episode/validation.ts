// packages/server/src/workflows/episode/validation.ts
import type { z } from 'zod';
import {
  BreakdownOutputSchema, LetteringOutputSchema, OutlineOutputSchema, PremiseOutputSchema, RenderOutputSchema,
  breakdownSchemaFor, outlineSchemaFor, promptsSchemaFor, scriptsSchemaFor, type EpisodeRun, type EpisodeStepName,
} from '@manga/shared';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';
import { requireOutput } from './steps.js';

/** The schema a step's output must satisfy right now (LLM answers and user edits alike). */
export function validationSchema(store: Store, run: EpisodeRun, step: EpisodeStepName): z.ZodType<unknown> {
  switch (step) {
    case 'premise':
      return PremiseOutputSchema;
    case 'outline':
      return outlineSchemaFor({ knownNames: knownNames(store, run) });
    case 'breakdown':
      return breakdownSchemaFor({ pages: run.input.pages, sceneCount: requireOutput(run, 'outline', OutlineOutputSchema).scenes.length });
    case 'scripts':
      return scriptsSchemaFor({
        panelCounts: requireOutput(run, 'breakdown', BreakdownOutputSchema).pages.map((p) => p.panelCount),
        knownNames: knownNames(store, run),
      });
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

/** Every character of the run's manga: the outline and the scripts may use any of them (outline approval can add some). */
export function knownNames(store: Store, run: EpisodeRun): string[] {
  const chapter = store.chapters.require(run.chapterId);
  return store.characters.listByManga(chapter.mangaId).map((c) => c.name);
}
