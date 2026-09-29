import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character, Manga } from '@manga/shared';
import { api, seg } from '../api';
import { qk } from '../queryKeys';
import type { CreateCharacterBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Check } from '../ui/icons';
import { Segmented } from '../ui/Segmented';

export const ROLE_OPTIONS: Array<{ value: Character['role']; label: string }> = [
  { value: 'main', label: 'Main' }, { value: 'supporting', label: 'Supporting' }, { value: 'minor', label: 'Minor' },
];

export function NewCharacterForm({ manga, onCreated }: { manga: Manga; onCreated(id: string): void }): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Character['role']>('supporting');
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (body: CreateCharacterBody) => api.post<Character>(`/api/mangas/${seg(manga.id)}/characters`, body),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: qk.characters(manga.id) }); setName(''); onCreated(c.id); },
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); const n = name.trim(); if (n) create.mutate({ name: n, role }); }}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Role" group><Segmented<Character['role']> label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} /></Field>
      <div className="form-actions">
        <IconButton type="submit" icon={Check} tone="primary" label="Create character" busy={create.isPending} disabled={!name.trim()} />
      </div>
    </form>
  );
}
