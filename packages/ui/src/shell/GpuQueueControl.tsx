import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueueLanes, ServiceStatus } from '@manga/shared';
import { api } from '../api';
import { useStatus } from '../queries';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { Pause, Play } from '../ui/icons';
import { errorText, pushToast } from '../ui/toasts';
import { gpuPause, gpuPauseLabel } from './engineState';

/** The top bar chip while the GPU queue is paused (W1 R2); its tooltip is the reason. */
export function GpuPausedChip(): JSX.Element | null {
  const paused = gpuPause(useStatus().data);
  if (!paused) return null;
  return <span className="status-chip status-chip--paused topbar__gpu" role="status" data-tip={paused.reason}>{gpuPauseLabel(paused)}</span>;
}

/** The jobs popover's GPU queue row (W1 R2, F9): the pause chip, and Pause or Resume. The gpu lane holds images and the local AI engine. A manual pause is never lifted automatically. */
export function GpuQueueControl(): JSX.Element | null {
  const status = useStatus();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api.post<QueueLanes>(`/api/queue/gpu/${action}`),
    onSuccess: (lanes) => qc.setQueryData<ServiceStatus>(qk.status(), (prev) => (prev ? { ...prev, queue: { ...prev.queue, pausedLanes: lanes.pausedLanes } } : prev)),
    onError: (e) => pushToast('error', errorText(e)),
  });
  if (!status.data) return null;
  const paused = gpuPause(status.data);
  return (
    <div className="gpu-queue" data-testid="gpu-queue">
      {paused && <span className="status-chip status-chip--paused" data-tip={paused.reason}>{gpuPauseLabel(paused)}</span>}
      <span className="spacer" />
      <IconButton icon={paused ? Play : Pause} size="sm" label={paused ? 'Resume GPU queue' : 'Pause GPU queue (images and local AI)'} busy={toggle.isPending}
        onClick={() => toggle.mutate(paused ? 'resume' : 'pause')} />
    </div>
  );
}
