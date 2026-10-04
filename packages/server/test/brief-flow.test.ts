import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAPTER_TITLE_FROM_PREMISE, PremiseOutputSchema, type AutoRun, type Chapter, type EpisodeRun, type Manga,
} from '@manga/shared';
import { InvalidOutputError } from '../src/engines/errors.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { extractContext, type OutlineContext, type PremiseContext, type PromptsContext, type ScriptsContext } from '../src/workflows/episode/context.js';
import type { PlanContext } from '../src/workflows/auto/plan.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const FINAL = new Set(['done', 'failed', 'cancelled']);
const BRIEF = 'Aiko finds a cat in the rain. Aiko has a red scarf. Simplistic art style. No romance.';

async function episode(server: M4TestServer, input: Record<string, unknown> = {}): Promise<{ chapter: Chapter; run: EpisodeRun }> {
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Ledger' })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: CHAPTER_TITLE_FROM_PREMISE })).body;
  await server.api('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: BRIEF, pages: 1, previewFirst: false, ...input }, mode: 'autopilot' });
  const run = await server.until(async () => {
    const r = (await server.api<EpisodeRun | null>('GET', `/api/chapters/${chapter.id}/episode`)).body;
    return r && FINAL.has(r.status) ? r : null;
  }, 45_000);
  return { chapter, run };
}

const callsOf = (server: M4TestServer, name: string) => server.claude.calls.filter((c) => c.name === name);

describe('reading the brief (integration, fakes)', { timeout: 120_000 }, () => {
  it('reads the brief into directives, and every later step is handed the ones that concern it', async () => {
    s = await startM4TestServer();
    const { run } = await episode(s);
    expect(run.status).toBe('done');
    const premise = PremiseOutputSchema.parse(run.steps[0]!.output);
    expect(premise.directives.map((d) => [d.id, d.kind, d.text])).toEqual([
      ['D1', 'plot', 'Aiko finds a cat in the rain.'], ['D2', 'character', 'Aiko has a red scarf.'],
      ['D3', 'visual', 'Simplistic art style.'], ['D4', 'avoid', 'No romance.'],
    ]);
    expect(premise.directives[2]).toMatchObject({ tags: 'simple background, minimal shading', sources: [3] });
    expect(premise.artTags).toBe('simple background, minimal shading');
    expect(premise.notes).toBe('No romance.');

    // The passes ran in order, the premise call after them.
    expect(s.claude.calls.slice(0, 3).map((c) => c.name)).toEqual(['brief.extract', 'brief.audit', 'episode.premise']);
    expect(extractContext<PremiseContext>(callsOf(s, 'episode.premise')[0]!.prompt).directives.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    // The second pass is shown which sentences nothing was taken from (none here: the fake reads every one).
    const audit = extractContext<{ step: string; directives: unknown[]; unreadSegments: unknown[]; segments: unknown[] }>(callsOf(s, 'brief.audit')[0]!.prompt);
    expect([audit.directives.length, audit.unreadSegments.length, audit.segments.length]).toEqual([4, 0, 4]);

    // Each step gets its own kinds.
    const ids = (p: string): string[] => extractContext<OutlineContext>(p).directives.map((d) => d.id);
    expect(ids(callsOf(s, 'episode.outline')[0]!.prompt)).toEqual(['D1', 'D2', 'D4']);
    expect(ids(callsOf(s, 'episode.breakdown')[0]!.prompt)).toEqual(['D4']);
    expect(extractContext<ScriptsContext>(callsOf(s, 'episode.scripts')[0]!.prompt).directives.map((d) => d.id)).toEqual(['D1', 'D2', 'D4']);
    expect(extractContext<PromptsContext>(callsOf(s, 'episode.prompts')[0]!.prompt).directives.map((d) => d.id)).toEqual(['D3', 'D4']);
  });

  it('adds what the second pass found missing, numbered after the first pass', async () => {
    s = await startM4TestServer({
      claude: {
        'brief.audit': () => ({ missing: [{ text: 'The cat is grey.', kind: 'character', chapters: [], must: true, quote: 'grey cat', sources: [1], tags: '' }] }),
      },
    });
    const { run } = await episode(s);
    const premise = PremiseOutputSchema.parse(run.steps[0]!.output);
    expect(premise.directives.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(premise.directives[4]).toMatchObject({ text: 'The cat is grey.', kind: 'character' });
    expect(extractContext<ScriptsContext>(callsOf(s, 'episode.scripts')[0]!.prompt).directives.map((d) => d.text)).toContain('The cat is grey.');
  });

  it('does not read a brief that was handed in already read', async () => {
    s = await startM4TestServer();
    const directives = [{ id: 'D1', text: 'The ending is happy.', kind: 'structure', chapters: [], must: true, quote: '', sources: [], tags: '' }];
    const { run } = await episode(s, { directives });
    expect(run.status).toBe('done');
    expect(s.claude.calls.some((c) => c.name.startsWith('brief.'))).toBe(false);
    expect(PremiseOutputSchema.parse(run.steps[0]!.output).directives).toEqual(directives.map((d) => ({ ...d })));
  });

  it('rewrites the script once when the check finds a detail missing, and tells the writers what', async () => {
    let audits = 0;
    s = await startM4TestServer({
      claude: {
        'episode.scripts-audit': () => (++audits === 1 ? { unmet: [{ id: 'D2', problem: 'Aiko never wears her red scarf', page: 1 }, { id: 'D9', problem: 'unknown id is ignored' }] } : { unmet: [] }),
      },
    });
    const { run } = await episode(s);
    expect(run.status).toBe('done');
    expect(callsOf(s, 'episode.scripts-audit')).toHaveLength(1);
    const scripts = callsOf(s, 'episode.scripts');
    expect(scripts).toHaveLength(2);
    expect(extractContext<ScriptsContext>(scripts[0]!.prompt).revisions).toBeUndefined();
    expect(extractContext<ScriptsContext>(scripts[1]!.prompt).revisions).toEqual([
      { id: 'D2', text: 'Aiko has a red scarf.', problem: 'Aiko never wears her red scarf', page: 1 },
    ]);
    // The check sees the whole story with its dialogue and only the directives a script can show (no look).
    const audit = extractContext<{ step: string; directives: Array<{ id: string }>; story: string }>(callsOf(s, 'episode.scripts-audit')[0]!.prompt);
    expect(audit.directives.map((d) => d.id)).toEqual(['D1', 'D2', 'D4']);
    expect(audit.story).toContain('Page 1:');
  });

  it('keeps the first script when the check fails, and asks for no rewrite when nothing is unmet', async () => {
    s = await startM4TestServer({ claude: { 'episode.scripts-audit': () => { throw new Error('model overloaded'); } } });
    const { run } = await episode(s);
    expect(run.status).toBe('done');
    expect(callsOf(s, 'episode.scripts')).toHaveLength(1);
    await s.close();
    s = await startM4TestServer();
    expect((await episode(s)).run.status).toBe('done');
    expect(callsOf(s, 'episode.scripts')).toHaveLength(1);
  });

  it('checks nothing when the brief has no directive a script can show', async () => {
    s = await startM4TestServer();
    await episode(s, { directives: [{ id: 'D1', text: 'Thick lines.', kind: 'visual', chapters: [], must: true, quote: '', sources: [], tags: 'thick outlines' }] });
    expect(callsOf(s, 'episode.scripts-audit')).toHaveLength(0);
  });
});

const AUTO = { brief: 'Two friends on a harbour pier. Aiko has a red scarf. Simplistic art style. No romance.', chapters: 2, pagesPerChapter: 1, poster: false };

async function auto(server: M4TestServer, input: Record<string, unknown> = {}): Promise<AutoRun> {
  const started = (await server.api<AutoRun>('POST', '/api/auto-mangas', { input: { ...AUTO, ...input } })).body;
  return server.until(async () => {
    const r = (await server.api<AutoRun>('GET', `/api/auto-runs/${started.id}`)).body;
    return r.status !== 'running' ? r : null;
  }, 90_000);
}

describe('the plan of an auto-created manga (integration, fakes)', { timeout: 150_000 }, () => {
  it('writes the plan from the directives, checks it, and hands each chapter the directives that concern it', async () => {
    s = await startM4TestServer();
    const run = await auto(s);
    expect(run.status, run.error ?? '').toBe('done');
    const plan = run.plan!;
    expect(plan.directives.map((d) => [d.id, d.kind, d.status])).toEqual([
      ['D1', 'plot', 'applied'], ['D2', 'character', 'applied'], ['D3', 'visual', 'applied'], ['D4', 'avoid', 'applied'],
    ]);
    expect(plan.coverage.map((c) => [c.id, c.where])).toEqual([['D1', 'chapters'], ['D2', 'cast'], ['D3', 'style'], ['D4', 'notes']]);
    expect(callsOf(s, 'brief.extract')).toHaveLength(1); // the chapters are handed their directives: none reads the brief again
    expect(callsOf(s, 'manga.plan')).toHaveLength(1);
    expect(callsOf(s, 'manga.plan-audit')).toHaveLength(1);
    expect(extractContext<PlanContext>(callsOf(s, 'manga.plan')[0]!.prompt).directives.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4']);

    // The look is in the manga's style prompt (from the directives, not from the planner's own tags).
    const manga = (await s.api<Manga>('GET', `/api/mangas/${run.mangaId}`)).body;
    expect(manga.styleGuide.stylePrompt).toContain('simple background, minimal shading');

    // Chapter 1 carries the plot directive placed in it; chapter 2 does not, but both carry the series-wide ones.
    const premises = callsOf(s, 'episode.premise').map((c) => extractContext<PremiseContext>(c.prompt).directives.map((d) => d.id));
    expect(premises).toEqual([['D1', 'D2', 'D3', 'D4'], ['D2', 'D3', 'D4']]);
    // The series look is not added again to the chapters' scenes: the manga's style prompt carries it.
    const chapters = (await s.api<Chapter[]>('GET', `/api/mangas/${run.mangaId}/chapters`)).body;
    const done = (await s.api<EpisodeRun>('GET', `/api/chapters/${chapters[1]!.id}/episode`)).body;
    expect(PremiseOutputSchema.parse(done.steps[0]!.output).artTags).toBe('');
  });

  it('writes the plan again when the check finds a directive unmet, with what to fix, and marks what is still unmet', async () => {
    let audits = 0;
    s = await startM4TestServer({
      claude: {
        'manga.plan-audit': () => {
          audits += 1;
          if (audits === 1) return { unmet: [{ id: 'D1', problem: 'No chapter shows the pier' }, { id: 'D2', problem: 'The scarf is missing' }] };
          return { unmet: [{ id: 'D2', problem: 'The scarf is still missing' }] };
        },
      },
    });
    const run = await auto(s);
    expect(run.status, run.error ?? '').toBe('done');
    const writes = callsOf(s, 'manga.plan');
    expect(writes).toHaveLength(2);
    const second = extractContext<PlanContext>(writes[1]!.prompt);
    expect(second.revisions).toEqual([
      { id: 'D1', text: 'Two friends on a harbour pier.', problem: 'No chapter shows the pier' },
      { id: 'D2', text: 'Aiko has a red scarf.', problem: 'The scarf is missing' },
    ]);
    expect(second.previousPlan?.chapters).toHaveLength(2);
    expect(callsOf(s, 'manga.plan-audit')).toHaveLength(2);
    // After the second try: D1 is fixed, D2 stays marked for the user to see.
    expect(run.plan!.directives.map((d) => [d.id, d.status, d.note ?? null])).toEqual([
      ['D1', 'applied', null], ['D2', 'unmet', 'The scarf is still missing'], ['D3', 'applied', null], ['D4', 'applied', null],
    ]);
  });

  it('keeps the first plan when the second try fails or the check itself fails', async () => {
    let writes = 0;
    s = await startM4TestServer({
      claude: {
        'manga.plan-audit': () => ({ unmet: [{ id: 'D1', problem: 'x' }] }),
        'manga.plan': (req) => { writes += 1; if (writes === 2) throw new Error('model overloaded'); return FAKE_RESPONSES['manga.plan']!(req); },
      },
    });
    expect((await auto(s)).status).toBe('done');
    await s.close();
    s = await startM4TestServer({ claude: { 'manga.plan-audit': () => { throw new Error('model overloaded'); } } });
    const run = await auto(s);
    expect(run.status).toBe('done');
    expect(run.plan!.directives.every((d) => d.status === 'applied')).toBe(true);
  });

  it('fails the plan, naming the directive, when it leaves a "must" directive out of its coverage', async () => {
    s = await startM4TestServer({
      claude: { 'manga.plan': (req) => ({ ...(FAKE_RESPONSES['manga.plan']!(req) as object), coverage: [] }) },
    });
    const run = await auto(s);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('coverage');
    expect(run.error).toContain('D2 (Aiko has a red scarf.)');
  });

  it('runs a chapter again when one of its steps fails, before the manga stops', async () => {
    let outlines = 0;
    s = await startM4TestServer({
      claude: {
        'episode.outline': (req) => {
          outlines += 1;
          if (outlines === 1) throw new InvalidOutputError('episode.outline: not JSON', '{}');
          return FAKE_RESPONSES['episode.outline']!(req);
        },
      },
    });
    const run = await auto(s, { chapters: 1 });
    expect(run.status, run.error ?? '').toBe('done');
    expect(outlines).toBe(2);
  });

  it('stops the manga when a chapter keeps failing', async () => {
    s = await startM4TestServer({ claude: { 'episode.outline': () => { throw new InvalidOutputError('episode.outline: not JSON', '{}'); } } });
    const run = await auto(s, { chapters: 1 });
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Chapter 1');
    expect(callsOf(s, 'episode.outline')).toHaveLength(3); // the first try and two more
  });
});
