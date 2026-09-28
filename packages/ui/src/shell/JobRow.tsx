import type { JSX } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Job } from '@manga/shared';
import { api } from '../api';
import { isActive, jobProgress, jobStatusLabel } from '../jobs/jobView';
import { IconButton } from '../ui/IconButton';
import { Ban, CircleCheck, CircleX } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';

export function JobRow({ job }: { job: Job }): JSX.Element {
  const cancel = useMutation({ mutationFn: () => api.post<Job>(`/api/jobs/${job.id}/cancel`) });
  const label = jobStatusLabel(job);
  const prog = jobProgress(job);
  if (isActive(job)) {
    return (
      <li className="job-row">
        <StatusLoader label={label} value={prog?.value} max={prog?.max} />
        <IconButton icon={Ban} size="sm" label="Cancel job" busy={cancel.isPending} onClick={() => cancel.mutate()} />
      </li>
    );
  }
  const Icon = job.status === 'succeeded' ? CircleCheck : job.status === 'failed' ? CircleX : Ban;
  return (
    <li className={`job-row job-row--${job.status}`}>
      <Icon size={14} aria-hidden className="job-row__icon" />
      <span className="job-row__label" data-tip={label}>{label}</span>
    </li>
  );
}
