import { useState, type FormEvent, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColorMode, Language, Manga, ReadingDirection } from '@manga/shared';
import { api } from '../api';
import { useStylePresets } from '../queries';
import { qk } from '../queryKeys';
import type { CreateMangaBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { ArrowLeft, ArrowRight, Check } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { Segmented } from '../ui/Segmented';
import { DEFAULT_PRESET_ID, presetColorMode, presetOptions } from './mangaList';

export function CreateMangaModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(manga: Manga): void }): JSX.Element {
  const presets = useStylePresets();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [colorMode, setColorMode] = useState<ColorMode>('bw');
  const [direction, setDirection] = useState<ReadingDirection>('rtl');
  const [preset, setPreset] = useState(DEFAULT_PRESET_ID);

  const create = useMutation({
    mutationFn: (body: CreateMangaBody) => api.post<Manga>('/api/mangas', body),
    onSuccess: (manga) => {
      void qc.invalidateQueries({ queryKey: qk.mangas() });
      setTitle('');
      onClose();
      onCreated(manga);
    },
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const t = title.trim();
    // colorMode is sent explicitly: the server applies the preset's own mode only when the field is omitted.
    if (t) create.mutate({ title: t, language, colorMode, readingDirection: direction, stylePreset: preset });
  };

  return (
    <Modal open={open} onClose={onClose} title="New manga">
      <form className="stack" onSubmit={submit}>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
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
        <div className="form-actions">
          <IconButton type="submit" icon={Check} tone="primary" label="Create manga" busy={create.isPending} disabled={!title.trim()} />
        </div>
      </form>
    </Modal>
  );
}
