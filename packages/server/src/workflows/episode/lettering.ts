import type { EpisodeRun, LetteringOutput, Page } from '@manga/shared';
import { letterPage } from '../../domain/lettering.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { storyPages } from './chapter.js';

/**
 * Step 7 (spec §8): TextFrames from dialogue on every story page, plus the cover's title frame. Only frame rows are
 * created (the page rows do not change), so each new frame emits `textFrame created`, as POST /api/pages/:id/frames does.
 */
export async function runLetteringStep(deps: { store: Store; bus: EventBus }, ctx: JobContext, run: EpisodeRun): Promise<LetteringOutput> {
  const { store, bus } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const cover = chapter.coverPageId === null ? null : store.pages.get(chapter.coverPageId);
  const pages: Page[] = [...storyPages(store, chapter.id), ...(cover ? [cover] : [])];
  let frames = 0;
  pages.forEach((page, i) => {
    ctx.progress('Lettering pages', i, pages.length);
    const created = letterPage(store, page.id);
    frames += created.length;
    for (const f of created) emitEntity(bus, 'textFrame', f.id, 'created', page.mangaId);
  });
  ctx.progress('Lettering pages', pages.length, pages.length);
  return { frames };
}
