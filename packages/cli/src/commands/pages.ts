import type { Command } from 'commander';
import { computeRects, readingOrder, splitHandles, type LayoutNode, type Manga, type PageDetail, type PresetInfo } from '@manga/shared';
import { parseNonNegativeInt } from '../args.js';
import { ApiError } from '../client.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { fixed, table } from '../format.js';

type SplitPath = Array<'a' | 'b'>;

/** "root" (or ".") is the top split; otherwise a/b steps from it, e.g. "ab". */
export function parseSplitPath(arg: string): SplitPath {
  if (arg === 'root' || arg === '.') return [];
  if (!/^[ab]+$/.test(arg)) throw new CliError(`split path must be "root" or a/b steps like "ab", got "${arg}"`, 2);
  return [...arg] as SplitPath;
}

function nodeAt(tree: LayoutNode, path: SplitPath): LayoutNode | null {
  let node: LayoutNode = tree;
  for (const step of path) {
    if (node.type !== 'split') return null;
    node = step === 'a' ? node.a : node.b;
  }
  return node;
}

const enc = encodeURIComponent;

async function mangaOf(c: CliContext, detail: PageDetail): Promise<Manga> {
  return c.api.get<Manga>(`/api/mangas/${detail.page.mangaId}`);
}

async function orderOf(c: CliContext, detail: PageDetail): Promise<string[]> {
  return readingOrder(detail.page.layout, (await mangaOf(c, detail)).readingDirection);
}

export function registerPageCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program
    .command('layouts')
    .description('list the layout presets')
    .action(async () => {
      const c = await ctx();
      const presets = await c.api.get<PresetInfo[]>('/api/layouts');
      c.out(presets, () => table(presets.map((p) => [p.name, String(p.panelCount)]), ['preset', 'panels']));
    });

  const page = program.command('page').description('pages and their layout');

  page
    .command('add')
    .description('add a page to a chapter')
    .argument('<chapter>', 'id or <manga>/<number>')
    .option('--layout <preset>', 'layout preset (see: manga layouts)', '2x2')
    .option('--at <index>', 'insert position, 0-based (default: at the end)', parseNonNegativeInt)
    .action(async (chapterRef: string, opts: { layout: string; at?: number }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const detail = await c.api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, {
        layoutPreset: opts.layout, ...(opts.at === undefined ? {} : { index: opts.at }),
      });
      const order = await orderOf(c, detail);
      c.out(detail, () => `created ${detail.page.id}  (${opts.layout})  panels: ${order.join(' ')}`);
    });

  page
    .command('layout')
    .description('apply a layout preset; existing panels map onto it in reading order')
    .argument('<page>')
    .argument('<preset>')
    .option('--confirm', 'allow removing the panels that do not fit the new preset')
    .action(async (pageId: string, preset: string, opts: { confirm?: boolean }) => {
      const c = await ctx();
      let detail: PageDetail;
      try {
        detail = await c.api.post<PageDetail>(`/api/pages/${enc(pageId)}/layout/preset`, { preset, confirm: opts.confirm === true });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'needs_confirm') throw err;
        const removed = (err.details as { removedPanelIds?: string[] } | undefined)?.removedPanelIds ?? [];
        if (c.json) {
          c.io.stdout(`${JSON.stringify({ error: 'needs_confirm', removedPanelIds: removed }, null, 2)}\n`);
        } else {
          c.io.stderr(`layout ${preset} has fewer panels; these panels would be removed with their images:\n${removed.map((id) => `  ${id}`).join('\n')}\nre-run with --confirm to apply\n`);
        }
        throw new CliError('needs confirmation', 1, true);
      }
      const order = await orderOf(c, detail);
      c.out(detail, () => `layout ${preset} on ${detail.page.id}  panels: ${order.join(' ')}`);
    });

  page
    .command('split')
    .description('split a panel in two: h puts the new panel below, v puts it to the right')
    .argument('<panel>')
    .argument('<dir>', 'h or v')
    .action(async (panelId: string, dir: string) => {
      if (dir !== 'h' && dir !== 'v') throw new CliError(`direction must be h or v, got "${dir}"`, 2);
      const c = await ctx();
      const panel = await c.resolve.panel(panelId);
      const before = await c.resolve.page(panel.pageId);
      const detail = await c.api.post<PageDetail>(`/api/pages/${panel.pageId}/layout/split`, { panelId: panel.id, dir });
      const added = detail.panels.map((p) => p.id).filter((id) => !before.panels.some((p) => p.id === id));
      c.out(detail, () => `split ${panel.id} (${dir}); new panel ${added.join(' ')}`);
    });

  page
    .command('merge')
    .description('merge two sibling panels; the first keeps its content, the second\'s images become its variants')
    .argument('<panelA>')
    .argument('<panelB>')
    .action(async (a: string, b: string) => {
      const c = await ctx();
      const panel = await c.resolve.panel(a);
      const detail = await c.api.post<PageDetail>(`/api/pages/${panel.pageId}/layout/merge`, { panelIdA: a, panelIdB: b });
      c.out(detail, () => `merged ${b} into ${a}`);
    });

  page
    .command('resize')
    .description('set the ratio of a split (see the paths in: manga page show)')
    .argument('<page>')
    .argument('<splitPath>', '"root" for the top split, or a/b steps from it such as "ab"')
    .argument('<ratio>', 'between 0 and 1; each side keeps at least 8%')
    .action(async (pageId: string, pathArg: string, ratioArg: string) => {
      const path = parseSplitPath(pathArg);
      const ratio = Number(ratioArg);
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new CliError(`ratio must be between 0 and 1, got "${ratioArg}"`, 2);
      const c = await ctx();
      const detail = await c.api.post<PageDetail>(`/api/pages/${enc(pageId)}/layout/resize`, { path, ratio });
      const node = nodeAt(detail.page.layout, path);
      const actual = node?.type === 'split' ? node.ratio : ratio;
      const label = path.length === 0 ? 'root' : path.join('');
      c.out(detail, () => `resized ${label} of ${detail.page.id}: ratio ${fixed(actual)}${actual === ratio ? '' : ` (clamped from ${ratioArg})`}`);
    });

  page
    .command('show')
    .description('panels in reading order with their rects, the splits, and the frame count')
    .argument('<page>')
    .action(async (pageId: string) => {
      const c = await ctx();
      const detail = await c.resolve.page(pageId);
      const manga = await mangaOf(c, detail);
      const order = readingOrder(detail.page.layout, manga.readingDirection);
      const rects = new Map(computeRects(detail.page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
      const splits = splitHandles(detail.page.layout, manga.pageFormat).map((s) => ({
        path: s.path.length === 0 ? 'root' : s.path.join(''), dir: s.dir, ratio: s.ratio,
      }));
      c.out({ ...detail, readingOrder: order, splits }, () => [
        `${detail.page.id}  ${detail.page.kind}  p${detail.page.order + 1}`,
        'panels (reading order)',
        ...order.map((id, i) => {
          const r = rects.get(id);
          const active = detail.panels.find((p) => p.id === id)?.activeImageId ?? '-';
          return `  ${i + 1}  ${id}  x=${fixed(r?.x ?? 0)} y=${fixed(r?.y ?? 0)} w=${fixed(r?.w ?? 0)} h=${fixed(r?.h ?? 0)}  image ${active}`;
        }),
        splits.length === 0 ? 'splits  none' : 'splits',
        ...splits.map((s) => `  ${s.path.padEnd(6)}${s.dir}  ${fixed(s.ratio)}`),
        `frames  ${detail.frames.length}`,
      ].join('\n'));
    });

  page
    .command('rm')
    .description('delete a page with its panels, images and text')
    .argument('<page>')
    .action(async (pageId: string) => {
      const c = await ctx();
      await c.api.delete(`/api/pages/${enc(pageId)}`);
      c.out({ ok: true, id: pageId }, () => `deleted ${pageId}`);
    });
}
