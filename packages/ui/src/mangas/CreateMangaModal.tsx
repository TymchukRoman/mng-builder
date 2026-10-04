import { useState, type FormEvent, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AutoRun, ColorMode, Language, Manga, ReadingDirection } from '@manga/shared';
import { api } from '../api';
import { useStylePresets } from '../queries';
import { qk } from '../queryKeys';
import type { CreateMangaBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { ArrowLeft, ArrowRight, Check } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { Segmented } from '../ui/Segmented';
import { EMPTY_AUTO_DRAFT, toAutoInput, type AutoMangaDraft } from './autoManga';
import { AutoBrief, AutoMangaFields } from './AutoMangaFields';
import { DEFAULT_PRESET_ID, presetColorMode, presetOptions } from './mangaList';

type Mode = 'manual' | 'auto';

export function CreateMangaModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(mangaId: string): void }): JSX.Element {
  const presets = useStylePresets();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [colorMode, setColorMode] = useState<ColorMode>('bw');
  const [direction, setDirection] = useState<ReadingDirection>('rtl');
  const [preset, setPreset] = useState(DEFAULT_PRESET_ID);
  const [mode, setMode] = useState<Mode>('manual');
  const [auto, setAuto] = useState<AutoMangaDraft>(EMPTY_AUTO_DRAFT);
  const setDraft = (patch: Partial<AutoMangaDraft>): void => setAuto((d) => ({ ...d, ...patch }));

  const create = useMutation({
    mutationFn: (body: CreateMangaBody) => api.post<Manga>('/api/mangas', body),
    onSuccess: (manga) => {
      void qc.invalidateQueries({ queryKey: qk.mangas() });
      setTitle('');
      onClose();
      onCreated(manga.id);
    },
  });
  // "From a prompt": the server makes the manga at once and keeps writing it; the manga page shows how far it is.
  const createAuto = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof toAutoInput>>) => api.post<AutoRun>('/api/auto-mangas', body),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: qk.mangas() });
      setTitle('');
      setAuto(EMPTY_AUTO_DRAFT);
      onClose();
      onCreated(run.mangaId);
    },
  });
  const autoBody = toAutoInput(auto, { title, language, colorMode, direction, preset });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const t = title.trim();
    // colorMode is sent explicitly: the server applies the preset's own mode only when the field is omitted.
    if (mode === 'auto') {
      if (autoBody) createAuto.mutate(autoBody);
    } else if (t) {
      create.mutate({ title: t, language, colorMode, readingDirection: direction, stylePreset: preset });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New manga">
      <form className="stack" onSubmit={submit}>
        <Segmented<Mode> label="How to start" value={mode} onChange={setMode}
          options={[{ value: 'manual', label: 'Empty manga' }, { value: 'auto', label: 'From a prompt' }]} />
        {mode === 'auto' && <AutoBrief value={auto} set={setDraft} />}
        <Field label={mode === 'auto' ? 'Title (optional)' : 'Title'}>
          <input className="input" value={title} placeholder={mode === 'auto' ? 'From the plot' : undefined} onChange={(e) => setTitle(e.target.value)} data-autofocus={mode === 'manual' ? true : undefined} />
        </Field>
        <div className="form-row">
          <Field label="Language" group>
            <Segmented<Language> label="Language" value={language} onChange={setLanguage}
              options={[{ value: 'en', label: 'English' }, { value: 'uk', label: 'Українська' }]} />
          </Field>
          <Field label="Reading direction" group>
            <Segmented<ReadingDirection> label="Reading direction" value={direction} onChange={setDirection}
              options={[{ value: 'rtl', label: 'Right to left', icon: ArrowLeft }, { value: 'ltr', label: 'Left to right', icon: ArrowRight }]} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Style preset">
            <select className="select" value={preset} onChange={(e) => {
              setPreset(e.target.value);
              const mode = presetColorMode(presets.data, e.target.value);
              if (mode) setColorMode(mode);
            }}>
              {presetOptions(presets.data).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Colour" group>
            <Segmented<ColorMode> label="Colour" value={colorMode} onChange={setColorMode}
              options={[{ value: 'bw', label: 'B&W' }, { value: 'color', label: 'Colour' }]} />
          </Field>
        </div>
        {mode === 'auto' && <AutoMangaFields value={auto} set={setDraft} colorMode={colorMode} />}
        <div className="form-actions">
          <IconButton
            type="submit" icon={Check} tone="primary" label={mode === 'auto' ? 'Create manga from the prompt' : 'Create manga'}
            busy={create.isPending || createAuto.isPending} disabled={mode === 'auto' ? autoBody === null : !title.trim()}
          />
        </div>
      </form>
    </Modal>
  );
}
