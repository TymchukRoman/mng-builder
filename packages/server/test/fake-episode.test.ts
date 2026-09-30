// packages/server/test/fake-episode.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PremiseOutputSchema, STEP_TASK, stepIndex,
  type BreakdownOutput, type EpisodeRun, type EpisodeStepName, type OutlineOutput, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { extractContext, type OutlineContext, type PromptsContext, type ScriptsContext } from '../src/workflows/episode/context.js';
import { combineAnswers, stepRequests } from '../src/workflows/episode/requests.js';
import { patchStep, type LlmStepName } from '../src/workflows/episode/steps.js';
import { seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** The engine of the last `ask`: its `calls` are the requests the fakes answered. */
let engine: ScriptedEngine;

/** Asks the scripted engine exactly the way the runner will (Task 9): one call per step request, then combineAnswers. */
async function ask<T>(run: EpisodeRun, step: LlmStepName): Promise<T> {
  engine = new ScriptedEngine('claude', FAKE_RESPONSES);
  const answers: unknown[] = [];
  for (const r of stepRequests(lib.store, run, step)) answers.push(await engine.completeJson(r));
  return combineAnswers(lib.store, run, step, answers) as T;
}

function save(run: EpisodeRun, step: EpisodeStepName, output: unknown): EpisodeRun {
  return lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex(step), { status: 'done', output }) });
}

describe('fake episode responses', () => {
  it("answer every step with output that passes that step's validation", async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    let run = seedRun(lib.store, chapter.id, { input: { characterIds: [aiko.id], pages: 2 } });

    const premise = await ask<PremiseOutput>(run, 'premise');
    expect(premise.title).toBe('Кіт під дощем');
    run = save(run, 'premise', premise);

    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(outline.newCharacters.map((c) => c.name)).toEqual(['Mika']);
    expect(outline.scenes[0]!.characterNames).toEqual(['Aiko', 'Mika']);
    run = save(run, 'outline', outline);
    seedCharacter(lib.store, manga.id, 'Mika');

    const bd = await ask<BreakdownOutput>(run, 'breakdown');
    expect(bd.pages).toHaveLength(2);
    run = save(run, 'breakdown', bd);

    const sc = await ask<ScriptsOutput>(run, 'scripts');
    expect(sc.pages[0]!.panels[0]!.dialogue[0]).toEqual({ speaker: null, kind: 'narration', text: 'Осінь.' });
    expect(sc.pages[0]!.panels[0]!.dialogue[1]).toMatchObject({ speaker: 'Mika', kind: 'speech' });
    run = save(run, 'scripts', sc);

    for (const page of bd.pages) createPage(lib.store, chapter.id, page.layoutPreset);
    createCoverPage(lib.store, manga.id, chapter.id);
    const prompts = await ask<PromptsOutput>(run, 'prompts');
    expect(prompts.panels).toHaveLength(bd.pages.reduce((n, p) => n + p.panelCount, 0) + 1);
    expect(prompts.panels.at(-1)!.scene).toContain('looking at viewer');
  });

  it('introduce the new character only once', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    seedCharacter(lib.store, manga.id, 'mika');
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' } } });
    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(outline.newCharacters).toEqual([]);
    expect(outline.scenes[0]!.characterNames).toEqual(['mika']);
  });

  it('never re-propose a character the manga has outside this run\'s cast (Task 5 M1)', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    seedCharacter(lib.store, manga.id, 'Mika');
    const run = seedRun(lib.store, chapter.id, { input: { characterIds: [aiko.id] }, outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' } } });
    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(extractContext<OutlineContext>(engine.calls[0]!.prompt).otherCharacterNames).toEqual(['Mika']);
    expect(outline.newCharacters).toEqual([]);
    expect(outline.scenes[0]!.characterNames).toEqual(['Aiko']);
  });

  it('write the outline in Ukrainian for a Ukrainian manga, tags in English (Task 5 M2)', async () => {
    const { chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' } } });
    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(outline.scenes.map((s) => s.summary)).toEqual(['Вони зустрічаються під дощем.', 'Вони прощаються друзями.']);
    expect(outline.newCharacters[0]).toMatchObject({ name: 'Mika', personality: 'життєрадісна', speechStyle: 'короткі речення' });
    expect(outline.newCharacters[0]!.appearanceTags).toMatch(/^1girl, /);
  });

  it('write narration only when the manga has no characters', async () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const bd: BreakdownOutput = { pages: [{ sceneIdx: [0], panelCount: 2, pacing: 'x', layoutPreset: 'nope' }] };
    const run = seedRun(lib.store, chapter.id, {
      input: { pages: 1 },
      outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' }, outline: { scenes: [{ summary: 's', purpose: '', location: '', characterNames: [] }], newCharacters: [] }, breakdown: bd },
    });
    const sc = await ask<ScriptsOutput>(run, 'scripts');
    expect(sc.pages[0]!.panels.flatMap((p) => p.dialogue.map((d) => d.kind))).toEqual(['narration']);
    expect(sc.pages[0]!.panels.every((p) => p.characters.length === 0)).toBe(true);
  });

  it('answers each chunk of a long chapter from its own context (scripts in chunks, prompts per page)', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    seedCharacter(lib.store, manga.id, 'Mika');
    let run = seedRun(lib.store, chapter.id, { input: { characterIds: [aiko.id], pages: 10 } });
    run = save(run, 'premise', await ask<PremiseOutput>(run, 'premise'));
    run = save(run, 'outline', await ask<OutlineOutput>(run, 'outline'));
    const bd = await ask<BreakdownOutput>(run, 'breakdown');
    expect(bd.pages).toHaveLength(10);
    run = save(run, 'breakdown', bd);

    const sc = await ask<ScriptsOutput>(run, 'scripts');
    const chunks = engine.calls.map((c) => extractContext<ScriptsContext>(c.prompt).pages.map((p) => p.page));
    expect(chunks).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
    expect(sc.pages).toHaveLength(10);
    const narration = sc.pages.flatMap((p, i) => p.panels.flatMap((pn, j) => pn.dialogue.filter((d) => d.kind === 'narration').map(() => [i, j])));
    expect(narration).toEqual([[0, 0]]); // only the chapter's first panel, not the first panel of every chunk
    expect(sc.pages[9]!.panels[1]!.dialogue[0]!.text).toContain('(10.2)'); // absolute page numbers in later chunks
    run = save(run, 'scripts', sc);

    for (const page of bd.pages) createPage(lib.store, chapter.id, page.layoutPreset);
    createCoverPage(lib.store, manga.id, chapter.id);
    const prompts = await ask<PromptsOutput>(run, 'prompts');
    const pages = engine.calls.map((c) => [...new Set(extractContext<PromptsContext>(c.prompt).panels.map((p) => p.page))]);
    expect(pages).toHaveLength(11); // ten story pages, then the cover
    expect(pages.every((p) => p.length === 1)).toBe(true);
    expect(prompts.panels).toHaveLength(21);
    expect(prompts.panels.at(-1)!.scene).toContain('looking at viewer');
  });

  it('are part of FAKE_RESPONSES', async () => {
    for (const key of Object.keys(EPISODE_FAKE_RESPONSES)) expect(FAKE_RESPONSES[key]).toBe(EPISODE_FAKE_RESPONSES[key]);
    expect(Object.keys(EPISODE_FAKE_RESPONSES).sort()).toEqual(['episode.breakdown', 'episode.outline', 'episode.premise', 'episode.prompts', 'episode.scripts']);
    expect(PremiseOutputSchema.safeParse(EPISODE_FAKE_RESPONSES['episode.premise']!({
      name: 'episode.premise', task: 'story', system: '', schema: PremiseOutputSchema,
      prompt: '<context>{"step":"premise","language":"en","manga":{"title":"M","synopsis":""},"request":{"prompt":"p","tone":"","pages":1},"characters":[]}</context>',
    })).success).toBe(true);
  });
});
