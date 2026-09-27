import type { Command } from 'commander';
import { readingOrder, STYLE_PRESETS, type Chapter, type Character, type Manga, type Page } from '@manga/shared';
import type { CliContext } from '../context.js';
import { table } from '../format.js';

interface ShowData {
  manga: Manga;
  characters: Character[];
  chapters: Array<Chapter & { pages: Array<{ id: string; order: number; panelIds: string[] }> }>;
}

export function describeManga(m: Manga): string {
  return `${m.id}  ${m.title}  (${m.language}, ${m.colorMode}, ${m.readingDirection})`;
}

function formatShow(d: ShowData): string {
  const lines = [describeManga(d.manga)];
  if (d.manga.coverPageId !== null) lines.push(`cover       ${d.manga.coverPageId}`);
  lines.push(d.characters.length === 0 ? 'characters  none' : 'characters');
  for (const c of d.characters) lines.push(`  ${c.id}  ${c.name}  ${c.role}`);
  lines.push(d.chapters.length === 0 ? 'chapters    none' : 'chapters');
  for (const chapter of d.chapters) {
    lines.push(`  #${chapter.number}  ${chapter.id}  ${chapter.title}  ${chapter.status}`);
    for (const page of chapter.pages) lines.push(`      p${page.order + 1}  ${page.id}  ${page.panelIds.join(' ')}`);
  }
  return lines.join('\n');
}

export function registerMangaCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program
    .command('create')
    .description('create a manga')
    .argument('<title>')
    .option('--lang <lang>', 'en or uk', 'en')
    .option('--color <mode>', 'bw or color', 'bw')
    .option('--dir <dir>', 'reading direction: rtl or ltr', 'rtl')
    .option('--style <preset>', `style preset: ${Object.keys(STYLE_PRESETS).join(', ')} (default manga-bw; anime-color with --color color)`)
    .option('--synopsis <text>', 'short synopsis', '')
    .action(async (title: string, opts: { lang: string; color: string; dir: string; style?: string; synopsis: string }) => {
      const c = await ctx();
      const manga = await c.api.post<Manga>('/api/mangas', {
        title,
        synopsis: opts.synopsis,
        language: opts.lang,
        colorMode: opts.color,
        readingDirection: opts.dir,
        stylePreset: opts.style ?? (opts.color === 'color' ? 'anime-color' : 'manga-bw'),
      });
      c.out(manga, () => `created ${describeManga(manga)}`);
    });

  program
    .command('list')
    .description('list mangas')
    .action(async () => {
      const c = await ctx();
      const mangas = await c.api.get<Manga[]>('/api/mangas');
      c.out(mangas, () =>
        mangas.length === 0
          ? 'no mangas yet; create one with: manga create "<title>"'
          : table(mangas.map((m) => [m.id, m.title, m.language, m.colorMode, m.readingDirection])),
      );
    });

  program
    .command('show')
    .description('show a manga: characters, chapters, pages and panel ids in reading order')
    .argument('<manga>', 'id or title')
    .action(async (ref: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      const [characters, chapters] = await Promise.all([
        c.api.get<Character[]>(`/api/mangas/${manga.id}/characters`),
        c.api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`),
      ]);
      const withPages = await Promise.all(chapters.map(async (chapter) => {
        const pages = await c.api.get<Page[]>(`/api/chapters/${chapter.id}/pages`);
        return { ...chapter, pages: pages.map((p) => ({ id: p.id, order: p.order, panelIds: readingOrder(p.layout, manga.readingDirection) })) };
      }));
      const data: ShowData = { manga, characters, chapters: withPages };
      c.out(data, () => formatShow(data));
    });

  program
    .command('rm')
    .description('delete a manga and everything in it')
    .argument('<manga>', 'id or title')
    .action(async (ref: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      await c.api.delete(`/api/mangas/${manga.id}`);
      c.out({ ok: true, id: manga.id }, () => `deleted ${manga.id}  ${manga.title}`);
    });
}
