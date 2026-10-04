import { InvalidArgumentError, type Command } from 'commander';
import {
  AUTO_STAGES, IMAGE_MODELS, IMAGE_MODEL_IDS, STYLE_PRESETS, formatMangaEstimate, type AutoRun, type GalleryPageResult, type Manga, type Settings,
} from '@manga/shared';
import { collect, parsePositiveInt } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';

const enc = encodeURIComponent;
const POLL_MS = 2000;

/**
 * An image model id, or `-` for none (Settings' routing). Commander turns a parser's `null` into `true`, so `-` stays the
 * string "-" here and `modelValue` maps it to null where the value is used.
 */
export function parseModel(value: string): string {
  if (value !== '-' && !IMAGE_MODEL_IDS.includes(value)) throw new InvalidArgumentError(`expected one of: ${IMAGE_MODEL_IDS.join(', ')}, or - for Settings' routing`);
  return value;
}

/** The API's value for a parsed `--model`: `-` is null. */
export const modelValue = (value: string): string | null => (value === '-' ? null : value);

/** `--chapter-model 2=anima`, repeatable: the model of chapter 2 (`-` inherits the manga's). Returns the per-chapter list. */
export function parseChapterModels(values: readonly string[], chapters: number): Array<string | null> {
  const out: Array<string | null> = Array.from({ length: chapters }, () => null);
  for (const v of values) {
    const m = /^(\d+)=(.+)$/.exec(v);
    if (!m) throw new CliError(`--chapter-model "${v}": expected <chapter number>=<model>, e.g. 2=anima`, 2);
    const n = Number(m[1]);
    if (n < 1 || n > chapters) throw new CliError(`--chapter-model "${v}": the manga has ${chapters} chapters`, 2);
    try {
      out[n - 1] = modelValue(parseModel(m[2]!));
    } catch (err) {
      throw new CliError(`--chapter-model "${v}": ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  }
  return out;
}

export function runLine(run: AutoRun, manga?: Pick<Manga, 'title'>): string {
  const name = manga ? `${manga.title}  ` : '';
  const stage = run.stage === 'chapters' ? `chapter ${run.currentChapter + 1}/${run.chapterIds.length}` : run.stage;
  const state = run.status === 'running' ? stage : run.status === 'done' ? 'done' : `${run.status} at ${stage}`;
  return `${run.id}  ${name}${state}${run.error ? `  (${run.error})` : ''}`;
}

export function formatRun(run: AutoRun): string {
  const lines = [runLine(run), `manga  ${run.mangaId}`, `stage  ${AUTO_STAGES.map((s) => (s === run.stage ? `[${s}]` : s)).join(' > ')}`];
  if (run.plan) {
    lines.push(`plan   ${run.plan.title}: ${run.plan.chapters.length} chapters, ${run.plan.characters.length} characters`);
    run.chapterIds.forEach((id, i) => lines.push(`  #${i + 1}  ${id}  ${run.plan!.chapters[i]!.title}`));
    const unmet = run.plan.directives.filter((d) => d.status === 'unmet');
    lines.push(`details  ${run.plan.directives.length} understood${unmet.length > 0 ? `, ${unmet.length} not fully applied` : ''}`);
    for (const d of unmet) lines.push(`  ${d.id}  ${d.text}${d.note ? ` (${d.note})` : ''}`);
  }
  return lines.join('\n');
}

/** Polls the run until it stops running; prints a line to stderr when its stage or chapter changes. */
async function follow(c: CliContext, runId: string): Promise<AutoRun> {
  let last = '';
  for (;;) {
    const run = await c.api.get<AutoRun>(`/api/auto-runs/${enc(runId)}`);
    const key = `${run.status}:${run.stage}:${run.currentChapter}`;
    if (key !== last) {
      last = key;
      if (!c.json) c.io.stderr(`${runLine(run)}\n`);
    }
    if (run.status !== 'running' || c.io.signal?.aborted) return run;
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); c.io.signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, POLL_MS);
      c.io.signal?.addEventListener('abort', done, { once: true });
    });
  }
}

async function show(c: CliContext, run: AutoRun): Promise<void> {
  const final = c.wait ? await follow(c, run.id) : run;
  c.out(final, () => formatRun(final));
  if (c.wait && final.status === 'running') throw new CliError('interrupted: the manga is still being made; check it with "manga auto status"', 1);
  if (c.wait && (final.status === 'failed' || final.status === 'cancelled')) {
    throw new CliError(`auto run ${final.status}${final.error ? `: ${final.error}` : ''}`, 1);
  }
}

interface StartOptions {
  chapters: number; pages: number; title?: string; lang: string; color?: string; dir: string; style?: string; model?: string;
  chapterModel: string[]; poster: boolean;
}

export function registerAutoCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const auto = program.command('auto').description('Make a whole manga from one prompt: plan, cast, poster and every chapter');

  auto.command('start')
    .description('Create a manga from a brief (plot and notes in one text); with --wait, follow it until it is made')
    .argument('<brief>', 'plot AND notes, e.g. "A cat detective in Kyiv. Simplistic art style, short dialogue."')
    .option('--chapters <n>', 'number of chapters, 1-20', parsePositiveInt, 3)
    .option('--pages <n>', 'pages per chapter, 1-30', parsePositiveInt, 8)
    .option('--title <title>', 'the title (default: the plan names the manga)')
    .option('--lang <lang>', 'en or uk', 'en')
    .option('--color <mode>', "bw or color (default: the style preset's)")
    .option('--dir <dir>', 'reading direction: rtl or ltr', 'rtl')
    .option('--style <preset>', `style preset: ${Object.keys(STYLE_PRESETS).join(', ')}`)
    .option('--model <id>', `image model of the whole manga: ${IMAGE_MODEL_IDS.join(', ')} (default: Settings' routing)`, parseModel)
    .option('--chapter-model <n=id>', 'image model of one chapter, e.g. 2=anima (repeatable; - inherits the manga model)', collect, [] as string[])
    .option('--no-poster', 'skip the manga poster (chapter covers are always drawn)')
    .action(async (brief: string, opts: StartOptions) => {
      if (opts.chapters > 20) throw new CliError('--chapters: at most 20', 2);
      if (opts.pages > 30) throw new CliError('--pages: at most 30', 2);
      const chapterModels = parseChapterModels(opts.chapterModel, opts.chapters);
      const c = await ctx();
      const presetId = opts.style ?? (opts.color === 'color' ? 'anime-color' : 'manga-bw');
      const input = {
        brief, chapters: opts.chapters, pagesPerChapter: opts.pages, title: opts.title ?? '', language: opts.lang,
        ...(opts.color === undefined ? {} : { colorMode: opts.color }), readingDirection: opts.dir, stylePreset: presetId,
        imageModel: modelValue(opts.model ?? '-'), chapterModels, poster: opts.poster,
      };
      const run = await c.api.post<AutoRun>('/api/auto-mangas', { input });
      if (!c.json) {
        const settings = await c.api.get<Settings>('/api/settings');
        const colorMode = opts.color === 'bw' || opts.color === 'color' ? opts.color : STYLE_PRESETS[presetId]?.colorMode;
        c.io.stderr(`${formatMangaEstimate({ ...input, imageModel: input.imageModel }, settings, colorMode)}\n`);
      }
      await show(c, run);
    });

  const latest = async (c: CliContext, ref: string): Promise<AutoRun> => {
    const manga = await c.resolve.manga(ref);
    const run = await c.api.get<AutoRun | null>(`/api/mangas/${enc(manga.id)}/auto-run`);
    if (!run) throw new CliError(`${manga.title} was not made with "manga auto start"`);
    return run;
  };

  auto.command('status')
    .description('Show the auto run of a manga')
    .argument('<manga>', 'id or title')
    .action(async (ref: string) => {
      const c = await ctx();
      const run = await latest(c, ref);
      c.out(run, () => formatRun(run));
    });

  for (const [name, description] of [['cancel', 'Stop the auto run (what exists stays)'], ['resume', 'Run a failed or cancelled auto run again']] as const) {
    auto.command(name)
      .description(description)
      .argument('<manga>', 'id or title')
      .action(async (ref: string) => {
        const c = await ctx();
        const run = await latest(c, ref);
        await show(c, await c.api.post<AutoRun>(`/api/auto-runs/${enc(run.id)}/${name}`));
      });
  }

  program.command('models')
    .description('List the image models a manga or chapter can use (--model on create, edit, chapter add|edit and auto start)')
    .action(async () => {
      const c = await ctx();
      const models = Object.values(IMAGE_MODELS);
      c.out(models, () => table(models.map((m) => [m.id, m.label, m.usesReferences ? 'references' : 'tags only', m.summary])));
    });

  program.command('gallery')
    .description('List the images that exist (not deleted), newest first')
    .option('--manga <manga>', 'only this manga: id or title')
    .option('--source <source>', 'generated (default), upscaled, uploaded or all', 'generated')
    .option('--owner <type>', 'panel or character')
    .option('--limit <n>', 'how many, 1-200', parsePositiveInt, 30)
    .action(async (opts: { manga?: string; source: string; owner?: string; limit: number }) => {
      const c = await ctx();
      const query = new URLSearchParams({ source: opts.source, limit: String(opts.limit) });
      if (opts.manga !== undefined) query.set('mangaId', (await c.resolve.manga(opts.manga)).id);
      if (opts.owner !== undefined) query.set('ownerType', opts.owner);
      const page = await c.api.get<GalleryPageResult>(`/api/gallery?${query.toString()}`);
      c.out(page, () => (page.items.length === 0 ? 'no images' : `${table(page.items.map(({ image, mangaTitle, owner }) => [
        image.id, image.createdAt.slice(0, 16).replace('T', ' '), mangaTitle, owner.kind === 'panel' ? `panel ${owner.panelId}` : owner.kind === 'character' ? `character ${owner.name}` : 'missing owner',
        image.gen?.recipe ?? image.source,
      ]))}\n${page.items.length} of ${page.total}`));
    });
}
