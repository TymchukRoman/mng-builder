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

export interface DirectiveRow { id: string; text: string; kind: string; where: string; state: 'applied' | 'unmet' | 'wish' | 'unchecked'; note: string }

/**
 * The details the run understood, one row each: what was asked, what kind of detail it is, where it applies ("all chapters" or
 * "ch. 2, 3"), and what the check of the plan found (applied, unmet with what is wrong, a wish that is not checked).
 */
export function directiveRows(run: AutoRun): DirectiveRow[] {
  return (run.plan?.directives ?? []).map((d) => ({
    id: d.id, text: d.text, kind: d.kind,
    where: d.chapters.length === 0 ? 'all chapters' : `ch. ${d.chapters.join(', ')}`,
    state: !d.must ? 'wish' : d.status === 'applied' ? 'applied' : d.status === 'unmet' || d.status === 'partial' ? 'unmet' : 'unchecked',
    note: d.note ?? '',
  }));
}

/** "12 details understood" / "12 details, 2 not fully applied". */
export function directiveSummary(rows: readonly DirectiveRow[]): string {
  const unmet = rows.filter((r) => r.state === 'unmet').length;
  return `${rows.length} detail${rows.length === 1 ? '' : 's'} understood${unmet > 0 ? `, ${unmet} not fully applied` : ''}`;
}
