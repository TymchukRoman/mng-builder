import { useEffect, useRef, useState, type JSX } from 'react';
import { formatChapterEstimate, type EpisodeRun } from '@manga/shared';
import { api } from '../api';
import '../episode/episode.css';
import { cx } from '../lib/cx';
import { useCharacters, useSettings } from '../queries';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { FastForward, ScanEye, Sparkles, Users } from '../ui/icons';
import { EMPTY_AI_INPUT, makeStart, parsePages, toggleId, type AiChapterInput } from './aiSection';

export interface CreateChapterAiSectionProps {
  mangaId: string;
  /** Register the function that starts an episode for the new chapter, or null to create a plain chapter. */
  onChange(start: ((chapterId: string) => Promise<void>) | null): void;
}

/**
 * M4 slot (Contract E): the collapsible "Generate with AI" section of CreateChapterModal (spec §11).
 * It registers a `start` only while it is open and has a prompt; the modal calls it after the chapter exists.
 */
export function CreateChapterAiSection({ mangaId, onChange }: CreateChapterAiSectionProps): JSX.Element {
  // Loaded with the dialog, so the open section shows its characters and estimate at once.
  useCharacters(mangaId);
  useSettings();
  const [value, setValue] = useState<AiChapterInput>(EMPTY_AI_INPUT);
  const set = (patch: Partial<AiChapterInput>): void => setValue((v) => ({ ...v, ...patch }));

  useEffect(() => { onChange(makeStart(value, (path, body) => api.post<EpisodeRun>(path, body))); }, [value, onChange]);

  return (
    <div className="ai-section" data-testid="ai-section">
      <IconButton
        icon={Sparkles} size="sm" label="Generate with AI" aria-expanded={value.open} className={cx(value.open && 'is-active')}
        onClick={() => set({ open: !value.open })}
      />
      {value.open && <AiSectionBody mangaId={mangaId} value={value} set={set} />}
    </div>
  );
}

export interface AiSectionBodyProps {
  mangaId: string;
  value: AiChapterInput;
  set(patch: Partial<AiChapterInput>): void;
}

/** The open section: prompt, pages, tone, autopilot, the page 1 preview, the render estimate and the characters (W1 Q2, C2). */
export function AiSectionBody({ mangaId, value, set }: AiSectionBodyProps): JSX.Element {
  const characters = useCharacters(mangaId);
  const settings = useSettings();
  // The Pages field keeps what was typed (it may be empty or out of range mid-edit); the model only ever sees a clamped number.
  const [pagesText, setPagesText] = useState(String(value.pages));
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // The body mounts when the section opens (never on the dialog's first render: it starts closed, so the Title keeps the
  // dialog's focus): opening moves to the prompt.
  useEffect(() => { promptRef.current?.focus(); }, []);

  const list = characters.data ?? [];
  return (
    <div className="stack ai-section__body">
      <textarea
        ref={promptRef} className="textarea" rows={3} aria-label="Episode prompt" value={value.prompt}
        placeholder="What happens in this chapter?" onChange={(e) => set({ prompt: e.target.value })}
      />
      <div className="row ai-section__row">
        <Field label="Pages" inline>
          <input
            className="input ai-section__pages" type="number" inputMode="numeric" min={1} max={30} value={pagesText}
            onChange={(e) => { setPagesText(e.target.value); set({ pages: parsePages(e.target.value) }); }}
            onBlur={() => setPagesText(String(value.pages))}
          />
        </Field>
        <div className="ai-section__tone">
          <Field label="Tone" inline>
            <input className="input" value={value.tone} placeholder="optional" onChange={(e) => set({ tone: e.target.value })} />
          </Field>
        </div>
        <IconButton
          icon={FastForward} size="sm" active={value.autopilot} tipSide="top"
          label="Autopilot"
          onClick={() => set({ autopilot: !value.autopilot })}
        />
        <IconButton icon={ScanEye} size="sm" active={value.previewFirst} tipSide="top" label="Preview page 1 first"
          onClick={() => set({ previewFirst: !value.previewFirst })} />
      </div>
      {settings.data && <span className="ai-section__estimate" data-testid="ai-estimate">{formatChapterEstimate(value.pages, settings.data)}</span>}
      {list.length > 0 && (
        <div className="ai-section__chars" role="group" aria-label="Characters">
          <span className="ai-section__chars-icon" data-tip="Characters in this episode" data-tip-side="top"><Users size={14} aria-hidden /></span>
          {list.map((c) => {
            const on = value.characterIds.includes(c.id);
            return (
              <button
                key={c.id} type="button" aria-pressed={on} className={cx('ai-section__chip', on && 'is-on')}
                onClick={() => set({ characterIds: toggleId(value.characterIds, c.id) })}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
