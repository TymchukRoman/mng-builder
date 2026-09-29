import { useState, type CSSProperties, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useMangas } from '../queries';
import { Plus } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { CreateMangaModal } from './CreateMangaModal';
import { MangaCard } from './MangaCard';
import { COVER_H, COVER_W, sortMangas } from './mangaList';
import './mangas.css';

// The grid reads the cover size from these two custom properties, so the "new manga" card lines up with real covers.
const GRID_VARS = { '--cover-w': `${COVER_W}px`, '--cover-h': `${COVER_H}px` } as CSSProperties;

// No page heading: the top bar's logo ("All manga") already names this screen (F16).
export function MangaListPage(): JSX.Element {
  const mangas = useMangas();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  return (
    <section className="screen" aria-label="All manga">
      {mangas.isPending && <StatusLoader label="Loading manga" />}
      {mangas.error && <ErrorState error={mangas.error} onRetry={() => void mangas.refetch()} retrying={mangas.isFetching} />}
      {/* The "+" card stays on the error path: creating a manga does not need the list. */}
      {!mangas.isPending && (
        <div className="cover-grid" style={GRID_VARS}>
          {sortMangas(mangas.data ?? []).map((m) => <MangaCard key={m.id} manga={m} />)}
          <button type="button" className="cover-card cover-card--new" aria-label="New manga" data-tip="New manga" onClick={() => setCreating(true)}>
            <Plus size={28} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      )}
      <CreateMangaModal open={creating} onClose={() => setCreating(false)} onCreated={(m) => navigate(`/m/${m.id}`)} />
    </section>
  );
}
