import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { exportTargetType } from '../src/commands/export.js';
import { formatRun, runLine } from '../src/episode-format.js';
import { followRun } from '../src/follow.js';

const T = '2026-09-27T10:11:12.000Z';
function run(status: EpisodeRun['status'], currentStep: number, stepStatus: EpisodeRun['steps'][number]['status'] = 'running'): EpisodeRun {
  return {
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode: 'review', currentStep, status,
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < currentStep ? 'done' : i === currentStep ? stepStatus : 'pending', output: null,
      error: i === currentStep && stepStatus === 'failed' ? 'model overloaded' : null, startedAt: i <= currentStep ? T : null, finishedAt: i < currentStep ? T : null,
    })),
    createdAt: T, updatedAt: T,
  };
}

describe('episode formatting', () => {
  it('prints a header and one row per step', () => {
    const text = formatRun(run('failed', 2, 'failed'));
    const lines = text.split('\n');
    expect(lines[0]).toBe('er_1  failed  review');
    expect(lines[1]).toMatch(/^#\s+step\s+status\s+started\s+finished\s+error$/);
    expect(lines[2]).toMatch(/^1\s+premise\s+done\s+10:11:12\s+10:11:12/);
    expect(lines[4]).toMatch(/^3\s+breakdown\s+failed <\s+10:11:12\s+-\s+model overloaded$/);
    expect(lines).toHaveLength(9);
  });

  it('summarises the current step in one line', () => {
    expect(runLine(run('awaiting-review', 1, 'awaiting-review'))).toBe('awaiting-review: outline awaiting-review');
  });

  it('classifies export targets', () => {
    expect(exportTargetType('pg_abc')).toBe('page');
    expect(exportTargetType('ch_abc')).toBe('chapter');
    expect(exportTargetType('My Manga/2')).toBe('chapter');
  });
});

describe('followRun', () => {
  it('polls until the run stops, reporting each change once', async () => {
    const sequence = [run('running', 0), run('running', 0), run('running', 1), run('awaiting-review', 1, 'awaiting-review')];
    const api = { get: async <T>(): Promise<T> => sequence.shift() as T };
    const seen: string[] = [];
    const sleeps: number[] = [];
    const final = await followRun(api, 'ch_1', { intervalMs: 5, onChange: (r) => seen.push(runLine(r)), sleep: async (ms) => { sleeps.push(ms); } });
    expect(final.status).toBe('awaiting-review');
    expect(seen).toEqual(['running: premise running', 'running: outline running', 'awaiting-review: outline awaiting-review']);
    expect(sleeps).toEqual([5, 5, 5]);
  });

  it('throws when the chapter has no episode run', async () => {
    const api = { get: async <T>(): Promise<T> => null as T };
    await expect(followRun(api, 'ch_1', { sleep: async () => undefined })).rejects.toThrow('chapter ch_1 has no episode run');
  });

  it('returns the unsettled run at once when the signal aborts during the default sleep, leaving no timer', async () => {
    const api = { get: async <T>(): Promise<T> => run('running', 0) as T };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const final = await followRun(api, 'ch_1', { intervalMs: 60_000, signal: controller.signal });
    expect(final.status).toBe('running');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not poll again after an abort, and stops before sleeping when already aborted', async () => {
    let gets = 0;
    const api = { get: async <T>(): Promise<T> => { gets += 1; return run('running', 0) as T; } };
    const controller = new AbortController();
    controller.abort();
    const sleeps: number[] = [];
    const final = await followRun(api, 'ch_1', { signal: controller.signal, sleep: async (ms) => { sleeps.push(ms); } });
    expect(final.status).toBe('running');
    expect([gets, sleeps]).toEqual([1, []]);
  });
});
