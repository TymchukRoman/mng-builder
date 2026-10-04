import { useState, type JSX } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { CharactersTab } from '../characters/CharactersTab';
import { isId } from '../lib/ids';
import { useManga } from '../queries';
import { BookOpen, Users } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { Tabs } from '../ui/Tabs';
import { AutoRunPanel } from './AutoRunPanel';
import { ChaptersTab } from './ChaptersTab';
import { MangaHeader } from './MangaHeader';
import { MangaSettingsDrawer } from './MangaSettingsDrawer';
import './manga.css';

type TabId = 'chapters' | 'characters';

// The header names the manga (its title is the page heading), so the top bar adds none (F16).
export function MangaPage(): JSX.Element {
  const { mangaId } = useParams();
  const valid = isId(mangaId, 'mg'); // I1: a crafted id never reaches a request
  const manga = useManga(valid ? mangaId : undefined);
  const [search, setSearch] = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tab: TabId = search.get('tab') === 'characters' ? 'characters' : 'chapters';

  if (!valid) return <section className="screen"><ErrorState text="Not found" backTo="/" backLabel="All manga" /></section>;
  if (manga.isPending) return <section className="screen"><StatusLoader label="Loading manga" /></section>;
  if (!manga.data) {
    return <section className="screen"><ErrorState error={manga.error} onRetry={() => void manga.refetch()} retrying={manga.isFetching} backTo="/" backLabel="All manga" /></section>;
  }
  const m = manga.data;
  return (
    <section className="screen">
      <MangaHeader manga={m} onOpenSettings={() => setSettingsOpen(true)} />
      <AutoRunPanel manga={m} />
      <Tabs<TabId>
        label="Manga sections"
        items={[{ id: 'chapters', label: 'Chapters', icon: BookOpen }, { id: 'characters', label: 'Characters', icon: Users }]}
        value={tab}
        onChange={(id) => setSearch(id === 'chapters' ? {} : { tab: id }, { replace: true })}
      />
      {tab === 'chapters' ? <ChaptersTab manga={m} /> : <CharactersTab manga={m} />}
      <MangaSettingsDrawer manga={m} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </section>
  );
}
