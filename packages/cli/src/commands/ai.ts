import type { Command } from 'commander';
import type { Character, Job, JobRef, JobRefs, Panel, RecipeInfo, ReviewResult } from '@manga/shared';
import { parseNonNegativeInt, parsePositiveInt } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';

type ContextFactory = () => Promise<CliContext>;

function group(parent: Command, name: string, description: string): Command {
  return parent.commands.find((c) => c.name() === name) ?? parent.command(name).description(description);
}

/** Drops a subcommand an earlier registration (e.g. M1) added under the same name. */
function replace(parent: Command, name: string): void {
  const list = parent.commands as Command[];
  const index = list.findIndex((c) => c.name() === name);
  if (index >= 0) list.splice(index, 1);
}

export function describeJob(job: Job): string {
  if (job.status !== 'succeeded') return `${job.id}  ${job.status}${job.error ? `  ${job.error}` : ''}`;
  const r = (typeof job.result === 'object' && job.result !== null ? job.result : {}) as Record<string, unknown>;
  if (typeof r['imageId'] === 'string') return `${job.id}  image ${r['imageId']}`;
  if (Array.isArray(r['imageIds'])) return `${job.id}  images ${(r['imageIds'] as string[]).join(', ')}`;
  if (typeof r['scene'] === 'string') return `${job.id}  scene: ${r['scene']}`;
  if (typeof r['appearanceTags'] === 'string') return `${job.id}  tags: ${r['appearanceTags']}`;
  if (typeof r['pass'] === 'boolean') {
    const issues = (r['issues'] as ReviewResult['issues'] | undefined) ?? [];
    return `${job.id}  ${r['pass'] ? 'pass' : 'fail'}${issues.map((i) => `\n  - ${i.kind}: ${i.note}`).join('')}`;
  }
  return `${job.id}  succeeded`;
}

export function formatRecipe(r: RecipeInfo): string {
  const flags = [
    r.requiresRefs ? 'needs refs' : '', r.supportsPose ? 'pose' : '', r.supportsLineart ? 'lineart' : '',
    r.supportsLoras ? 'loras' : '', r.supportsInit ? 'img2img' : '',
  ].filter(Boolean).join(', ');
  return `${r.id.padEnd(14)} ${r.label}  refs<=${r.maxRefs}${flags ? `  (${flags})` : ''}`;
}

/**
 * Without --wait prints { jobIds }; with --wait waits for the jobs (ctx.waitJobs streams progress to stderr) and
 * prints the finished jobs. A job that did not succeed makes the command exit 1 (m2-rulings F14).
 */
export async function finishJobs(c: CliContext, cmd: Command, jobIds: string[]): Promise<void> {
  const wait = Boolean((cmd.optsWithGlobals() as { wait?: boolean }).wait);
  if (!wait) {
    c.out({ jobIds }, () => jobIds.join('\n'));
    return;
  }
  const jobs = await c.waitJobs(jobIds);
  c.out(jobs, () => jobs.map(describeJob).join('\n'));
  const failed = jobs.filter((j) => j.status !== 'succeeded');
  if (failed.length > 0) throw new CliError(`${failed.length} job(s) did not succeed`, 1);
}

export function registerAiCommands(program: Command, ctx: ContextFactory): void {
  const character = group(program, 'character', 'characters: add, edit, upload, pick, generate, sheet, suggest');
  for (const name of ['generate', 'sheet', 'suggest']) replace(character, name);

  character.command('generate <char>')
    .description('Generate portrait variants; pick one with `character pick`')
    .option('--n <count>', 'number of variants (1-8)', parsePositiveInt, 4)
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { n: number; manga?: string }, cmd: Command) => {
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRefs>(`/api/characters/${target.id}/portraits`, { n: opts.n });
      await finishJobs(c, cmd, res.jobIds);
    });

  character.command('sheet <char>')
    .description('Generate full-body, side and back reference views from the picked portrait')
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { manga?: string }, cmd: Command) => {
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRef>(`/api/characters/${target.id}/sheet`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  character.command('suggest <char>')
    .description('Turn a description into appearance tags (AI)')
    .requiredOption('--description <text>', 'what the character looks like')
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { description: string; manga?: string }, cmd: Command) => {
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRef>(`/api/characters/${target.id}/suggest-appearance`, { description: opts.description });
      await finishJobs(c, cmd, [res.jobId]);
    });

  const panel = group(program, 'panel', 'panels: script, variants, pick, upload, prompt, generate, review');
  for (const name of ['prompt', 'generate', 'review']) replace(panel, name);

  panel.command('prompt <panel>')
    .description('Set the scene prompt by hand (--scene) or let the AI write it (--ai)')
    .option('--ai', 'let the AI write the scene')
    .option('--scene <text>', 'scene text')
    .action(async (id: string, opts: { ai?: boolean; scene?: string }, cmd: Command) => {
      if (opts.ai === true && opts.scene !== undefined) throw new CliError('pass either --ai or --scene, not both', 2);
      if (opts.ai !== true && opts.scene === undefined) throw new CliError('pass --ai or --scene <text>', 2);
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      if (opts.scene !== undefined) {
        const updated = await c.api.patch<Panel>(`/api/panels/${target.id}`, { prompt: { scene: opts.scene, negative: target.prompt.negative } });
        c.out(updated, () => updated.prompt.scene);
        return;
      }
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/prompt`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  panel.command('generate <panel>')
    .description('Generate a new image variant for the panel')
    .option('--recipe <id>', 'recipe (see `manga recipes`)')
    .option('--seed <n>', 'seed', parseNonNegativeInt)
    .action(async (id: string, opts: { recipe?: string; seed?: number }, cmd: Command) => {
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      const body = { ...(opts.recipe !== undefined ? { recipe: opts.recipe } : {}), ...(opts.seed !== undefined ? { seed: opts.seed } : {}) };
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/generate`, body);
      await finishJobs(c, cmd, [res.jobId]);
    });

  panel.command('review <panel>')
    .description("Ask the AI to check the panel's active image")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/review`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  replace(program, 'recipes');
  program.command('recipes')
    .description('List image recipes')
    .action(async () => {
      const c = await ctx();
      const list = await c.api.get<RecipeInfo[]>('/api/recipes');
      c.out(list, () => list.map(formatRecipe).join('\n'));
    });
}
