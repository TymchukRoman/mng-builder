import type { Command } from 'commander';
import { DialogueKindSchema, type Character, type DialogueLine, type Image, type Panel, type PanelScript } from '@manga/shared';
import { collect, parseList } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';

type StagePosition = 'left' | 'center' | 'right';
const POSITIONS: readonly StagePosition[] = ['left', 'center', 'right'];

/** 1 → center; 2 → left, right; 3+ → left, center, right, left, … */
export function stagePositions(count: number): StagePosition[] {
  if (count === 1) return ['center'];
  if (count === 2) return ['left', 'right'];
  return Array.from({ length: count }, (_, i) => POSITIONS[i % POSITIONS.length] ?? 'center');
}

export function formatScript(script: PanelScript): string {
  return [
    `action      ${script.action || '-'}`,
    `shot        ${script.shot}`,
    `angle       ${script.angle}`,
    `background  ${script.background || '-'}`,
    `characters  ${script.characters.map((c) => `${c.characterId}@${c.position}`).join(' ') || '-'}`,
    script.dialogue.length === 0 ? 'dialogue    -' : 'dialogue',
    ...script.dialogue.map((line) => `  ${line.kind} ${line.speakerId ?? '-'}: ${line.text}`),
  ].join('\n');
}

/** "<speaker>:<kind>:<text>"; speaker "-" (or empty) for none. The text may contain colons. */
export async function parseLine(spec: string, speaker: (ref: string) => Promise<Character>): Promise<DialogueLine> {
  const match = /^([^:]*):([^:]*):(.+)$/s.exec(spec);
  if (match === null) throw new CliError(`a dialogue line is "<speaker>:<kind>:<text>" (speaker "-" for none), got "${spec}"`, 2);
  const [, who = '', kindText = '', text = ''] = match;
  const kind = DialogueKindSchema.safeParse(kindText.trim());
  if (!kind.success) throw new CliError(`dialogue kind must be one of ${DialogueKindSchema.options.join(', ')}, got "${kindText}"`, 2);
  const speakerRef = who.trim();
  const speakerId = speakerRef === '' || speakerRef === '-' ? null : (await speaker(speakerRef)).id;
  return { speakerId, kind: kind.data, text };
}

interface ScriptOptions { action?: string; shot?: string; angle?: string; background?: string; chars?: string; line: string[] }

export function registerPanelCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const panel = program.command('panel').description('panels: script, variants, pick, upload, prompt, generate, review');

  panel
    .command('script')
    .description('show the panel script, or change parts of it')
    .argument('<panel>')
    .option('--action <text>', 'what happens in the panel')
    .option('--shot <shot>', 'extreme-close, close, medium, wide or extreme-wide')
    .option('--angle <angle>', 'eye, low, high, dutch or overhead')
    .option('--background <text>', 'background description')
    .option('--chars <list>', 'comma-separated character names or ids, in stage order (replaces the cast)')
    .option('--line <speaker:kind:text>', 'dialogue line, repeatable (replaces the dialogue); speaker "-" for none', collect, [] as string[])
    .action(async (panelId: string, opts: ScriptOptions) => {
      const c = await ctx();
      const current = await c.resolve.panel(panelId);
      const changing = [opts.action, opts.shot, opts.angle, opts.background, opts.chars].some((v) => v !== undefined) || opts.line.length > 0;
      if (!changing) {
        c.out(current.script, () => formatScript(current.script));
        return;
      }
      const { page } = await c.resolve.page(current.pageId);
      const castMember = (ref: string): Promise<Character> => c.resolve.character(ref, page.mangaId);
      const script: Record<string, unknown> = { ...current.script };
      if (opts.action !== undefined) script['action'] = opts.action;
      if (opts.shot !== undefined) script['shot'] = opts.shot;
      if (opts.angle !== undefined) script['angle'] = opts.angle;
      if (opts.background !== undefined) script['background'] = opts.background;
      if (opts.line.length > 0) {
        const lines: DialogueLine[] = [];
        for (const spec of opts.line) lines.push(await parseLine(spec, castMember));
        script['dialogue'] = lines;
      }
      if (opts.chars !== undefined) {
        const cast = await Promise.all(parseList(opts.chars).map(castMember));
        const positions = stagePositions(cast.length);
        script['characters'] = cast.map((member, i) => {
          const previous = current.script.characters.find((pc) => pc.characterId === member.id);
          return {
            characterId: member.id,
            pose: previous?.pose ?? '',
            expression: previous?.expression ?? '',
            position: previous?.position ?? positions[i] ?? 'center',
          };
        });
      }
      const updated = await c.api.patch<Panel>(`/api/panels/${current.id}`, { script });
      c.out(updated, () => formatScript(updated.script));
    });

  panel
    .command('variants')
    .description("list the panel's images; * marks the active one")
    .argument('<panel>')
    .action(async (panelId: string) => {
      const c = await ctx();
      const current = await c.resolve.panel(panelId);
      const images = await c.api.get<Image[]>(`/api/panels/${current.id}/images`);
      c.out(images, () =>
        images.length === 0
          ? 'no images yet'
          : table(images.map((im) => [im.id === current.activeImageId ? '*' : ' ', im.id, im.source, `${im.width}x${im.height}`, im.createdAt])),
      );
    });

  panel
    .command('pick')
    .description('make one of the variants the active image')
    .argument('<panel>')
    .argument('<image>', 'image id')
    .action(async (panelId: string, imageId: string) => {
      const c = await ctx();
      const updated = await c.api.patch<Panel>(`/api/panels/${encodeURIComponent(panelId)}`, { activeImageId: imageId });
      c.out(updated, () => `active image of ${updated.id}: ${imageId}`);
    });

  panel
    .command('upload')
    .description('upload your own art (PNG or JPEG); it becomes the active image')
    .argument('<panel>')
    .argument('<file>', 'PNG or JPEG file')
    .action(async (panelId: string, file: string) => {
      const c = await ctx();
      const image = await c.api.upload<Image>(`/api/panels/${encodeURIComponent(panelId)}/upload`, file);
      c.out(image, () => `uploaded ${image.id} (${image.width}x${image.height}), now active on ${panelId}`);
    });
}
