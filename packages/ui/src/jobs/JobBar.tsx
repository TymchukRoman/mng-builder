import type { JSX } from 'react';
import { useJobs } from '../queries';
import { StatusLoader } from '../ui/StatusLoader';
import { activeJobs, jobProgress, jobStatusLabel } from './jobView';
import './jobs.css';

const SHOWN = 3;

/** The editor footer: the first running or queued jobs as status loaders, the rest as a count with a tooltip. */
export function JobBar(): JSX.Element {
  const active = activeJobs(useJobs().data);
  const rest = active.slice(SHOWN);
  const more = rest.map(jobStatusLabel).join(', ');
  return (
    <footer className="job-bar" aria-label="Running jobs">
      {active.slice(0, SHOWN).map((j) => {
        const p = jobProgress(j);
        return <StatusLoader key={j.id} className="job-bar__item" label={jobStatusLabel(j)} value={p?.value} max={p?.max} />;
      })}
      {rest.length > 0 && <span className="job-bar__more" role="img" aria-label={more} data-tip={more} data-tip-side="top">+{rest.length}</span>}
    </footer>
  );
}
