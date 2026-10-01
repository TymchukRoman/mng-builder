import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { ApiError } from '../src/api';
import { History } from '../src/editor/history';
import {
  STEP_STATUS_TEXT, childPath, currentStepName, dirtySteps, gateLabel, isDirty, isLive, numberFromInput, parseDraft, renderBlock, renderBusy, renderMissingNotice, rerenderCount,
  rerunLabel, rerunStep, runLabel, saveThen, statusChipClass, stepActions, stepKey, stepPlaceholder, textRows, toggleRaw, type StepEdits,
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
    expect(stepActions(r, 'scripts')).toEqual({ approve: true, autopilot: true, cancel: true, rerun: true, edit: true, pause: false, resume: false });
    expect(stepActions(r, 'premise')).toMatchObject({ rerun: true, edit: true });
    expect(stepActions(r, 'prompts')).toMatchObject({ rerun: false, edit: false });
  });

  it('never edits informational steps and hides run-to-end in autopilot', () => {
    const r = run('running', 6, 'running', 'autopilot');
    expect(stepActions(r, 'render')).toEqual({ approve: false, autopilot: false, cancel: true, rerun: true, edit: false, pause: false, resume: false });
    expect(stepActions(r, 'lettering')).toMatchObject({ edit: false });
    expect(stepActions(run('done', 6, 'done'), 'premise')).toMatchObject({ cancel: false, approve: false, edit: true });
  });

  it('edits a done outline or breakdown only while the next step is pending (M4 final M2)', () => {
    const atScripts = run('running', 3, 'running');
    expect(stepActions(atScripts, 'outline').edit).toBe(false);
    expect(stepActions(atScripts, 'breakdown').edit).toBe(false);
    expect(stepActions(atScripts, 'premise').edit).toBe(true);
    const failedAtOutlineNext = run('failed', 2, 'pending');
    expect(stepActions(failedAtOutlineNext, 'outline').edit).toBe(true);
    expect(stepActions(run('awaiting-review', 1, 'awaiting-review'), 'outline').edit).toBe(true);
    expect(stepActions(run('done', 6, 'done'), 'scripts').edit).toBe(true);
  });

  it('shows a placeholder, never a stored output, for a running or pending step (residual N5)', () => {
    expect(stepPlaceholder({ status: 'running' })).toBe('Working…');
    expect(stepPlaceholder({ status: 'pending' })).toBe('Not run yet');
    expect(stepPlaceholder({ status: 'paused' })).toBe('Paused'); // W1 final M5: never the preview gate's raw JSON
    for (const status of ['done', 'awaiting-review', 'failed'] as const) expect(stepPlaceholder({ status })).toBeNull();
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

describe('step edits (review round 1)', () => {
  it('reads a number field only when the text is a finite number (finding 2)', () => {
    expect(numberFromInput('')).toBeNull();
    expect(numberFromInput('  ')).toBeNull();
    expect(numberFromInput('-')).toBeNull();
    expect(numberFromInput('1e')).toBeNull();
    expect(numberFromInput('abc')).toBeNull();
    expect(numberFromInput('-3')).toBe(-3);
    expect(numberFromInput(' 2.5 ')).toBe(2.5);
    expect(numberFromInput('0')).toBe(0);
  });

  it('names nested fields by a readable path, numbered like the visible lists (finding 7)', () => {
    expect(childPath('', 'pages')).toBe('pages');
    expect(childPath('pages', 1)).toBe('pages[2]');
    expect(childPath(childPath(childPath('pages', 1), 'panels'), 0)).toBe('pages[2].panels[1]');
    expect(childPath('pages[2].panels[1]', 'scene')).toBe('pages[2].panels[1].scene');
    expect(childPath('', 0)).toBe('[1]');
  });

  it('sizes a text field from its content', () => {
    expect(textRows('short')).toBe(1);
    expect(textRows('x'.repeat(130))).toBe(3);
    expect(textRows('a\nb\nc')).toBe(3);
    expect(textRows('x\n'.repeat(20))).toBe(6);
  });

  it('maps a finished run status to the shared status-chip modifiers (finding 5)', () => {
    expect(statusChipClass('done')).toBe('status-chip--ready');
    expect(statusChipClass('awaiting-review')).toBe('status-chip--generating');
    expect(statusChipClass('failed')).toBe('status-chip--failed');
    expect(statusChipClass('cancelled')).toBe('status-chip--failed');
  });

  it('keeps a draft per step and reports the steps with unsaved changes (finding 8)', () => {
    const r = run('awaiting-review', 3, 'awaiting-review');
    const edits: StepEdits = {
      premise: { key: stepKey(r, 'premise'), draft: { any: 'changed' }, raw: null },
      outline: { key: stepKey(r, 'outline'), draft: { any: 'thing' }, raw: null }, // same as saved
      scripts: { key: stepKey(r, 'scripts'), draft: { any: 'thing' }, raw: '{"any":"edited"}' },
      breakdown: { key: 'stale', draft: { any: 'old' }, raw: null }, // the step changed since: dropped
    };
    expect([...dirtySteps(r, edits)]).toEqual(['premise', 'scripts']);
    // Approving the scripts changes their status, so their draft no longer counts.
    const approved = run('running', 4, 'running');
    expect([...dirtySteps(approved, edits)]).toEqual(['premise']);
  });

  it('switches between the form and raw JSON without losing edits', () => {
    const form = { key: 'k', draft: { title: 'x' }, raw: null };
    const raw = toggleRaw(form);
    expect(raw).toEqual({ ok: true, edit: { key: 'k', draft: { title: 'x' }, raw: '{\n  "title": "x"\n}' } });
    const back = toggleRaw({ key: 'k', draft: { title: 'x' }, raw: '{"title":"y"}' });
    expect(back).toEqual({ ok: true, edit: { key: 'k', draft: { title: 'y' }, raw: null } });
    expect(toggleRaw({ key: 'k', draft: null, raw: '{oops' })).toMatchObject({ ok: false });
  });

  it('Continue saves the draft of the step it approves first, and stops if the save fails (finding 8, 9)', async () => {
    const calls: string[] = [];
    const next = run('running', 4, 'running');
    await expect(saveThen(async () => { calls.push('save'); }, async () => { calls.push('approve'); return next; })).resolves.toBe(next);
    expect(calls).toEqual(['save', 'approve']);
    calls.length = 0;
    await saveThen(null, async () => { calls.push('approve'); return next; });
    expect(calls).toEqual(['approve']);
    calls.length = 0;
    const invalid = new Error('scripts: Required');
    await expect(saveThen(async () => { calls.push('save'); throw invalid; }, async () => { calls.push('approve'); return next; })).rejects.toBe(invalid);
    expect(calls).toEqual(['save']);
  });
});

it('a paused run reads "Rendering paused" in a paused chip', () => {
  const r = run('paused', 5, 'paused');
  expect(runLabel(r)).toBe('Rendering paused');
  expect(statusChipClass('paused')).toBe('status-chip--paused');
  expect(STEP_STATUS_TEXT.paused).toBe('paused');
});

describe('W1 episode view', () => {
  const base = { jobs: [], reviewed: 0, flagged: 0, rounds: 0, failedPanelIds: [] };
  const gateRun = (output: unknown): EpisodeRun => {
    const r = run('awaiting-review', 5, 'awaiting-review');
    r.steps[5] = { ...r.steps[5]!, output };
    return r;
  };
  const renderRun = (stepStatus: StepStatus, output: unknown, status: EpisodeRun['status'] = 'running'): EpisodeRun => {
    const r = run(status, 5, stepStatus);
    r.steps[5] = { ...r.steps[5]!, output };
    return r;
  };

  it('the preview and size stops have their own status text (F20: the shared gateText)', () => {
    expect(runLabel(gateRun({ ...base, preview: true, remainingPanels: 34, estimateSeconds: 1800 }))).toBe('Page 1 is ready — continue with 34 panels (~30 min)?');
    expect(runLabel(gateRun({ ...base, confirm: true, panels: 40, estimateSeconds: 3600 }))).toBe('Render 40 panels (~1 h)?');
    expect(gateLabel(gateRun(base))).toBeNull();
    expect(runLabel(gateRun(base))).toBe('Review: images');
    expect(gateLabel(run('awaiting-review', 1, 'awaiting-review'))).toBeNull();
  });

  it('pause while the render step runs; resume while paused; renderBusy covers both', () => {
    const r = run('running', 5, 'running');
    expect(stepActions(r, 'render')).toMatchObject({ pause: true, resume: false });
    expect(renderBusy(r)).toBe(true);
    const p = run('paused', 5, 'paused');
    expect(stepActions(p, 'render')).toMatchObject({ pause: false, resume: true, approve: false });
    expect(renderBusy(p)).toBe(true);
    expect(renderBusy(null)).toBe(false);
    expect(renderBusy(undefined)).toBe(false);
    expect(stepActions(run('running', 4, 'running'), 'prompts')).toMatchObject({ pause: false, resume: false });
    expect(stepActions(gateRun({ ...base, preview: true, remainingPanels: 3, estimateSeconds: 60 }), 'render')).toMatchObject({ pause: false, resume: false, approve: true });
  });

  it('a paused run offers only Resume and Cancel (F24)', () => {
    const p = run('paused', 5, 'paused');
    for (const name of ['premise', 'scripts', 'render'] as const) {
      expect(stepActions(p, name), name).toMatchObject({ approve: false, autopilot: false, rerun: false, cancel: true, resume: true, pause: false });
    }
  });

  it('renderBusy mirrors the server\'s render-missing refusal, and an open stop blocks too (F7, F8)', () => {
    expect(renderBusy(gateRun({ ...base, preview: true, remainingPanels: 3, estimateSeconds: 60 }))).toBe(true);
    expect(renderBusy(gateRun({ ...base, confirm: true, panels: 30, estimateSeconds: 900 }))).toBe(true);
    expect(renderBusy(gateRun(base))).toBe(false); // a review point after the render
    expect(renderBusy(run('running', 4, 'running'))).toBe(true); // not rendered yet
    expect(renderBusy(run('awaiting-review', 3, 'awaiting-review'))).toBe(true);
    expect(renderBusy(run('running', 6, 'running'))).toBe(false); // lettering
    expect(renderBusy(run('failed', 5, 'failed'))).toBe(false);
    expect(renderBusy(run('cancelled', 2, 'failed'))).toBe(false);
    expect(renderBusy(run('done', 6, 'done'))).toBe(false);
  });

  it('renderBlock says why: a stop waits for Continue; otherwise the episode renders them (review M1)', () => {
    expect(renderBlock(gateRun({ ...base, preview: true, remainingPanels: 3, estimateSeconds: 60 }))).toBe('stop');
    expect(renderBlock(gateRun({ ...base, confirm: true, panels: 30, estimateSeconds: 900 }))).toBe('stop');
    expect(renderBlock(run('running', 5, 'running'))).toBe('episode');
    expect(renderBlock(run('paused', 5, 'paused'))).toBe('episode');
    expect(renderBlock(run('running', 4, 'running'))).toBe('episode');
    expect(renderBlock(gateRun(base))).toBeNull();
    expect(renderBlock(run('failed', 5, 'failed'))).toBeNull();
    expect(renderBlock(null)).toBeNull();
  });

  it('the re-render count is what a click queues: the live missing list, once the render is over or waits without a stop (F7, review M2)', () => {
    const out = { ...base, failedPanelIds: ['pn_a'] };
    const missing = ['pn_a', 'pn_c', 'pn_z'];
    expect(rerenderCount(renderRun('done', out, 'done'), missing)).toBe(3);
    expect(rerenderCount(renderRun('failed', out, 'failed'), missing)).toBe(3);
    expect(rerenderCount(renderRun('failed', null, 'failed'), missing)).toBe(3); // failed before writing an output
    expect(rerenderCount(renderRun('awaiting-review', out, 'awaiting-review'), missing)).toBe(3);
    expect(rerenderCount(renderRun('done', out, 'done'), undefined)).toBe(0);
    expect(rerenderCount(renderRun('done', out, 'done'), [])).toBe(0);
    // A stop: the panels without an image were never attempted; Continue renders them.
    expect(rerenderCount(renderRun('awaiting-review', { ...out, preview: true, remainingPanels: 9, estimateSeconds: 60 }, 'awaiting-review'), missing)).toBe(0);
    expect(rerenderCount(renderRun('running', out), missing)).toBe(0);
    expect(rerenderCount(renderRun('paused', out, 'paused'), missing)).toBe(0);
    expect(rerenderCount(renderRun('pending', out), missing)).toBe(0);
  });

  it('a click that queued nothing says so (review M4)', () => {
    expect(renderMissingNotice([])).toBe('Nothing to render: those panels are already queued');
    expect(renderMissingNotice([{ jobId: 'jb_1' }])).toBeNull();
  });
});
