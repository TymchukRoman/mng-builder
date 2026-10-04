import type { Command } from 'commander';
import type { Chapter, JobRef } from '@manga/shared';
import { parsePositiveInt } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';
import { modelValue, parseModel } from './auto.js';
import { jobLine } from './jobs.js';

export function registerChapterCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const chapter = program.command('chapter').description('chapters of a manga');

  chapter
    .command('add')
    .description('add a chapter (numbered after the last one)')
    .argument('<manga>', 'id or title')
    .argument('<title>', 'the title; "Untitled chapter" leaves it to the premise of a later "manga episode start"')
    .option('--synopsis <text>', 'synopsis', '')
    .option('--model <id>', "image model for this chapter's panels (see: manga models)", parseModel)
    .action(async (mangaRef: string, title: string, opts: { synopsis: string; model?: string }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const created = await c.api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title, synopsis: opts.synopsis, ...(opts.model === undefined ? {} : { imageModel: modelValue(opts.model) }) });
      c.out(created, () => `created ${created.id}  #${created.number}  ${created.title}`);
    });

  chapter
    .command('list')
    .description("list a manga's chapters")
    .argument('<manga>', 'id or title')
    .action(async (mangaRef: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const chapters = await c.api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`);
      c.out(chapters, () => (chapters.length === 0 ? 'no chapters yet' : table(chapters.map((ch) => [`#${ch.number}`, ch.id, ch.title, ch.status]))));
    });

  chapter
    .command('edit')
    .description('change a chapter; only the options you pass are sent')
    .argument('<chapter>', 'id or <manga>/<number>')
    .option('--title <title>', 'title')
    .option('--synopsis <text>', 'synopsis')
    .option('--summary <text>', 'summary (later chapters read it)')
    .option('--number <n>', 'chapter number (must be free in the manga)', parsePositiveInt)
    .option('--model <id>', "image model for this chapter's panels (see: manga models); - uses the manga's", parseModel)
    .action(async (ref: string, opts: { title?: string; synopsis?: string; summary?: string; number?: number; model?: string }) => {
      const patch: Record<string, unknown> = {};
      if (opts.title !== undefined) patch['title'] = opts.title;
      if (opts.synopsis !== undefined) patch['synopsis'] = opts.synopsis;
      if (opts.summary !== undefined) patch['summary'] = opts.summary;
      if (opts.number !== undefined) patch['number'] = opts.number;
      if (opts.model !== undefined) patch['imageModel'] = modelValue(opts.model);
      if (Object.keys(patch).length === 0) throw new CliError('nothing to change; pass at least one option (see: manga chapter edit --help)', 2);
      const c = await ctx();
      const target = await c.resolve.chapter(ref);
      const updated = await c.api.patch<Chapter>(`/api/chapters/${target.id}`, patch);
      c.out(updated, () => `updated ${updated.id}  #${updated.number}  ${updated.title}`);
    });

  chapter
    .command('render-missing')
    // W1 R1. Task 7 minor 6: queued jobs wait while the GPU queue is paused, and --wait with them.
    .description('render every panel of the chapter that has no image; --wait waits for the jobs (also while the GPU queue is paused: see manga status)')
    .argument('<chapter>', 'id or <manga>/<number>')
    .action(async (ref: string) => {
      const c = await ctx();
      const target = await c.resolve.chapter(ref);
      const refs = await c.api.post<JobRef[]>(`/api/chapters/${encodeURIComponent(target.id)}/render-missing`);
      const jobIds = refs.map((r) => r.jobId);
      const none = 'no panels without an image';
      if (!c.wait) {
        c.out({ jobIds }, () => (jobIds.length === 0 ? none : jobIds.join('\n')));
        return;
      }
      const jobs = await c.waitJobs(jobIds); // [] at once when nothing was queued
      c.out(jobs, () => (jobs.length === 0 ? none : jobs.map(jobLine).join('\n')));
      const failed = jobs.filter((j) => j.status !== 'succeeded');
      if (failed.length > 0) throw new CliError(`${failed.length} job(s) did not succeed`, 1);
    });

  chapter
    .command('rm')
    .description('delete a chapter with its pages')
    .argument('<chapter>', 'id or <manga>/<number>')
    .action(async (ref: string) => {
      const c = await ctx();
      const target = await c.resolve.chapter(ref);
      await c.api.delete(`/api/chapters/${target.id}`);
      c.out({ ok: true, id: target.id }, () => `deleted ${target.id}  #${target.number}  ${target.title}`);
    });
}
