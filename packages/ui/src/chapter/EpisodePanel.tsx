import { useContext, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EpisodeRun, EpisodeStepName } from '@manga/shared';
import { api, seg } from '../api';
import { HistoryBarrierContext, type Barrier } from '../editor/HistoryBarrierContext';
import { JsonForm } from '../episode/JsonForm';
import {
  STEP_LABEL, STEP_STATUS_TEXT, currentStepName, isDirty, isLive, parseDraft, rerunLabel, rerunStep, runLabel, stepActions,
} from '../episode/episodeView';
import '../episode/episode.css';
import { cx } from '../lib/cx';
import { useEpisode } from '../queries';
import { qk } from '../queryKeys';
import { ErrorState } from '../ui/ErrorState';
import { IconButton } from '../ui/IconButton';
import {
  Braces, ChevronDown, ChevronRight, Circle, CircleCheck, CirclePause, CircleX, FastForward, LoaderCircle, Play, RotateCcw, Save, Square, X,
} from '../ui/icons';
import { Modal } from '../ui/Modal';
import { StatusLoader } from '../ui/StatusLoader';
import { pushToast } from '../ui/toasts';

const STATUS_ICON = { pending: Circle, running: LoaderCircle, 'awaiting-review': CirclePause, done: CircleCheck, failed: CircleX } as const;

/** Outside a chapter editor there is no history to protect. */
const direct: Barrier = (fn) => fn();

type ActKind = 'approve' | 'autopilot' | 'cancel' | 'rerun' | 'save';
/** One call against the run. `null` means the re-run of `step` needs confirming first (it replaces the chapter's pages). */
interface Act { kind: ActKind; step?: EpisodeStepName; call(): Promise<EpisodeRun | null> }
/** The user's unsaved edit of one step's output; it belongs to `key` and is dropped when the step itself changes. */
interface StepEdit { key: string; draft: unknown; raw: string | null }

/** M4 slot (Contract E): the episode stepper. Renders nothing until the chapter has a run. */
export function EpisodePanel({ chapterId }: { chapterId: string }): JSX.Element | null {
  const qc = useQueryClient();
  const episode = useEpisode(chapterId);
  const run = episode.data ?? null;
  const barrier = useContext(HistoryBarrierContext) ?? direct;
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<EpisodeStepName | null>(null);
  const [edit, setEdit] = useState<StepEdit | null>(null);
  const [confirmStep, setConfirmStep] = useState<EpisodeStepName | null>(null);

  const act = useMutation({
    mutationFn: (a: Act) => a.call(),
    // Rejections are toasted by the app's MutationCache (main.tsx).
    onSuccess: (next, a) => {
      if (next === null) { setConfirmStep(a.step ?? null); return; }
      qc.setQueryData(qk.episode(chapterId), next);
      setConfirmStep(null);
      if (a.kind === 'save') setEdit(null); // show the output as the server stored it
    },
    onError: () => setConfirmStep(null),
  });

  if (!run) {
    if (!episode.error) return null;
    return (
      <section className="episode" data-testid="episode-panel" aria-label="Episode">
        <ErrorState error={episode.error} onRetry={() => void episode.refetch()} retrying={episode.isFetching} />
      </section>
    );
  }

  const selected = picked ?? currentStepName(run);
  const step = run.steps.find((s) => s.name === selected);
  const saved = step?.output ?? null;
  // A new status or token for the selected step (a refetch alone changes neither) drops the unsaved edit.
  const stepKey = `${run.id}:${selected}:${step?.status ?? ''}:${step?.startedAt ?? ''}:${step?.finishedAt ?? ''}`;
  const current: StepEdit = edit?.key === stepKey ? edit : { key: stepKey, draft: saved, raw: null };
  const actions = stepActions(run, selected);
  const dirty = actions.edit && isDirty(saved, current.draft, current.raw);
  const busy = act.isPending;
  const busyOn = (kind: ActKind): boolean => busy && act.variables?.kind === kind;
  const runPath = `/api/episodes/${seg(run.id)}`;
  const stepPath = (name: EpisodeStepName): string => `${runPath}/steps/${seg(name)}`;

  const save = (): Promise<EpisodeRun> => {
    let output = current.draft;
    if (current.raw !== null) {
      const parsed = parseDraft(current.raw);
      if (!parsed.ok) return Promise.reject(new Error(`Invalid JSON: ${parsed.error}`));
      output = parsed.value;
    }
    return api.put<EpisodeRun>(`${stepPath(selected)}/output`, { output });
  };
  /** Continue and Run to end save a pending edit first, so moving on never drops it. */
  const post = (path: string) => async (): Promise<EpisodeRun> => {
    if (dirty) await save();
    return api.post<EpisodeRun>(`${runPath}${path}`);
  };
  const rerun = (name: EpisodeStepName, confirmed: boolean): Act => ({
    kind: 'rerun', step: name,
    call: async () => {
      const out = await rerunStep((confirm) => api.post<EpisodeRun>(`${stepPath(name)}/rerun`, { confirm }), confirmed, barrier);
      return out.kind === 'done' ? out.run : null;
    },
  });
  const toggleRaw = (): void => {
    if (current.raw === null) { setEdit({ ...current, raw: JSON.stringify(current.draft, null, 2) }); return; }
    const parsed = parseDraft(current.raw);
    if (parsed.ok) setEdit({ ...current, draft: parsed.value, raw: null });
    else pushToast('error', `Invalid JSON: ${parsed.error}`);
  };

  return (
    <section className={cx('episode', !open && 'is-collapsed')} data-testid="episode-panel" aria-label="Episode">
      <header className="episode__head">
        <IconButton icon={open ? ChevronDown : ChevronRight} size="sm" label={open ? 'Collapse episode' : 'Expand episode'} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
        {run.status === 'running'
          ? <span data-testid="episode-status" className="episode__status"><StatusLoader label={runLabel(run)} /></span>
          : <span data-testid="episode-status" className={cx('status-chip', 'episode__status', `episode__status--${run.status}`)}>{runLabel(run)}</span>}
        <span className="spacer" />
        {isLive(run) && (
          <>
            <IconButton icon={Play} size="sm" tone="primary" label={dirty ? 'Save and continue' : 'Continue'} disabled={!actions.approve || busy} busy={busyOn('approve')}
              onClick={() => act.mutate({ kind: 'approve', call: post('/approve') })} />
            <IconButton icon={FastForward} size="sm" label={dirty ? 'Save and run to end' : 'Run to end'} disabled={!actions.autopilot || busy} busy={busyOn('autopilot')}
              onClick={() => act.mutate({ kind: 'autopilot', call: post('/autopilot') })} />
            <IconButton icon={Square} size="sm" tone="danger" label="Cancel episode" disabled={!actions.cancel || busy} busy={busyOn('cancel')}
              onClick={() => act.mutate({ kind: 'cancel', call: () => api.post<EpisodeRun>(`${runPath}/cancel`) })} />
          </>
        )}
      </header>
      {open && (
        <>
          <ol className="episode__steps" role="tablist" aria-label="Episode steps">
            {run.steps.map((s) => {
              const Icon = STATUS_ICON[s.status];
              const tip = `${STEP_LABEL[s.name]}: ${STEP_STATUS_TEXT[s.status]}`;
              return (
                <li key={s.name}>
                  <button
                    type="button" role="tab" aria-selected={s.name === selected} aria-label={tip} data-tip={tip}
                    className={cx('episode__step', `episode__step--${s.status}`, s.name === selected && 'is-on')}
                    onClick={() => setPicked(s.name)}
                  >
                    <Icon size={14} className={s.status === 'running' ? 'spin' : undefined} aria-hidden />
                    <span>{STEP_LABEL[s.name]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="episode__body" role="tabpanel" aria-label={STEP_LABEL[selected]}>
            <div className="episode__tools">
              <IconButton icon={RotateCcw} size="sm" label={rerunLabel(run, selected)} disabled={!actions.rerun || busy} busy={busyOn('rerun')}
                onClick={() => act.mutate(rerun(selected, false))} />
              <IconButton icon={Braces} size="sm" label={current.raw === null ? 'Edit as JSON' : 'Edit as form'} active={current.raw !== null}
                disabled={!actions.edit} onClick={toggleRaw} />
              <IconButton icon={Save} size="sm" tone="primary" label="Save changes" disabled={!dirty || busy} busy={busyOn('save')}
                onClick={() => act.mutate({ kind: 'save', call: save })} />
            </div>
            {step?.error && <div className="episode__error" data-testid="episode-step-error"><ErrorState text={step.error} /></div>}
            {saved === null && (step?.status === 'pending' || step?.status === 'running')
              ? <p className="muted">{step.status === 'running' ? 'Working…' : 'Not run yet'}</p>
              : current.raw !== null
                ? <textarea className="textarea episode__json" aria-label="Step output as JSON" spellCheck={false} value={current.raw}
                    onChange={(e) => setEdit({ ...current, raw: e.target.value })} />
                : saved !== null && <JsonForm value={current.draft} onChange={(draft) => setEdit({ ...current, draft })} readOnly={!actions.edit} label={STEP_LABEL[selected]} />}
          </div>
        </>
      )}
      <Modal open={confirmStep !== null} onClose={() => setConfirmStep(null)} title={`Re-run ${STEP_LABEL[confirmStep ?? selected].toLowerCase()}?`}>
        <p>Replaces the chapter's pages, including editor changes.</p>
        <div className="form-actions">
          <IconButton icon={X} label="Keep the pages" data-autofocus onClick={() => setConfirmStep(null)} />
          <IconButton icon={RotateCcw} tone="danger" label="Re-run and replace the pages" busy={busyOn('rerun')}
            onClick={() => { if (confirmStep) act.mutate(rerun(confirmStep, true)); }} />
        </div>
      </Modal>
    </section>
  );
}
