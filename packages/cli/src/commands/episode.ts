import { readFile } from 'node:fs/promises';
import { InvalidArgumentError, type Command } from 'commander';
import {
  EPISODE_STEPS, EpisodeStepNameSchema, formatChapterEstimate, type EpisodeRun, type EpisodeStepName, type Manga, type Settings,
} from '@manga/shared';
import { parseList } from '../args.js';
import { ApiError } from '../client.js';
import type { CliContext } from '../context.js';
import { formatRun, runLine } from '../episode-format.js';
import { CliError } from '../errors.js';
import { followRun, isSettled } from '../follow.js';

const enc = encodeURIComponent;

function parsePages(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 1 || n > 30) throw new InvalidArgumentError('expected a whole number from 1 to 30');
  return n;
}

function parseStep(value: string): EpisodeStepName {
  const parsed = EpisodeStepNameSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(`expected one of: ${EPISODE_STEPS.join(', ')}`);
  return parsed.data;
}

async function latestRun(c: CliContext, chapterId: string): Promise<EpisodeRun> {
  const run = await c.api.get<EpisodeRun | null>(`/api/chapters/${enc(chapterId)}/episode`);
  if (!run) throw new CliError(`chapter ${chapterId} has no episode run; start one with "manga episode start"`);
  return run;
}

/** The error of the step a stopped run ended on (else the first step that has one). */
function stepError(run: EpisodeRun): string | null {
  return run.steps[run.currentStep]?.error ?? run.steps.find((s) => s.error)?.error ?? null;
}

/**
 * Prints the run; with --wait, first follows it until it stops at a review point or ends. A run that ends `failed` or
 * `cancelled` under --wait exits 1 after printing (m4-rulings F17, the M2 F14 convention).
 */
async function show(c: CliContext, chapterId: string, run: EpisodeRun): Promise<void> {
  const final = c.wait
    ? await followRun(c.api, chapterId, {
      onChange: (r) => { if (!c.json) c.io.stderr(`${runLine(r)}\n`); },
      // M4 final M7: progress inside a step (the render estimate, n/m panels), on stderr unless --json.
      ...(c.json ? {} : { onProgress: (label: string) => c.io.stderr(`  ${label}\n`) }),
      ...(c.io.signal ? { signal: c.io.signal } : {}),
    })
    : run;
  c.out(final, () => formatRun(final));
  // An aborted follow (Ctrl+C through io.signal) is not a success: the run is still going on the server.
  if (c.wait && !isSettled(final)) {
    throw new CliError(`interrupted: episode still ${final.status}; check it with "manga episode status"`, 1);
  }
  if (c.wait && (final.status === 'failed' || final.status === 'cancelled')) {
    const error = stepError(final);
    throw new CliError(`episode ${final.status}${error ? `: ${error}` : ''}`, 1);
  }
}

export function registerEpisodeCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const episode = program.command('episode').description('Generate a chapter from one prompt, step by step (spec §8)');

  episode.command('start')
    .description('Start an episode run in an empty chapter')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .requiredOption('--prompt <text>', 'what happens in the chapter')
    .option('--pages <n>', 'number of pages, 1-30', parsePages, 8)
    .option('--chars <list>', 'characters to use: comma-separated names or ids', parseList)
    .option('--tone <text>', 'tone, e.g. "tense, melancholic"', '')
    // Task 7 minor 1: the render still stops at the preview in autopilot; say how to go on (and where --json shows it).
    .option('--autopilot', 'run every step without stopping at review points; the render still stops after page 1 unless --no-preview '
      + '(continue with "manga episode approve"; with --json, the render step output has "preview": true)')
    .option('--no-preview', 'render everything at once instead of stopping after page 1') // W1 Q2
    .action(async (chapterRef: string, opts: { prompt: string; pages: number; chars?: string[]; tone: string; autopilot?: boolean; preview: boolean }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const characterIds: string[] = [];
      for (const ref of opts.chars ?? []) characterIds.push((await c.resolve.character(ref, chapter.mangaId)).id);
      const run = await c.api.post<EpisodeRun>(`/api/chapters/${enc(chapter.id)}/episode`, {
        input: { prompt: opts.prompt, pages: opts.pages, characterIds, tone: opts.tone, previewFirst: opts.preview },
        mode: opts.autopilot ? 'autopilot' : 'review',
      });
      // W1 C2: the size of what started. Task 7 minor 4: only once the server accepted it. Task 2 M4: a black-and-white
      // book's estimate counts the bw refine pass.
      if (!c.json) {
        const [settings, manga] = await Promise.all([c.api.get<Settings>('/api/settings'), c.api.get<Manga>(`/api/mangas/${enc(chapter.mangaId)}`)]);
        c.io.stderr(`${formatChapterEstimate(opts.pages, settings, manga.colorMode)}\n`);
      }
      await show(c, chapter.id, run);
    });

  episode.command('status')
    .description('Show the steps of the latest run')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .action(async (chapterRef: string) => {
      const c = await ctx();
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      c.out(run, () => formatRun(run));
    });

  for (const [name, description] of [['approve', 'Accept the step waiting for review and continue'], ['autopilot', 'Run to the end without stopping']] as const) {
    episode.command(name)
      .description(description)
      .argument('<chapter>', 'chapter id or <manga>/<number>')
      .action(async (chapterRef: string) => {
        const c = await ctx();
        const chapter = await c.resolve.chapter(chapterRef);
        const run = await latestRun(c, chapter.id);
        await show(c, chapter.id, await c.api.post<EpisodeRun>(`/api/episodes/${enc(run.id)}/${name}`));
      });
  }

  for (const [name, description] of [['pause', 'Pause a rendering run (a running image finishes)'], ['resume', 'Resume a paused run']] as const) {
    episode.command(name)
      .description(description)
      .argument('<chapter>', 'chapter id or <manga>/<number>')
      .action(async (chapterRef: string) => {
        const c = await ctx();
        const chapter = await c.resolve.chapter(chapterRef);
        const run = await latestRun(c, chapter.id);
        await show(c, chapter.id, await c.api.post<EpisodeRun>(`/api/episodes/${enc(run.id)}/${name}`));
      });
  }

  episode.command('edit')
    .description('Replace a step output with the JSON in a file')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .argument('<step>', EPISODE_STEPS.join('|'), parseStep)
    .requiredOption('--file <path>', 'JSON file holding the new output of the step')
    .action(async (chapterRef: string, step: EpisodeStepName, opts: { file: string }) => {
      const c = await ctx();
      let output: unknown;
      try {
        output = JSON.parse(await readFile(opts.file, 'utf8'));
      } catch (err) {
        throw new CliError(`cannot read ${opts.file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      const next = await c.api.put<EpisodeRun>(`/api/episodes/${enc(run.id)}/steps/${step}/output`, { output });
      c.out(next, () => formatRun(next));
    });

  episode.command('rerun')
    .description('Run a step again, and every step after it')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .argument('<step>', EPISODE_STEPS.join('|'), parseStep)
    .option('--confirm', "allow replacing the chapter's pages")
    .action(async (chapterRef: string, step: EpisodeStepName, opts: { confirm?: boolean }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const run = await latestRun(c, chapter.id);
      let next: EpisodeRun;
      try {
        next = await c.api.post<EpisodeRun>(`/api/episodes/${enc(run.id)}/steps/${step}/rerun`, { confirm: opts.confirm === true });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'needs_confirm') {
          const removed = (err.details as { removedPanelIds?: string[] } | undefined)?.removedPanelIds ?? [];
          if (c.json) {
            c.io.stdout(`${JSON.stringify({ error: 'needs_confirm', removedPanelIds: removed }, null, 2)}
`);
            throw new CliError('needs confirmation', 1, true);
          }
          throw new CliError(`re-running ${step} replaces the chapter's pages (${removed.length} panels: ${removed.join(', ')}); add --confirm`);
        }
        throw err;
      }
      await show(c, chapter.id, next);
    });

  episode.command('cancel')
    .description('Cancel the running episode and its jobs')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .action(async (chapterRef: string) => {
      const c = await ctx();
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      const next = await c.api.post<EpisodeRun>(`/api/episodes/${enc(run.id)}/cancel`);
      c.out(next, () => formatRun(next));
    });
}
