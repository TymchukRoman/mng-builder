import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { Job, JobRef } from '@manga/shared';
import { api } from '../api';
import { waitForJob } from '../events';
import { jobProgress, jobStatusLabel } from '../jobs/jobView';
import { useJobs } from '../queries';
import { IconButton } from '../ui/IconButton';
import { Copy, Download, FileIcon, FileImage, Files, FileText, Play } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { Segmented } from '../ui/Segmented';
import { StatusLoader } from '../ui/StatusLoader';
import { errorText, pushToast } from '../ui/toasts';
import { defaultScope, exportFiles, exportProblem, exportRequest, fileName, type ExportChoice, type ExportTarget } from './exportView';

/**
 * PNG/PDF export of the current page or the whole chapter (spec §10). The popover starts POST /api/export, follows the job
 * live (the server reports "Rendering page n/N", "Merging the chapter PDF") and lists the files it wrote.
 */
export function ExportButton({ target, pageId = null }: { target: ExportTarget; pageId?: string | null }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ExportChoice>({ scope: defaultScope(target), format: 'pdf' });
  const [jobId, setJobId] = useState<string | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Between clicking and the POST answering there is no job id yet.
  const [starting, setStarting] = useState(false);
  const jobs = useJobs();
  const live = jobs.data?.find((j) => j.id === jobId);
  const progress = live ? jobProgress(live) : null;
  const request = exportRequest(choice, target, pageId);
  const running = starting || (jobId !== null && finished === null);
  const problem = exportProblem(finished);
  const runningRef = useRef(false);
  const openRef = useRef(false);
  useLayoutEffect(() => { runningRef.current = running; openRef.current = open; });

  // A finished export belongs to the choice that produced it: change the format, the scope or the page and the old files go.
  const requestKey = request ? `${request.target.type}:${request.target.id}:${request.format}` : '';
  useEffect(() => {
    if (runningRef.current) return;
    setFinished(null);
    setError(null);
    setJobId(null); // `running` is "has a job id and no result", so the id goes with the result
  }, [requestKey, choice.scope]);

  const start = async (): Promise<void> => {
    if (!request || running) return;
    setError(null);
    setFinished(null);
    setJobId(null);
    setStarting(true);
    try {
      const { jobId: id } = await api.post<JobRef>('/api/export', request);
      setJobId(id);
      const job = await waitForJob(id);
      setFinished(job);
      // Failures are toasted for every job (events.ts); a success needs a signal only when the popover is not showing it.
      if (job.status === 'succeeded' && !openRef.current) pushToast('info', 'Export finished');
    } catch (err) {
      setError(errorText(err));
      setJobId(null);
    } finally {
      setStarting(false);
    }
  };

  const copy = (path: string): void => {
    // `navigator.clipboard` is undefined outside secure contexts: the property read must fail inside the promise chain.
    Promise.resolve().then(() => navigator.clipboard.writeText(path)).catch((err: unknown) => pushToast('error', errorText(err)));
  };

  return (
    <>
      <IconButton ref={anchor} icon={Download} label="Export" active={open} disabled={target === null && pageId === null} onClick={() => setOpen((o) => !o)} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Export" align="end" className="export-pop">
        <div className="export-pop__body">
          <div className="row">
            <Segmented label="Format" value={choice.format} onChange={(format) => setChoice({ ...choice, format })}
              options={[{ value: 'pdf', label: 'PDF', icon: FileText }, { value: 'png', label: 'PNG', icon: FileImage }]} />
            <Segmented label="Scope" value={choice.scope} onChange={(scope) => setChoice({ ...choice, scope })}
              options={[
                { value: 'page', label: 'Current page', icon: FileIcon },
                ...(target?.type === 'chapter' ? [{ value: 'chapter' as const, label: 'Whole chapter', icon: Files }] : []),
              ]} />
            <span className="spacer" />
            <IconButton icon={Play} tone="primary" label="Start export" disabled={request === null} busy={running} onClick={() => void start()} />
          </div>
          {running && (
            <StatusLoader label={live ? jobStatusLabel(live) : 'Starting the export'} value={progress?.value} max={progress?.max} className="export-pop__status" />
          )}
          {problem && <p className="error-text export-pop__error" role="alert">{problem}</p>}
          {error && <p className="error-text export-pop__error" role="alert">{error}</p>}
          {exportFiles(finished).map((file) => (
            <div key={file} className="row export-pop__file" data-testid="export-file" data-path={file}>
              <span className="export-pop__name" data-tip={file}>{fileName(file)}</span>
              <IconButton icon={Copy} size="sm" label={`Copy path of ${fileName(file)}`} onClick={() => copy(file)} />
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
