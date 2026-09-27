import type { Command } from 'commander';
import type { Character, Image } from '@manga/shared';
import { parseNonNegativeInt } from '../args.js';
import type { CliContext } from '../context.js';

export function registerCharacterCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const character = program.command('character').description('characters: add, upload, pick (generate and sheet come with AI imaging)');

  character
    .command('add')
    .description('add a character to a manga')
    .argument('<manga>', 'id or title')
    .requiredOption('--name <name>', 'character name')
    .option('--role <role>', 'main, supporting or minor', 'supporting')
    .option('--appearance <tags>', 'canonical appearance tags, inserted verbatim into every prompt', '')
    .option('--personality <text>', 'personality', '')
    .option('--speech <style>', 'speech style', '')
    .option('--seed <n>', 'fixed seed (default: random)', parseNonNegativeInt)
    .action(async (mangaRef: string, opts: { name: string; role: string; appearance: string; personality: string; speech: string; seed?: number }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const created = await c.api.post<Character>(`/api/mangas/${manga.id}/characters`, {
        name: opts.name,
        role: opts.role,
        appearanceTags: opts.appearance,
        personality: opts.personality,
        speechStyle: opts.speech,
        ...(opts.seed === undefined ? {} : { seed: opts.seed }),
      });
      c.out(created, () => `created ${created.id}  ${created.name}  (${created.role}, seed ${created.seed})`);
    });

  character
    .command('upload')
    .description('upload your own image (PNG or JPEG) into a reference slot')
    .argument('<char>', 'id or name')
    .argument('<file>', 'PNG or JPEG file')
    .requiredOption('--slot <slot>', 'portrait, fullbody, side or back')
    .option('--manga <manga>', 'manga to look the name up in')
    .action(async (charRef: string, file: string, opts: { slot: string; manga?: string }) => {
      const c = await ctx();
      const target = await c.resolve.character(charRef, opts.manga);
      const image = await c.api.upload<Image>(`/api/characters/${target.id}/upload?slot=${encodeURIComponent(opts.slot)}`, file);
      c.out(image, () => `uploaded ${image.id} (${image.width}x${image.height}) as ${opts.slot} of ${target.name}`);
    });

  character
    .command('pick')
    .description("use one of the character's images for a reference slot")
    .argument('<char>', 'id or name')
    .argument('<image>', 'image id')
    .option('--slot <slot>', 'portrait, fullbody, side or back', 'portrait')
    .option('--manga <manga>', 'manga to look the name up in')
    .action(async (charRef: string, imageId: string, opts: { slot: string; manga?: string }) => {
      const c = await ctx();
      const target = await c.resolve.character(charRef, opts.manga);
      const updated = await c.api.post<Character>(`/api/characters/${target.id}/refs/${encodeURIComponent(opts.slot)}`, { imageId });
      c.out(updated, () => `${updated.name} ${opts.slot} = ${imageId}`);
    });
}
