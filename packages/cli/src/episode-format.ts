import type { EpisodeRun } from '@manga/shared';
import { table } from './format.js';

const clock = (iso: string | null): string => (iso ? iso.slice(11, 19) : '-');

/** Header line (id, status, mode) and a step table; "<" marks the current step of an unfinished run. */
export function formatRun(run: EpisodeRun): string {
  const rows = run.steps.map((s, i) => [
    String(i + 1), s.name, `${s.status}${i === run.currentStep && run.status !== 'done' ? ' <' : ''}`,
    clock(s.startedAt), clock(s.finishedAt), s.error ?? '',
  ]);
  return `${run.id}  ${run.status}  ${run.mode}\n${table(rows, ['#', 'step', 'status', 'started', 'finished', 'error'])}`;
}

export function runLine(run: EpisodeRun): string {
  const step = run.steps[run.currentStep];
  return `${run.status}: ${step ? `${step.name} ${step.status}` : '-'}`;
}
