import type { Command } from 'commander';
import type { TextFrame } from '@manga/shared';
import { parseBox, parseNumber, parsePositiveNumber } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';

interface EditOptions {
  text?: string; kind?: string; speaker?: string; panel?: string; font?: string; size?: number;
  box?: { x: number; y: number; w: number; h: number }; rotation?: number; align?: string;
}

export function registerTextCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const text = program.command('text').description('text frames: speech, thought, shout, narration, sfx, title');

  text
    .command('add')
    .description('add a text frame to a page (auto-placed in its panel, or on the page)')
    .argument('<page>')
    .requiredOption('--kind <kind>', 'speech, thought, shout, narration, sfx, or title (covers only)')
    .option('--text <text>', 'the text', '')
    .option('--speaker <char>', 'character name or id')
    .option('--panel <panel>', 'anchor panel id')
    .action(async (pageId: string, opts: { kind: string; text: string; speaker?: string; panel?: string }) => {
      const c = await ctx();
      const target = await c.resolve.page(pageId);
      const speakerId = opts.speaker === undefined ? null : (await c.resolve.character(opts.speaker, target.page.mangaId)).id;
      const frame = await c.api.post<TextFrame>(`/api/pages/${target.page.id}/frames`, {
        kind: opts.kind, text: opts.text, panelId: opts.panel ?? null, speakerId,
      });
      c.out(frame, () => `created ${frame.id}  ${frame.kind}  "${frame.text}"`);
    });

  text
    .command('edit')
    .description('change a text frame')
    .argument('<frame>')
    .option('--text <text>', 'the text')
    .option('--kind <kind>', 'speech, thought, shout, narration, sfx or title')
    .option('--speaker <char>', 'character name or id; "-" to clear')
    .option('--panel <panel>', 'anchor panel id; "-" to clear')
    .option('--font <font>', 'font family')
    .option('--size <pt>', 'font size in points', parsePositiveNumber)
    .option('--box <x,y,w,h>', 'page-normalized box, e.g. 0.1,0.1,0.3,0.12', parseBox)
    .option('--rotation <deg>', 'rotation in degrees', parseNumber)
    .option('--align <align>', 'left, center or right')
    .action(async (frameId: string, opts: EditOptions) => {
      const given = [opts.text, opts.kind, opts.speaker, opts.panel, opts.font, opts.size, opts.box, opts.rotation, opts.align];
      if (given.every((v) => v === undefined)) throw new CliError('nothing to change; pass at least one option (see: manga text edit --help)', 2);
      const c = await ctx();
      const frame = await c.resolve.frame(frameId);
      const patch: Record<string, unknown> = {};
      if (opts.text !== undefined) patch['text'] = opts.text;
      if (opts.kind !== undefined) patch['kind'] = opts.kind;
      if (opts.font !== undefined) patch['font'] = opts.font;
      if (opts.size !== undefined) patch['fontSize'] = opts.size;
      if (opts.box !== undefined) patch['box'] = opts.box;
      if (opts.rotation !== undefined) patch['rotation'] = opts.rotation;
      if (opts.align !== undefined) patch['align'] = opts.align;
      if (opts.panel !== undefined) patch['panelId'] = opts.panel === '-' ? null : opts.panel;
      if (opts.speaker !== undefined) {
        if (opts.speaker === '-') {
          patch['speakerId'] = null;
        } else {
          const { page } = await c.resolve.page(frame.pageId);
          patch['speakerId'] = (await c.resolve.character(opts.speaker, page.mangaId)).id;
        }
      }
      const updated = await c.api.patch<TextFrame>(`/api/frames/${frame.id}`, patch);
      c.out(updated, () => `updated ${updated.id}  ${updated.kind}  "${updated.text}"`);
    });

  text
    .command('rm')
    .description('delete a text frame')
    .argument('<frame>')
    .action(async (frameId: string) => {
      const c = await ctx();
      await c.api.delete(`/api/frames/${encodeURIComponent(frameId)}`);
      c.out({ ok: true, id: frameId }, () => `deleted ${frameId}`);
    });
}
