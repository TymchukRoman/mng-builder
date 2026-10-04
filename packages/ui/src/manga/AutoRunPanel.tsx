import type { JSX } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { AutoRun, Manga } from '@manga/shared';
import { api, seg } from '../api';
import { cx } from '../lib/cx';
import { useAutoRun } from '../queries';
import { IconButton } from '../ui/IconButton';
import { LoaderCircle, RefreshCw, Sparkles, X } from '../ui/icons';
import { errorText, pushToast } from '../ui/toasts';
import { runStatusText, showsRun, stageSteps } from './autoRun';

/** Where an auto-created manga is: the stages, the chapter being written, and Cancel / Retry. Nothing while there is no run to show. */
export function AutoRunPanel({ manga }: { manga: Manga }): JSX.Element | null {
  const run = useAutoRun(manga.id).data;
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'resume') => api.post<AutoRun>(`/api/auto-runs/${seg(run?.id)}/${action}`),
    onError: (err) => pushToast('error', errorText(err)),
  });
  if (!showsRun(run)) return null;
  const chapterId = run.status === 'running' && run.stage === 'chapters' ? run.chapterIds[run.currentChapter] : undefined;
  return (
    <section className={cx('auto-run', `auto-run--${run.status}`)} aria-label="Auto creation" data-testid="auto-run">
      <div className="auto-run__head">
        {run.status === 'running' ? <LoaderCircle className="spin" size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}
        <span className="auto-run__text" role="status">{runStatusText(run)}</span>
        {chapterId && <Link className="auto-run__link" to={`/m/${manga.id}/c/${chapterId}`}>Open chapter</Link>}
        {run.status === 'running' && <IconButton icon={X} size="sm" label="Cancel auto creation" busy={act.isPending} onClick={() => act.mutate('cancel')} />}
        {(run.status === 'failed' || run.status === 'cancelled') && <IconButton icon={RefreshCw} size="sm" tone="primary" label="Continue auto creation" busy={act.isPending} onClick={() => act.mutate('resume')} />}
      </div>
      <ol className="auto-run__steps">
        {stageSteps(run).map((s) => <li key={s.stage} className={cx('auto-run__step', `auto-run__step--${s.state}`)} aria-current={s.state === 'now' ? 'step' : undefined}>{s.label}</li>)}
      </ol>
    </section>
  );
}
