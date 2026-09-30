import { EPISODE_ACTIVE_STATUSES, stepIndex, type EpisodeRun, type ImageGeneratePayload, type JobRef } from '@manga/shared';
import { ConflictError } from '../../errors.js';
import { isTerminal, type JobQueue } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';

/** W1 R1: the chapter's story panels and cover panel without an active image, in reading order, the cover last. */
export function missingPanelIds(store: Store, chapterId: string): string[] {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  return chapterPanels(store, chapterId, manga.readingDirection).filter((e) => e.panel.activeImageId === null).map((e) => e.panel.id);
}

/** How many unfinished jobs per status the duplicate check reads (a busy queue holds a few hundred at most). */
const UNFINISHED_SCAN = 500;

/**
 * Whether the run's render step owns the chapter's panels: its driver renders them (running), it will again on resume
 * (paused), or (F8) the active run has not reached it yet, so the panels may still lack their prompts.
 */
function renderOwnsPanels(run: EpisodeRun): boolean {
  if (!EPISODE_ACTIVE_STATUSES.has(run.status)) return false;
  const render = stepIndex('render');
  if (run.currentStep < render) return true;
  const status = run.steps[render]?.status;
  return run.currentStep === render && (status === 'running' || status === 'paused');
}

/**
 * W1 R1 "Re-render failed panels": one `image.generate` per panel without an image, tagged with the chapter's latest run
 * (so its cancel, pause and the render step's adoption see them). A panel that already has an unfinished generate job
 * (this run's, an earlier click's, or the editor's) is skipped. While the latest run's render step owns the panels: 409.
 */
export function renderMissing(store: Store, queue: Pick<JobQueue, 'enqueue'>, chapterId: string): JobRef[] {
  const missing = missingPanelIds(store, chapterId);
  const run = store.episodes.latestByChapter(chapterId);
  if (run && renderOwnsPanels(run)) {
    throw new ConflictError(run.currentStep < stepIndex('render')
      ? 'the episode has not rendered this chapter yet; wait for its render step'
      : 'the episode is rendering this chapter; resume or wait for it');
  }
  const unfinished = [...store.jobs.list({ status: 'queued', limit: UNFINISHED_SCAN }), ...store.jobs.list({ status: 'running', limit: UNFINISHED_SCAN })];
  const queued = new Set(unfinished
    .filter((j) => j.kind === 'image.generate' && !isTerminal(j.status))
    .map((j) => j.payload as ImageGeneratePayload)
    .flatMap((p) => (p.target === 'panel' ? [p.panelId] : [])));
  return missing.filter((id) => !queued.has(id)).map((panelId) => {
    const payload: ImageGeneratePayload = { target: 'panel', panelId };
    return { jobId: queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run?.id ?? null }).id };
  });
}
