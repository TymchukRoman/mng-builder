import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, RecipeInfo } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import type { CliContext } from '../src/context.js';
import { describeJob, registerAiCommands } from '../src/commands/ai.js';
import { startM2TestServer, type M2TestServer } from '../../server/test/helpers/m2-server.js';
import { giveRefs, seedCharacter, seedManga } from '../../server/test/helpers/seed.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function testContext(baseUrl: string, outputs: unknown[]): CliContext {
  const api = new ApiClient(baseUrl);
  return {
    api, json: true, wait: false, baseUrl,
    io: { stdout() {}, stderr() {} },
    out: (data) => { outputs.push(data); },
    waitJobs: async (ids) => {
      const done: Job[] = [];
      for (const id of ids) {
        for (;;) {
          const job = await api.get<Job>(`/api/jobs/${id}`);
          if (TERMINAL.has(job.status)) {
            done.push(job);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return done;
    },
    resolve: {
      manga: (ref) => api.get(`/api/mangas/${ref}`),
      character: (ref) => api.get(`/api/characters/${ref}`),
      chapter: (ref) => api.get(`/api/chapters/${ref}`),
      page: (id) => api.get(`/api/pages/${id}`),
      panel: (id) => api.get(`/api/panels/${id}`),
      frame: (id) => api.get(`/api/frames/${id}`),
    },
  };
}

function program(ctx: CliContext, existing?: (root: Command) => void): Command {
  const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride();
  existing?.(root);
  registerAiCommands(root, async () => ctx);
  return root;
}

let s: M2TestServer;
let outputs: unknown[];
let ctx: CliContext;
beforeEach(async () => {
  s = await startM2TestServer();
  outputs = [];
  ctx = testContext(s.url, outputs);
});
afterEach(async () => { await s.close(); });

describe('manga panel …', () => {
  it('panel generate --wait runs the job end to end', async () => {
    const { panels } = seedManga(s.deps.store);
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'generate', panels[0]!.id, '--seed', '11'], { from: 'user' });
    const jobs = outputs[0] as Job[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'image.generate', status: 'succeeded' });
    const panel = s.deps.store.panels.require(panels[0]!.id);
    expect(panel.activeImageId).toBe((jobs[0]!.result as { imageId: string }).imageId);
    expect(panel.seed).toBe(11);
  });

  it('without --wait prints the job ids', async () => {
    const { panels } = seedManga(s.deps.store);
    await program(ctx).parseAsync(['--json', 'panel', 'generate', panels[0]!.id], { from: 'user' });
    expect(outputs[0]).toEqual({ jobIds: [expect.stringMatching(/^jb_/)] });
  });

  it('panel prompt needs --ai or --scene; --scene edits in place, --ai asks the engine', async () => {
    const { panels } = seedManga(s.deps.store);
    const id = panels[0]!.id;
    await expect(program(ctx).parseAsync(['panel', 'prompt', id], { from: 'user' })).rejects.toMatchObject({ exitCode: 2 });
    await program(ctx).parseAsync(['--json', 'panel', 'prompt', id, '--scene', 'rain, night'], { from: 'user' });
    expect(s.deps.store.panels.require(id).prompt.scene).toBe('rain, night');
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'prompt', id, '--ai'], { from: 'user' });
    expect(s.deps.store.panels.require(id).prompt.scene).toBe('solo, standing, school rooftop, chain-link fence, sunset, wind');
  });

  it('panel review --wait returns the verdict', async () => {
    const { panels } = seedManga(s.deps.store);
    const id = panels[0]!.id;
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'generate', id], { from: 'user' });
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'review', id], { from: 'user' });
    expect((outputs[1] as Job[])[0]!.result).toMatchObject({ engine: 'claude', pass: true });
  });

  it('replaces a pre-existing subcommand of the same name', async () => {
    const { panels } = seedManga(s.deps.store);
    const root = program(ctx, (r) => {
      r.command('panel').command('prompt <panel>').action(() => { throw new Error('old prompt command'); });
    });
    const panelGroup = root.commands.find((c) => c.name() === 'panel')!;
    expect(panelGroup.commands.filter((c) => c.name() === 'prompt')).toHaveLength(1);
    await root.parseAsync(['--json', 'panel', 'prompt', panels[0]!.id, '--scene', 'x'], { from: 'user' });
    expect(s.deps.store.panels.require(panels[0]!.id).prompt.scene).toBe('x');
  });
});

describe('manga character … and recipes', () => {
  it('generate, suggest and sheet', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko');
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'generate', aiko.id, '--n', '2'], { from: 'user' });
    expect((outputs[0] as Job[]).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'suggest', aiko.id, '--description', 'silver twin-tails'], { from: 'user' });
    expect(s.deps.store.characters.require(aiko.id).appearanceTags).toContain('twintails');
    await expect(program(ctx).parseAsync(['--json', 'character', 'sheet', aiko.id], { from: 'user' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    giveRefs(s.deps.store, s.deps.store.characters.require(aiko.id), ['portrait']);
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'sheet', aiko.id], { from: 'user' });
    expect(Object.keys(s.deps.store.characters.require(aiko.id).refs).sort()).toEqual(['back', 'fullbody', 'portrait', 'side']);
  });

  it('recipes lists all nine', async () => {
    await program(ctx).parseAsync(['--json', 'recipes'], { from: 'user' });
    expect((outputs[0] as RecipeInfo[]).map((r) => r.id)).toContain('qwen-edit-ref');
    expect(outputs[0]).toHaveLength(9);
  });

  it('describeJob summarises results for humans', () => {
    const base = {
      id: 'jb_describe01', kind: 'image.generate', lane: 'gpu', status: 'succeeded', priority: 0, payload: {}, result: null, error: null,
      attempts: 1, maxAttempts: 3, nextRunAt: '', progress: null, episodeRunId: null, createdAt: '', startedAt: null, finishedAt: null,
    } as Job;
    expect(describeJob({ ...base, result: { imageId: 'im_1' } })).toBe('jb_describe01  image im_1');
    expect(describeJob({ ...base, result: { engine: 'claude', pass: false, issues: [{ kind: 'text', note: 'Bubble.' }], at: '' } })).toBe('jb_describe01  fail\n  - text: Bubble.');
    expect(describeJob({ ...base, status: 'failed', error: 'boom' })).toBe('jb_describe01  failed  boom');
  });
});
