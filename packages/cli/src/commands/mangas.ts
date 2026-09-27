import type { Command } from 'commander';
import { readingOrder, STYLE_PRESETS, type Chapter, type Character, type Manga, type Page, type PageDetail, type StylePreset } from '@manga/shared';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';

interface EditOptions { title?: string; synopsis?: string; lang?: string; color?: string; dir?: string; style?: string }

function stylePreset(id: string): StylePreset {
  const preset = Object.hasOwn(STYLE_PRESETS, id) ? STYLE_PRESETS[id] : undefined;
  if (preset === undefined) throw new CliError(`unknown style preset "${id}"; presets are ${Object.keys(STYLE_PRESETS).join(', ')}`, 2);
  return preset;
}

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
    .option('--color <mode>', "bw or color (default: the style preset's)")
    .option('--dir <dir>', 'reading direction: rtl or ltr', 'rtl')
    .option('--style <preset>', `style preset: ${Object.keys(STYLE_PRESETS).join(', ')} (default manga-bw; anime-color with --color color)`)
    .option('--synopsis <text>', 'short synopsis', '')
    .action(async (title: string, opts: { lang: string; color?: string; dir: string; style?: string; synopsis: string }) => {
      const c = await ctx();
      const presetId = opts.style ?? (opts.color === 'color' ? 'anime-color' : 'manga-bw');
      const manga = await c.api.post<Manga>('/api/mangas', {
        title,
        synopsis: opts.synopsis,
        language: opts.lang,
        ...(opts.color === undefined ? {} : { colorMode: opts.color }),
        readingDirection: opts.dir,
        stylePreset: presetId,
      });
      const presetMode = Object.hasOwn(STYLE_PRESETS, presetId) ? STYLE_PRESETS[presetId]?.colorMode : undefined;
      if (presetMode !== undefined && presetMode !== manga.colorMode) {
        c.io.stderr(`warning: style ${presetId} is a ${presetMode} preset; keeping --color ${manga.colorMode}\n`);
      }
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
    .command('edit')
    .description('change a manga; only the options you pass are sent')
    .argument('<manga>', 'id or title')
    .option('--title <title>', 'title')
    .option('--synopsis <text>', 'synopsis')
    .option('--lang <lang>', 'en or uk')
    .option('--color <mode>', 'bw or color')
    .option('--dir <dir>', 'reading direction: rtl or ltr (mirrors every page, keeping the story order)')
    .option('--style <preset>', `style preset whose style guide to use: ${Object.keys(STYLE_PRESETS).join(', ')}`)
    .action(async (ref: string, opts: EditOptions) => {
      const patch: Record<string, unknown> = {};
      if (opts.title !== undefined) patch['title'] = opts.title;
      if (opts.synopsis !== undefined) patch['synopsis'] = opts.synopsis;
      if (opts.lang !== undefined) patch['language'] = opts.lang;
      if (opts.color !== undefined) patch['colorMode'] = opts.color;
      if (opts.dir !== undefined) patch['readingDirection'] = opts.dir;
      const preset = opts.style === undefined ? undefined : stylePreset(opts.style);
      if (preset !== undefined) patch['styleGuide'] = preset.styleGuide;
      if (Object.keys(patch).length === 0) throw new CliError('nothing to change; pass at least one option (see: manga edit --help)', 2);
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      const updated = await c.api.patch<Manga>(`/api/mangas/${manga.id}`, patch);
      if (preset !== undefined && preset.colorMode !== updated.colorMode) {
        c.io.stderr(`warning: style ${preset.id} is a ${preset.colorMode} preset but the manga is ${updated.colorMode}\n`);
      }
      c.out(updated, () => `updated ${describeManga(updated)}`);
    });

  program
    .command('cover')
    .description('create the cover page of a manga or of one of its chapters (an existing cover is returned as is)')
    .argument('<manga>', 'id or title')
    .option('--chapter <chapter>', 'the chapter: its number in this manga, its id, or <manga>/<number>')
    .action(async (ref: string, opts: { chapter?: string }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      let path = `/api/mangas/${manga.id}/cover`;
      if (opts.chapter !== undefined) {
        const chapter = await c.resolve.chapter(/^\d+$/.test(opts.chapter) ? `${manga.id}/${opts.chapter}` : opts.chapter);
        if (chapter.mangaId !== manga.id) throw new CliError(`chapter ${chapter.id} belongs to another manga`);
        path = `/api/chapters/${chapter.id}/cover`;
      }
      const detail = await c.api.post<PageDetail>(path);
      c.out(detail, () => `cover ${detail.page.id}  panel ${detail.panels.map((p) => p.id).join(' ')}`);
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
