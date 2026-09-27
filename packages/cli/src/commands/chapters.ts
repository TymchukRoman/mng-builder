import type { Command } from 'commander';
import type { Chapter } from '@manga/shared';
import type { CliContext } from '../context.js';
import { table } from '../format.js';

export function registerChapterCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const chapter = program.command('chapter').description('chapters of a manga');

  chapter
    .command('add')
    .description('add a chapter (numbered after the last one)')
    .argument('<manga>', 'id or title')
    .argument('<title>')
    .option('--synopsis <text>', 'synopsis', '')
    .action(async (mangaRef: string, title: string, opts: { synopsis: string }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const created = await c.api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title, synopsis: opts.synopsis });
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
