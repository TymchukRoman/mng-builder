import { useContext, useId, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EPISODE_STEPS, type EpisodeRun, type EpisodeStepName } from '@manga/shared';
import { api, seg } from '../api';
import { HistoryBarrierContext, type Barrier } from '../editor/HistoryBarrierContext';
import { JsonForm } from '../episode/JsonForm';
import {
  STEP_LABEL, STEP_STATUS_TEXT, currentStepName, dirtySteps, editOf, isLive, parseDraft, rerunLabel, rerunStep, runLabel, saveThen,
  statusChipClass, stepActions, stepPlaceholder, toggleRaw, type StepEdit, type StepEdits,
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

/**
 * M4 slot (Contract E): the episode stepper. Renders nothing until the chapter has a run.
 * Drafts are kept per step until that step changes (its tab shows a dot). Continue and Run to end save the draft of the step
 * they approve first; drafts of other steps stay unsaved (and marked) until their own Save.
 */
export function EpisodePanel({ chapterId }: { chapterId: string }): JSX.Element | null {
  const qc = useQueryClient();
  const episode = useEpisode(chapterId);
  const run = episode.data ?? null;
  const barrier = useContext(HistoryBarrierContext) ?? direct;
  const uid = useId();
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<EpisodeStepName | null>(null);
  const [edits, setEdits] = useState<StepEdits>({});
  // Bumped when a save replaces a step's draft, so the form's fields re-read the stored output.
  const [formRev, setFormRev] = useState(0);
  const [confirmStep, setConfirmStep] = useState<EpisodeStepName | null>(null);

  // Continue, Run to end and Cancel unmount when the run stops being live; keep a keyboard user's focus in the panel.
  const live = run !== null && isLive(run);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const actionsFocused = useRef(false);
  useLayoutEffect(() => {
    if (live) return;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (actionsFocused.current && lost) chevronRef.current?.focus();
    actionsFocused.current = false;
  }, [live]);

  const act = useMutation({
    mutationFn: (a: Act) => a.call(),
    // Rejections are toasted by the app's MutationCache (main.tsx).
    onSuccess: (next, a) => {
      if (next === null) { setConfirmStep(a.step ?? null); return; }
      qc.setQueryData(qk.episode(chapterId), next);
      setConfirmStep(null);
      if (a.kind === 'save' && a.step) {
        const saved = a.step;
        setEdits(({ [saved]: _dropped, ...rest }) => rest); // show the output as the server stored it
        setFormRev((n) => n + 1);
      }
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
  const current = editOf(run, edits, selected);
  const setCurrent = (edit: StepEdit): void => setEdits((prev) => ({ ...prev, [selected]: edit }));
  const actions = stepActions(run, selected);
  const dirty = dirtySteps(run, edits);
  // The step Continue and Run to end approve: the one waiting for review.
  const waiting = run.status === 'awaiting-review' ? currentStepName(run) : null;
  const saveFirst = waiting !== null && dirty.has(waiting);
  const busy = act.isPending;
  const busyOn = (kind: ActKind): boolean => busy && act.variables?.kind === kind;
  const runPath = `/api/episodes/${seg(run.id)}`;
  const stepPath = (name: EpisodeStepName): string => `${runPath}/steps/${seg(name)}`;
  const tabId = (name: EpisodeStepName): string => `${uid}-tab-${name}`;
  const panelId = `${uid}-panel`;

  const save = (name: EpisodeStepName): Promise<EpisodeRun> => {
    const edit = editOf(run, edits, name);
    let output = edit.draft;
    if (edit.raw !== null) {
      const parsed = parseDraft(edit.raw);
      if (!parsed.ok) return Promise.reject(new Error(`Invalid JSON: ${parsed.error}`));
      output = parsed.value;
    }
    return api.put<EpisodeRun>(`${stepPath(name)}/output`, { output });
  };
  const moveOn = (path: string) => (): Promise<EpisodeRun> =>
    saveThen(saveFirst && waiting ? () => save(waiting) : null, () => api.post<EpisodeRun>(`${runPath}${path}`));
  const rerun = (name: EpisodeStepName, confirmed: boolean): Act => ({
    kind: 'rerun', step: name,
    call: async () => {
      const out = await rerunStep((confirm) => api.post<EpisodeRun>(`${stepPath(name)}/rerun`, { confirm }), confirmed, barrier);
      return out.kind === 'done' ? out.run : null;
    },
  });
  const onToggleRaw = (): void => {
    const next = toggleRaw(current);
    if (next.ok) setCurrent(next.edit);
    else pushToast('error', `Invalid JSON: ${next.error}`);
  };

  return (
    <section className={cx('episode', !open && 'is-collapsed')} data-testid="episode-panel" aria-label="Episode">
      <header className="episode__head">
        <IconButton ref={chevronRef} icon={open ? ChevronDown : ChevronRight} size="sm" label={open ? 'Collapse episode' : 'Expand episode'}
          aria-expanded={open} onClick={() => setOpen((o) => !o)} />
        <div data-testid="episode-status" className="episode__status">
          {run.status === 'running'
            ? <StatusLoader label={runLabel(run)} value={run.currentStep} max={EPISODE_STEPS.length} />
            : <span className={cx('status-chip', statusChipClass(run.status))}>{runLabel(run)}</span>}
        </div>
        <span className="spacer" />
        {live && (
          <div className="episode__actions" onFocus={() => { actionsFocused.current = true; }}
            onBlur={(e) => { if (e.target.isConnected) actionsFocused.current = false; }}>
            <IconButton icon={Play} size="sm" tone="primary" label={saveFirst ? 'Save and continue' : 'Continue'} disabled={!actions.approve || busy} busy={busyOn('approve')}
              onClick={() => act.mutate({ kind: 'approve', call: moveOn('/approve') })} />
            <IconButton icon={FastForward} size="sm" label={saveFirst ? 'Save and run to end' : 'Run to end'} disabled={!actions.autopilot || busy} busy={busyOn('autopilot')}
              onClick={() => act.mutate({ kind: 'autopilot', call: moveOn('/autopilot') })} />
            <IconButton icon={Square} size="sm" tone="danger" label="Cancel episode" disabled={!actions.cancel || busy} busy={busyOn('cancel')}
              onClick={() => act.mutate({ kind: 'cancel', call: () => api.post<EpisodeRun>(`${runPath}/cancel`) })} />
          </div>
        )}
      </header>
      {open && (
        <>
          <div className="episode__steps" role="tablist" aria-label="Episode steps">
            {run.steps.map((s) => {
              const Icon = STATUS_ICON[s.status];
              const unsaved = dirty.has(s.name);
              const tip = `${STEP_LABEL[s.name]}: ${STEP_STATUS_TEXT[s.status]}${unsaved ? ', unsaved changes' : ''}`;
              return (
                <button
                  key={s.name} id={tabId(s.name)} type="button" role="tab" aria-selected={s.name === selected} aria-controls={panelId}
                  aria-label={tip} data-tip={tip} className={cx('episode__step', `episode__step--${s.status}`, s.name === selected && 'is-on')}
                  onClick={() => setPicked(s.name)}
                >
                  <Icon size={14} className={s.status === 'running' ? 'spin' : undefined} aria-hidden />
                  <span>{STEP_LABEL[s.name]}</span>
                  {unsaved && <span className="episode__dot" aria-hidden />}
                </button>
              );
            })}
          </div>
          <div className="episode__body" id={panelId} role="tabpanel" aria-labelledby={tabId(selected)}>
            <div className="episode__tools">
              <IconButton icon={RotateCcw} size="sm" label={rerunLabel(run, selected)} disabled={!actions.rerun || busy} busy={busyOn('rerun')}
                onClick={() => act.mutate(rerun(selected, false))} />
              <IconButton icon={Braces} size="sm" label="Edit as JSON" active={current.raw !== null}
                disabled={!actions.edit} onClick={onToggleRaw} />
              <IconButton icon={Save} size="sm" tone="primary" label="Save changes" disabled={!dirty.has(selected) || busy} busy={busyOn('save')}
                onClick={() => act.mutate({ kind: 'save', step: selected, call: () => save(selected) })} />
            </div>
            {step?.error && <div className="episode__error" data-testid="episode-step-error"><ErrorState text={step.error} /></div>}
            {step && stepPlaceholder(step) !== null
              ? <p className="muted">{stepPlaceholder(step)}</p>
              : current.raw !== null
                ? <textarea className="textarea episode__json" aria-label="Step output as JSON" spellCheck={false} value={current.raw}
                    onChange={(e) => setCurrent({ ...current, raw: e.target.value })} />
                : saved !== null && (
                  <JsonForm key={`${current.key}:${formRev}`} value={current.draft} onChange={(draft) => setCurrent({ ...current, draft })}
                    readOnly={!actions.edit} label={STEP_LABEL[selected]} />
                )}
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
