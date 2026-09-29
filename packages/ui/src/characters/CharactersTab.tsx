import { useState, type JSX } from 'react';
import type { Manga } from '@manga/shared';
import { imageUrl } from '../api';
import { useCharacters } from '../queries';
import { Plus, UserRound } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { CharacterDrawer } from './CharacterDrawer';
import './characters.css';

export function CharactersTab({ manga }: { manga: Manga }): JSX.Element {
  const characters = useCharacters(manga.id);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  return (
    <div className="tab-body">
      {characters.error && <ErrorState error={characters.error} onRetry={() => void characters.refetch()} retrying={characters.isFetching} />}
      {characters.isPending ? <StatusLoader label="Loading characters" /> : (
        <div className="portrait-grid">
          {(characters.data ?? []).map((c) => (
            <button key={c.id} type="button" className="portrait-card" aria-label={`Edit ${c.name}`} onClick={() => setOpen(c.id)}>
              <span className="portrait-card__art">
                {c.refs.portrait ? <img src={imageUrl(c.refs.portrait)} alt="" /> : <UserRound size={32} strokeWidth={1.25} aria-hidden />}
              </span>
              <span className="portrait-card__name">{c.name}</span>
            </button>
          ))}
          <button type="button" className="portrait-card portrait-card--new" aria-label="New character" data-tip="New character" onClick={() => setOpen('new')}>
            <Plus size={24} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      )}
      <CharacterDrawer manga={manga} characterId={open} onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />
    </div>
  );
}
