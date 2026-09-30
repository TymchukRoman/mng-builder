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

/** The chip modifier for a run that is not running (the running state shows a StatusLoader); the shared `.status-chip--*` set. */
export function statusChipClass(status: EpisodeRun['status']): string {
  switch (status) {
    case 'done': return 'status-chip--ready';
    case 'running':
    case 'awaiting-review': return 'status-chip--generating';
    case 'failed':
    case 'cancelled': return 'status-chip--failed';
  }
}

/** A number field's text, read only when it is a finite number: an empty or half-typed entry (`-`, `1e`) writes nothing. */
export function numberFromInput(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The readable path of a nested output field, e.g. `pages[2].panels[1].scene`. List items count from 1, like the visible lists. */
export function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key + 1}]`;
  return path === '' ? key : `${path}.${key}`;
}

/** Rows for a text field: one per line, a wrapped line counting once per ~64 characters, at most 6 (then it scrolls). */
export function textRows(value: string): number {
  const rows = value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 64)), 0);
  return Math.min(6, rows);
}

/** The user's unsaved edit of one step's output. It belongs to `key` (see `stepKey`) and is dropped when the step itself changes. */
export interface StepEdit { key: string; draft: unknown; raw: string | null }
export type StepEdits = Partial<Record<EpisodeStepName, StepEdit>>;

/** Changes when the step gets a new status or token; a refetch of the same run leaves it alone. */
export function stepKey(run: EpisodeRun, name: EpisodeStepName): string {
  const step = run.steps[EPISODE_STEPS.indexOf(name)];
  return `${run.id}:${name}:${step?.status ?? ''}:${step?.startedAt ?? ''}:${step?.finishedAt ?? ''}`;
}

/** The step's edit if it is still current, else a fresh one holding the saved output. */
export function editOf(run: EpisodeRun, edits: StepEdits, name: EpisodeStepName): StepEdit {
  const key = stepKey(run, name);
  const edit = edits[name];
  return edit?.key === key ? edit : { key, draft: run.steps[EPISODE_STEPS.indexOf(name)]?.output ?? null, raw: null };
}

/** The editable steps whose current draft differs from their saved output (their tabs are marked). */
export function dirtySteps(run: EpisodeRun, edits: StepEdits): Set<EpisodeStepName> {
  const out = new Set<EpisodeStepName>();
  for (const name of EPISODE_STEPS) {
    const edit = edits[name];
    if (!edit || edit.key !== stepKey(run, name) || !stepActions(run, name).edit) continue;
    if (isDirty(run.steps[EPISODE_STEPS.indexOf(name)]?.output ?? null, edit.draft, edit.raw)) out.add(name);
  }
  return out;
}

/** "Edit as JSON" and back: the form's draft becomes text; valid text becomes the form's draft, invalid text stays. */
export function toggleRaw(edit: StepEdit): { ok: true; edit: StepEdit } | { ok: false; error: string } {
  if (edit.raw === null) return { ok: true, edit: { ...edit, raw: JSON.stringify(edit.draft, null, 2) } };
  const parsed = parseDraft(edit.raw);
  return parsed.ok ? { ok: true, edit: { ...edit, draft: parsed.value, raw: null } } : { ok: false, error: parsed.error };
}

/** Continue and Run to end: save the approved step's draft first (when there is one), and move on only if that save succeeded. */
export async function saveThen(save: (() => Promise<unknown>) | null, next: () => Promise<EpisodeRun>): Promise<EpisodeRun> {
  if (save) await save();
  return next();
}
