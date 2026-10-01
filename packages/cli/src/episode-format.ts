import { gateText, type EpisodeRun } from '@manga/shared';
import { table } from './format.js';

const clock = (iso: string | null): string => (iso ? iso.slice(11, 19) : '-');

/** W1 F20: what a render stop asks, with how to answer it (Task 7 minor 1); null when the run is not at a stop. */
function gateLine(run: EpisodeRun): string | null {
  const gate = gateText(run);
  return gate ? `${gate} — manga episode approve ${run.chapterId}` : null;
}

/** Header line (id, status, mode) and a step table; "<" marks the current step of an unfinished run. */
export function formatRun(run: EpisodeRun): string {
  const rows = run.steps.map((s, i) => [
    String(i + 1), s.name, `${s.status}${i === run.currentStep && run.status !== 'done' ? ' <' : ''}`,
    clock(s.startedAt), clock(s.finishedAt), s.error ?? '',
  ]);
  const gate = gateLine(run);
  return `${run.id}  ${run.status}  ${run.mode}\n${table(rows, ['#', 'step', 'status', 'started', 'finished', 'error'])}${gate ? `\n${gate}` : ''}`;
}

export function runLine(run: EpisodeRun): string {
  const step = run.steps[run.currentStep];
  const gate = gateLine(run);
  if (gate) return `${run.status}: ${gate}`;
  return `${run.status}: ${step ? `${step.name} ${step.status}` : '-'}`;
}
