import type { Job, JobKind, JobStatus } from '@manga/shared';

export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);

export function isActive(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** Running jobs first, then queued, each group oldest first. */
export function activeJobs(jobs: readonly Job[] | undefined): Job[] {
  return (jobs ?? []).filter(isActive).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

const KIND_LABEL: Record<JobKind, string> = {
  'image.generate': 'Generating image',
  'image.review': 'Reviewing image',
  'image.upscale': 'Upscaling image',
  'character.refs': 'Generating character sheet',
  'llm.step': 'Writing',
  'export.render': 'Exporting',
};

export function kindLabel(kind: JobKind): string {
  return KIND_LABEL[kind];
}

export function jobStatusLabel(job: Job): string {
  const kind = kindLabel(job.kind);
  switch (job.status) {
    case 'running': return job.progress?.label || kind;
    // preflight F9: a queued job with an error is a re-queued retry (the worker requeues on
    // failure up to maxAttempts), so show that instead of a plain "(queued)".
    case 'queued': return job.error ? `${kind}: retrying (${job.error})` : `${kind} (queued)`;
    case 'succeeded': return `${kind}: done`;
    case 'failed': return `${kind} failed${job.error ? `: ${job.error}` : ''}`;
    case 'cancelled': return `${kind}: cancelled`;
  }
}

export function jobProgress(job: Job): { value: number; max: number } | null {
  const p = job.progress;
  if (!p || p.value === undefined || p.max === undefined || p.max <= 0) return null;
  return { value: p.value, max: p.max };
}

function payloadField(job: Job, key: string): unknown {
  const p = job.payload;
  return typeof p === 'object' && p !== null ? (p as Record<string, unknown>)[key] : undefined;
}

/** image.generate {target:'panel'}, image.review and llm.step 'panel-prompt' all carry panelId. */
export function jobTargetsPanel(job: Job, panelId: string): boolean {
  return payloadField(job, 'panelId') === panelId;
}

export function jobTargetsCharacter(job: Job, characterId: string): boolean {
  return payloadField(job, 'characterId') === characterId;
}

export function isPortraitJob(job: Job): boolean {
  return payloadField(job, 'target') === 'character-portrait';
}
