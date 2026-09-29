import { useState, type JSX } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { CharactersTab } from '../characters/CharactersTab';
import { useManga } from '../queries';
import { BookOpen, Users } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { Tabs } from '../ui/Tabs';
import { errorText } from '../ui/toasts';
import { ChaptersTab } from './ChaptersTab';
import { MangaHeader } from './MangaHeader';
import { MangaSettingsDrawer } from './MangaSettingsDrawer';
import './manga.css';

type TabId = 'chapters' | 'characters';

// The header names the manga (its title is the page heading), so the top bar adds none (F16).
export function MangaPage(): JSX.Element {
  const { mangaId = '' } = useParams();
  const manga = useManga(mangaId);
  const [search, setSearch] = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tab: TabId = search.get('tab') === 'characters' ? 'characters' : 'chapters';

  if (manga.isPending) return <section className="screen"><StatusLoader label="Loading manga" /></section>;
  if (!manga.data) return <section className="screen"><p className="error-text">{errorText(manga.error)}</p></section>;
  const m = manga.data;
  return (
    <section className="screen">
      <MangaHeader manga={m} onOpenSettings={() => setSettingsOpen(true)} />
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
