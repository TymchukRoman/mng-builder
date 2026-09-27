import type { Chapter, Character, Manga, PageDetail, Panel, TextFrame } from '@manga/shared';
import type { ApiClient } from './client.js';
import { CliError } from './errors.js';

export interface Resolver {
  manga(ref: string): Promise<Manga>;                          // id, or unique case-insensitive title
  character(ref: string, mangaRef?: string): Promise<Character>;
  chapter(ref: string): Promise<Chapter>;                      // id, or '<mangaRef>/<number>'
  page(id: string): Promise<PageDetail>; panel(id: string): Promise<Panel>; frame(id: string): Promise<TextFrame>;
}

function pickOne<T>(matches: T[], what: string, ref: string): T {
  const [only, ...rest] = matches;
  if (only === undefined) throw new CliError(`no ${what} matches "${ref}"`);
  if (rest.length > 0) throw new CliError(`"${ref}" matches ${matches.length} ${what}s; use the id`);
  return only;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const enc = encodeURIComponent;

export function createResolver(api: ApiClient): Resolver {
  const resolver: Resolver = {
    async manga(ref) {
      if (ref.startsWith('mg_')) return api.get<Manga>(`/api/mangas/${enc(ref)}`);
      const all = await api.get<Manga[]>('/api/mangas');
      return pickOne(all.filter((m) => same(m.title, ref)), 'manga', ref);
    },

    async character(ref, mangaRef) {
      if (ref.startsWith('cr_')) return api.get<Character>(`/api/characters/${enc(ref)}`);
      const mangas = mangaRef === undefined ? await api.get<Manga[]>('/api/mangas') : [await resolver.manga(mangaRef)];
      const lists = await Promise.all(mangas.map((m) => api.get<Character[]>(`/api/mangas/${m.id}/characters`)));
      return pickOne(lists.flat().filter((c) => same(c.name, ref)), 'character', ref);
    },

    async chapter(ref) {
      if (ref.startsWith('ch_')) return api.get<Chapter>(`/api/chapters/${enc(ref)}`);
      const slash = ref.lastIndexOf('/');
      const number = Number(ref.slice(slash + 1));
      if (slash <= 0 || !Number.isInteger(number)) {
        throw new CliError(`a chapter is an id (ch_…) or <manga>/<number>, e.g. "Night Market/1"; got "${ref}"`, 2);
      }
      const manga = await resolver.manga(ref.slice(0, slash));
      const chapters = await api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`);
      return pickOne(chapters.filter((c) => c.number === number), 'chapter', ref);
    },

    page: (id) => api.get<PageDetail>(`/api/pages/${enc(id)}`),
    panel: (id) => api.get<Panel>(`/api/panels/${enc(id)}`),
    frame: (id) => api.get<TextFrame>(`/api/frames/${enc(id)}`),
  };
  return resolver;
}
