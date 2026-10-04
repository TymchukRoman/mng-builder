import { AUTO_STAGES, type AutoRun, type AutoStage } from '@manga/shared';

export const STAGE_LABEL: Record<AutoStage, string> = {
  plan: 'Plan', portraits: 'Portraits', poster: 'Poster', chapters: 'Chapters', done: 'Done',
};

/** One line for what the run is doing now, or why it stopped. */
export function runStatusText(run: AutoRun): string {
  if (run.status === 'done') return run.error ? `Made, with a note: ${run.error}` : 'Made';
  if (run.status === 'cancelled') return 'Stopped';
  if (run.status === 'failed') return run.error ? `Stopped: ${run.error}` : 'Stopped by an error';
  switch (run.stage) {
    case 'plan': return 'Planning the series…';
    case 'portraits': return 'Drawing character portraits…';
    case 'poster': return 'Drawing the poster…';
    case 'chapters': {
      const total = run.chapterIds.length;
      const title = run.plan?.chapters[run.currentChapter]?.title;
      return `Writing chapter ${run.currentChapter + 1} of ${total}${title ? `: ${title}` : ''}…`;
    }
    case 'done': return 'Finishing…';
  }
}

/** The stages shown as steps, each with where it stands: done, now (running), stopped (the stage a failed run ended on) or later. */
export function stageSteps(run: AutoRun): Array<{ stage: AutoStage; label: string; state: 'done' | 'now' | 'stopped' | 'later' }> {
  const at = AUTO_STAGES.indexOf(run.stage);
  return AUTO_STAGES.filter((s) => s !== 'done').map((stage) => {
    const i = AUTO_STAGES.indexOf(stage);
    const state = run.status === 'done' || i < at ? 'done' : i > at ? 'later' : run.status === 'running' ? 'now' : 'stopped';
    return { stage, label: STAGE_LABEL[stage], state };
  });
}

/** A run the manga page shows: one that is running, stopped, or finished with a note. A clean finish shows nothing. */
export function showsRun(run: AutoRun | null | undefined): run is AutoRun {
  return !!run && (run.status !== 'done' || run.error !== null);
}
