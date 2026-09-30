import { useEffect, useRef, useState, type JSX } from 'react';
import type { EpisodeRun } from '@manga/shared';
import { api } from '../api';
import '../episode/episode.css';
import { cx } from '../lib/cx';
import { useCharacters } from '../queries';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { FastForward, Sparkles, Users } from '../ui/icons';
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
  const characters = useCharacters(mangaId);
  const [value, setValue] = useState<AiChapterInput>(EMPTY_AI_INPUT);
  // The Pages field keeps what was typed (it may be empty or out of range mid-edit); the model only ever sees a clamped number.
  const [pagesText, setPagesText] = useState(String(EMPTY_AI_INPUT.pages));
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<AiChapterInput>): void => setValue((v) => ({ ...v, ...patch }));

  useEffect(() => { onChange(makeStart(value, (path, body) => api.post<EpisodeRun>(path, body))); }, [value, onChange]);

  // Opening the section (never the initial render: it starts closed, so the Title keeps the dialog's focus) moves to the prompt.
  useEffect(() => { if (value.open) promptRef.current?.focus(); }, [value.open]);

  const list = characters.data ?? [];
  return (
    <div className="ai-section" data-testid="ai-section">
      <IconButton
        icon={Sparkles} size="sm" label="Generate with AI" aria-expanded={value.open} className={cx(value.open && 'is-active')}
        onClick={() => set({ open: !value.open })}
      />
      {value.open && (
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
          </div>
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
      )}
    </div>
  );
}
