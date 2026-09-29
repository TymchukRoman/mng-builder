import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga } from '@manga/shared';
import { api, seg } from '../api';
import { useCharacter } from '../queries';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { Drawer } from '../ui/Drawer';
import { StatusLoader } from '../ui/StatusLoader';
import { CharacterForm } from './CharacterForm';
import { NewCharacterForm } from './NewCharacterForm';
import { PortraitVariants } from './PortraitVariants';
import { RefSlots } from './RefSlots';

export function CharacterDrawer({ manga, characterId, onClose, onCreated }: {
  manga: Manga; characterId: string | 'new' | null; onClose(): void; onCreated(id: string): void;
}): JSX.Element {
  const isNew = characterId === 'new';
  const character = useCharacter(isNew ? null : characterId);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/characters/${seg(id)}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.characters(manga.id) }); onClose(); },
  });
  const c = character.data;
  return (
    <Drawer
      open={characterId !== null}
      onClose={onClose}
      title={isNew ? 'New character' : c?.name ?? 'Character'}
      actions={!isNew && c ? <ConfirmIconButton label="Delete character" confirmLabel="Click again to delete this character" onConfirm={() => remove.mutate(c.id)} /> : undefined}
    >
      {isNew && <NewCharacterForm manga={manga} onCreated={onCreated} />}
      {!isNew && !c && <StatusLoader label="Loading character" />}
      {!isNew && c && (
        <>
          <CharacterForm key={`f-${c.id}`} character={c} />
          <PortraitVariants key={`p-${c.id}`} character={c} />
          <RefSlots key={`r-${c.id}`} character={c} />
        </>
      )}
    </Drawer>
  );
}
