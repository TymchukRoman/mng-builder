import { describe, expect, it } from 'vitest';
import { activeJobs, errorHeadline, isPortraitJob, jobProgress, jobStatusLabel, jobTargetsCharacter, jobTargetsPanel, kindLabel } from '../src/jobs/jobView';
import { makeJob } from './fixtures';

describe('jobView', () => {
  it('lists running jobs first, then queued, oldest first', () => {
    const jobs = [
      makeJob({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:02Z' }),
      makeJob({ id: 'b', status: 'succeeded' }),
      makeJob({ id: 'c', status: 'running', createdAt: '2026-01-01T00:00:03Z' }),
      makeJob({ id: 'd', status: 'queued', createdAt: '2026-01-01T00:00:01Z' }),
    ];
    expect(activeJobs(jobs).map((j) => j.id)).toEqual(['c', 'd', 'a']);
    expect(activeJobs(undefined)).toEqual([]);
  });
  it('labels jobs by status and progress', () => {
    expect(kindLabel('image.generate')).toBe('Generating image');
    expect(jobStatusLabel(makeJob({ status: 'running', progress: { label: 'Sampling 3/30', value: 3, max: 30 } }))).toBe('Sampling 3/30');
    expect(jobStatusLabel(makeJob({ status: 'running' }))).toBe('Generating image');
    expect(jobStatusLabel(makeJob({ status: 'queued' }))).toBe('Generating image (queued)');
    // preflight F9: a queued job with an error is a re-queued retry, not a plain wait.
    expect(jobStatusLabel(makeJob({ status: 'queued', error: 'ComfyUI down' }))).toBe('Generating image: retrying (ComfyUI down)');
    expect(jobStatusLabel(makeJob({ status: 'failed', error: 'ComfyUI down' }))).toBe('Generating image failed: ComfyUI down');
  });
  it('toasts and labels only the first line of an error (M4 final M4)', () => {
    const raw = 'scripts: the AI answer was not valid\n--- raw output ---\n{"pages": [' + 'x'.repeat(4000);
    expect(errorHeadline(raw)).toBe('scripts: the AI answer was not valid');
    expect(errorHeadline('\n  one line  ')).toBe('one line');
    expect(errorHeadline('')).toBe('');
    expect(jobStatusLabel(makeJob({ status: 'failed', kind: 'llm.step', error: raw }))).toBe('Writing failed: scripts: the AI answer was not valid');
    expect(jobStatusLabel(makeJob({ status: 'queued', error: 'busy\nmore' }))).toBe('Generating image: retrying (busy)');
  });
  it('extracts numeric progress only when both ends are known', () => {
    expect(jobProgress(makeJob({ progress: { label: 'x', value: 3, max: 30 } }))).toEqual({ value: 3, max: 30 });
    expect(jobProgress(makeJob({ progress: { label: 'x' } }))).toBeNull();
  });
  it('matches jobs to panels and characters by payload', () => {
    expect(jobTargetsPanel(makeJob(), 'pn_1')).toBe(true);
    expect(jobTargetsPanel(makeJob({ payload: null }), 'pn_1')).toBe(false);
    const portrait = makeJob({ payload: { target: 'character-portrait', characterId: 'cr_1' } });
    expect(jobTargetsCharacter(portrait, 'cr_1')).toBe(true);
    expect(isPortraitJob(portrait)).toBe(true);
    expect(isPortraitJob(makeJob())).toBe(false);
  });
});
