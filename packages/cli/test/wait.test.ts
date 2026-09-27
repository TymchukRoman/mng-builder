import { describe, expect, it } from 'vitest';
import type { Job } from '@manga/shared';
import { jobLine } from '../src/commands/jobs.js';
import { progressText } from '../src/wait.js';

const job = (over: Partial<Job>): Job => ({
  id: 'jb_aaaaaaaaaa', kind: 'image.generate', lane: 'gpu', status: 'running', priority: 0, payload: {}, result: null, error: null,
  attempts: 1, maxAttempts: 3, nextRunAt: '2026-09-27T00:00:00.000Z', progress: null, episodeRunId: null,
  createdAt: '2026-09-27T00:00:00.000Z', startedAt: null, finishedAt: null, ...over,
});

describe('progressText', () => {
  it('shows progress while running and the error of a failed job', () => {
    expect(progressText(job({ progress: { label: 'Sampling', value: 3, max: 20 } }))).toBe('Sampling 3/20');
    expect(progressText(job({ progress: { label: 'Loading' } }))).toBe('Loading');
    expect(progressText(job({ status: 'failed', error: 'out of memory' }))).toBe('error: out of memory');
    expect(progressText(job({ status: 'queued' }))).toBe('');
  });

  it('shows "retrying: <error>" instead of the stale progress of a job re-queued after a transient failure (F14)', () => {
    const retrying = job({ status: 'queued', error: 'ComfyUI not reachable', attempts: 1, progress: { label: 'Sampling', value: 12, max: 20 } });
    expect(progressText(retrying)).toBe('retrying: ComfyUI not reachable');
    expect(jobLine(retrying)).toBe('jb_aaaaaaaaaa  image.generate  gpu  queued  retrying: ComfyUI not reachable');
  });
});
