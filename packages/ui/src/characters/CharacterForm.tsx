import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character } from '@manga/shared';
import { api, seg } from '../api';
import { randomSeed } from '../lib/seed';
import { useRecipes } from '../queries';
import { qk } from '../queryKeys';
import type { UpdateCharacterBody } from '../types';
import { AutoText } from '../ui/AutoText';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Dices } from '../ui/icons';
import { NumberField } from '../ui/NumberField';
import { Segmented } from '../ui/Segmented';
import { AppearanceField } from './AppearanceField';
import { characterRecipeOptions } from './characterModel';
import { ROLE_OPTIONS } from './NewCharacterForm';

export function CharacterForm({ character }: { character: Character }): JSX.Element {
  const qc = useQueryClient();
  const recipes = useRecipes();
  const patch = useMutation({
    mutationFn: (body: UpdateCharacterBody) => api.patch<Character>(`/api/characters/${seg(character.id)}`, body),
    onSuccess: (c) => { qc.setQueryData(qk.character(c.id), c); void qc.invalidateQueries({ queryKey: qk.characters(c.mangaId) }); },
  });
  const save = async (body: UpdateCharacterBody): Promise<void> => { await patch.mutateAsync(body); };

  return (
    <section className="drawer-section">
      <Field label="Name">
        <AutoText label="Name" value={character.name} onSave={(v) => (v.trim() ? save({ name: v.trim() }) : undefined)} />
      </Field>
      <Field label="Role" group>
        <Segmented<Character['role']> label="Role" value={character.role} options={ROLE_OPTIONS} onChange={(role) => patch.mutate({ role })} />
      </Field>
      <Field label="Personality"><AutoText multiline label="Personality" value={character.personality} onSave={(personality) => save({ personality })} /></Field>
      <Field label="Speech style"><AutoText multiline label="Speech style" value={character.speechStyle} onSave={(speechStyle) => save({ speechStyle })} /></Field>
      <AppearanceField character={character} onSave={(appearanceTags) => save({ appearanceTags })} />
      <div className="grid-2">
        <Field label="Recipe">
          <select className="select" value={character.recipe ?? ''} onChange={(e) => patch.mutate({ recipe: e.target.value || null })}>
            {characterRecipeOptions(recipes.data, character.recipe).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Seed" hint="Used for every portrait">
          <div className="row">
            <NumberField label="Seed" value={character.seed} min={0} integer onSave={(seed) => save({ seed })} />
            <IconButton icon={Dices} label="Random seed" onClick={() => patch.mutate({ seed: randomSeed() })} />
          </div>
        </Field>
      </div>
    </section>
  );
}
