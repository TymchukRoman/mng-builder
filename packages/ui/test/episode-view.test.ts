import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { ApiError } from '../src/api';
import { History } from '../src/editor/history';
import {
  STEP_STATUS_TEXT, currentStepName, isDirty, isLive, parseDraft, rerunLabel, rerunStep, runLabel, stepActions,
} from '../src/episode/episodeView';

type StepStatus = EpisodeRun['steps'][number]['status'];
function run(status: EpisodeRun['status'], currentStep: number, current: StepStatus, mode: EpisodeRun['mode'] = 'review'): EpisodeRun {
  return {
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode, currentStep, status,
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < currentStep ? 'done' : i === currentStep ? current : 'pending',
      output: i <= currentStep ? { any: 'thing' } : null, error: null, startedAt: null, finishedAt: null,
    })),
    createdAt: '', updatedAt: '',
  };
}

describe('episode view', () => {
  it('labels the run by what it is doing', () => {
    expect(runLabel(run('running', 3, 'running'))).toBe('Writing the scripts');
    expect(runLabel(run('awaiting-review', 1, 'awaiting-review'))).toBe('Review: outline');
    expect(runLabel(run('failed', 5, 'failed'))).toBe('Failed at images');
    expect(runLabel(run('done', 6, 'done'))).toBe('Chapter ready');
    expect(runLabel(run('cancelled', 0, 'failed'))).toBe('Cancelled');
    expect(currentStepName(run('running', 4, 'running'))).toBe('prompts');
    expect(isLive(run('awaiting-review', 1, 'awaiting-review'))).toBe(true);
    expect(isLive(run('done', 6, 'done'))).toBe(false);
    expect(STEP_STATUS_TEXT['awaiting-review']).toBe('waiting for review');
  });

  it('enables actions for a run waiting at a review point', () => {
    const r = run('awaiting-review', 3, 'awaiting-review');
    expect(stepActions(r, 'scripts')).toEqual({ approve: true, autopilot: true, cancel: true, rerun: true, edit: true });
    expect(stepActions(r, 'premise')).toMatchObject({ rerun: true, edit: true });
    expect(stepActions(r, 'prompts')).toMatchObject({ rerun: false, edit: false });
  });

  it('never edits informational steps and hides run-to-end in autopilot', () => {
    const r = run('running', 6, 'running', 'autopilot');
    expect(stepActions(r, 'render')).toEqual({ approve: false, autopilot: false, cancel: true, rerun: true, edit: false });
    expect(stepActions(r, 'lettering')).toMatchObject({ edit: false });
    expect(stepActions(run('done', 6, 'done'), 'premise')).toMatchObject({ cancel: false, approve: false, edit: true });
  });

  it('calls a re-run of the failed current step a retry', () => {
    expect(rerunLabel(run('failed', 5, 'failed'), 'render')).toBe('Retry this step');
    expect(rerunLabel(run('failed', 5, 'failed'), 'outline')).toBe('Re-run from here (later steps run again)');
  });

  it('parses raw JSON edits', () => {
    expect(parseDraft('{"title":"x"}')).toEqual({ ok: true, value: { title: 'x' } });
    expect(parseDraft('{oops')).toMatchObject({ ok: false });
  });

  it('knows when the form or the raw JSON differs from the saved output', () => {
    const saved = { title: 'x', pages: [1, 2] };
    expect(isDirty(saved, { title: 'x', pages: [1, 2] }, null)).toBe(false);
    expect(isDirty(saved, { title: 'y', pages: [1, 2] }, null)).toBe(true);
    expect(isDirty(saved, saved, JSON.stringify(saved, null, 2))).toBe(false);
    expect(isDirty(saved, saved, '{"title":"x","pages":[1,2]}')).toBe(false);
    expect(isDirty(saved, saved, '{"title":"x"}')).toBe(true);
    expect(isDirty(saved, saved, '{oops')).toBe(true);
  });
});

describe('re-running a step (F33)', () => {
  const needsConfirm = new ApiError(409, 'needs_confirm', "re-running outline replaces the chapter's pages; resend with confirm=true", { removedPanelIds: ['pn_a'] });

  it('asks for confirmation when the server says the re-run replaces the pages, without touching the editor history', async () => {
    const sent: boolean[] = [];
    let barriers = 0;
    const out = await rerunStep((confirm) => { sent.push(confirm); return Promise.reject(needsConfirm); }, false,
      (fn) => { barriers++; return fn(); });
    expect(out).toEqual({ kind: 'needs-confirm' });
    expect(sent).toEqual([false]);
    expect(barriers).toBe(0);
  });

  it('sends a confirmed re-run as a history barrier, so undo can no longer target the deleted pages', async () => {
    const history = new History();
    await history.run({ label: 'Resize panels', pageId: 'pg_old', apply: async () => undefined, revert: async () => undefined });
    expect(history.snapshot().canUndo).toBe(true);
    const done = run('running', 1, 'running');
    const sent: boolean[] = [];
    const out = await rerunStep((confirm) => { sent.push(confirm); return Promise.resolve(done); }, true, (fn) => history.barrier(fn));
    expect(out).toEqual({ kind: 'done', run: done });
    expect(sent).toEqual([true]);
    expect(history.snapshot().canUndo).toBe(false);
  });

  it('a re-run that needs no confirmation is sent directly; other errors are thrown for the toast', async () => {
    const done = run('running', 5, 'running');
    let barriers = 0;
    const barrier = <T,>(fn: () => Promise<T>): Promise<T> => { barriers++; return fn(); };
    await expect(rerunStep(() => Promise.resolve(done), false, barrier)).resolves.toEqual({ kind: 'done', run: done });
    const conflict = new ApiError(409, 'conflict', 'step render has not run yet');
    await expect(rerunStep(() => Promise.reject(conflict), false, barrier)).rejects.toBe(conflict);
    await expect(rerunStep(() => Promise.reject(needsConfirm), true, barrier)).rejects.toBe(needsConfirm);
    expect(barriers).toBe(1);
  });
});
