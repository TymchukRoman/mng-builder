import { useRef, useState, type JSX } from 'react';
import { activeJobs } from '../jobs/jobView';
import { useJobs } from '../queries';
import { IconButton } from '../ui/IconButton';
import { ListChecks, LoaderCircle } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { GpuQueueControl } from './GpuQueueControl';
import { JobRow } from './JobRow';

export function JobsIndicator(): JSX.Element {
  const jobs = useJobs();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = activeJobs(jobs.data);
  const recent = (jobs.data ?? []).slice(0, 20);
  return (
    <>
      <IconButton
        ref={ref}
        icon={active.length > 0 ? LoaderCircle : ListChecks}
        className={active.length > 0 ? 'jobs-indicator--busy' : undefined}
        label={active.length > 0 ? `${active.length} jobs running or queued` : 'Jobs'}
        badge={active.length}
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" label="Jobs" className="jobs-popover">
        <GpuQueueControl />
        {recent.length === 0 ? <p className="muted">No jobs yet</p> : <ul className="job-list">{recent.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
      </Popover>
    </>
  );
}
