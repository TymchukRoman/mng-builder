import type { Command } from 'commander';
import type { PageDetail } from '@manga/shared';
import type { CliContext } from '../context.js';

/** Spec §12 `manga text auto <page>`: added to M1's `text` group (created when absent, e.g. in tests). */
export function registerTextAutoCommand(program: Command, ctx: () => Promise<CliContext>): void {
  const text = program.commands.find((cmd) => cmd.name() === 'text') ?? program.command('text').description('Text frames');
  text.command('auto')
    .description('Place text frames for every dialogue line of the page that has none yet')
    .argument('<page>', 'page id')
    .action(async (pageRef: string) => {
      const c = await ctx();
      const before = await c.resolve.page(pageRef);
      const pageId = before.page.id;
      const detail = await c.api.post<PageDetail>(`/api/pages/${encodeURIComponent(pageId)}/auto-letter`);
      const created = detail.frames.length - before.frames.length;
      c.out(detail, () => `${created} frames created on ${pageId} (${detail.frames.length} in all)`);
    });
}
