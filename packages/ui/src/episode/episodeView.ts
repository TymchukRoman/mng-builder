import { EDITABLE_STEPS, EPISODE_STEPS, type EpisodeRun, type EpisodeStepName } from '@manga/shared';
import { ApiError } from '../api';
import type { Barrier } from '../editor/HistoryBarrierContext';

type StepStatus = EpisodeRun['steps'][number]['status'];

export const STEP_LABEL: Record<EpisodeStepName, string> = {
  premise: 'Premise', outline: 'Outline', breakdown: 'Pages', scripts: 'Scripts', prompts: 'Prompts', render: 'Images', lettering: 'Lettering',
};

/** Tooltip wording for a step tab's status icon. */
export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'not run yet', running: 'running', 'awaiting-review': 'waiting for review', done: 'done', failed: 'failed',
};

const WORKING: Record<EpisodeStepName, string> = {
  premise: 'Writing the premise', outline: 'Writing the outline', breakdown: 'Planning the pages', scripts: 'Writing the scripts',
  prompts: 'Writing image prompts', render: 'Rendering images', lettering: 'Lettering',
};

export function isLive(run: EpisodeRun): boolean {
  return run.status === 'running' || run.status === 'awaiting-review';
}

export function currentStepName(run: EpisodeRun): EpisodeStepName {
  return EPISODE_STEPS[run.currentStep] ?? 'lettering';
}

export function runLabel(run: EpisodeRun): string {
  const step = currentStepName(run);
  switch (run.status) {
    case 'running': return WORKING[step];
    case 'awaiting-review': return `Review: ${STEP_LABEL[step].toLowerCase()}`;
    case 'failed': return `Failed at ${STEP_LABEL[step].toLowerCase()}`;
    case 'done': return 'Chapter ready';
    case 'cancelled': return 'Cancelled';
  }
}

export interface StepActions { approve: boolean; autopilot: boolean; cancel: boolean; rerun: boolean; edit: boolean }

/** Mirrors the server's rules (Task 9) so buttons are only enabled when the call can succeed. */
export function stepActions(run: EpisodeRun, selected: EpisodeStepName): StepActions {
  const idx = EPISODE_STEPS.indexOf(selected);
  const step = run.steps[idx];
  const live = isLive(run);
  return {
    approve: run.status === 'awaiting-review',
    autopilot: live && run.mode === 'review',
    cancel: live,
    rerun: step !== undefined && idx <= run.currentStep && step.status !== 'pending',
    edit: step !== undefined && EDITABLE_STEPS.has(selected) && (step.status === 'done' || step.status === 'awaiting-review'),
  };
}

export function rerunLabel(run: EpisodeRun, selected: EpisodeStepName): string {
  const idx = EPISODE_STEPS.indexOf(selected);
  return idx === run.currentStep && run.steps[idx]?.status === 'failed' ? 'Retry this step' : 'Re-run from here (later steps run again)';
}

export function parseDraft(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether the form draft (or, in raw mode, the JSON text) differs from the saved step output. Unparsable text counts as a change. */
export function isDirty(saved: unknown, draft: unknown, raw: string | null): boolean {
  if (raw === null) return JSON.stringify(draft) !== JSON.stringify(saved);
  const parsed = parseDraft(raw);
  return !parsed.ok || JSON.stringify(parsed.value) !== JSON.stringify(saved);
}

export type RerunOutcome = { kind: 'done'; run: EpisodeRun } | { kind: 'needs-confirm' };

/**
 * One re-run request. Unconfirmed, a 409 needs_confirm (the step would replace the chapter's story pages) asks the caller
 * to confirm. A confirmed re-run deletes those pages, so it runs as an editor History barrier (F33): it waits for edits in
 * flight, and on success undo and redo are cleared, since their commands name the deleted pages.
 */
export async function rerunStep(send: (confirm: boolean) => Promise<EpisodeRun>, confirmed: boolean, barrier: Barrier): Promise<RerunOutcome> {
  if (confirmed) return { kind: 'done', run: await barrier(() => send(true)) };
  try {
    return { kind: 'done', run: await send(false) };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'needs_confirm') return { kind: 'needs-confirm' };
    throw err;
  }
}
