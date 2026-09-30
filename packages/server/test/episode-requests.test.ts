// packages/server/test/episode-requests.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { EpisodeRun, ScriptsOutput } from '@manga/shared';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import { buildStepContext, extractContext, templateVars, type PromptsContext, type ScriptsContext } from '../src/workflows/episode/context.js';
import { loadStepPrompt, renderTemplate } from '../src/workflows/episode/prompts.js';
import { SCRIPTS_PAGES_PER_CALL, combineAnswers, stepRequests } from '../src/workflows/episode/requests.js';
import { PREMISE, TWO_PANEL_PRESET, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

function scriptsRun(pages: number): EpisodeRun {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  seedCharacter(lib.store, manga.id, 'Aiko');
  return seedRun(lib.store, chapter.id, { input: { pages }, outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: breakdown(pages) } });
}

const issues = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }): string[] => (r.error?.issues ?? []).map((i) => i.message);

describe('stepRequests', () => {
  it('asks premise, outline and breakdown in one call each, exactly like the whole-step prompt', () => {
    const run = scriptsRun(2);
    for (const step of ['premise', 'outline', 'breakdown'] as const) {
      const vars = templateVars(lib.store, run, buildStepContext(lib.store, run, step));
      const [only, ...rest] = stepRequests(lib.store, run, step);
      expect(rest).toEqual([]);
      expect(only).toMatchObject({
        name: `episode.${step}`, system: renderTemplate(loadStepPrompt(step).system, vars), prompt: renderTemplate(loadStepPrompt(step).user, vars),
      });
    }
    expect(stepRequests(lib.store, run, 'scripts')).toHaveLength(1); // 2 pages fit one call
  });

  it(`writes scripts in chunks of at most ${SCRIPTS_PAGES_PER_CALL} pages with the same context (F18)`, () => {
    const run = scriptsRun(10);
    const requests = stepRequests(lib.store, run, 'scripts');
    expect(requests.map((r) => r.task)).toEqual(['dialogue', 'dialogue', 'dialogue']);
    const contexts = requests.map((r) => extractContext<ScriptsContext>(r.prompt));
    expect(contexts.map((c) => c.pages.map((p) => p.page))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
    expect(contexts.map((c) => c.pageRange)).toEqual([{ first: 1, last: 4, total: 10 }, { first: 5, last: 8, total: 10 }, { first: 9, last: 10, total: 10 }]);
    expect(contexts[1]!.scenes).toEqual(contexts[0]!.scenes);
    expect(contexts[2]!.characters).toEqual([{ name: 'Aiko', role: 'main', personality: '', speechStyle: '' }]);
    expect(requests.map((r) => r.progress)).toEqual([
      'Writing scripts (pages 1–4 of 10)…', 'Writing scripts (pages 5–8 of 10)…', 'Writing scripts (pages 9–10 of 10)…',
    ]);
  });

  it('validates each scripts chunk with absolute page numbers in its messages', () => {
    const run = scriptsRun(10);
    const second = stepRequests(lib.store, run, 'scripts')[1]!;
    const whole = scripts(breakdown(10), 'Aiko');
    const chunk: ScriptsOutput = { pages: whole.pages.slice(4, 8) };
    expect(second.schema.safeParse(chunk).success).toBe(true);
    const short = { pages: chunk.pages.map((p, i) => (i === 1 ? { panels: p.panels.slice(0, 1) } : p)) };
    expect(issues(second.schema.safeParse(short))).toEqual(['page 6 needs exactly 2 panels (from the breakdown), got 1']);
    expect(issues(second.schema.safeParse({ pages: chunk.pages.slice(0, 3) }))).toEqual(['expected exactly 4 pages (pages 5–8 of the breakdown), got 3']);
  });

  it('the outline request refuses a scene character that is neither in the manga nor in newCharacters', () => {
    const run = scriptsRun(2);
    const [only] = stepRequests(lib.store, run, 'outline');
    expect(issues(only!.schema.safeParse(outline(['Aiko', 'Villagers'])))).toEqual([
      'unknown character "Villagers": add "Villagers" to newCharacters (with appearanceTags) or remove it; groups and crowds are not characters',
      'unknown character "Villagers": add "Villagers" to newCharacters (with appearanceTags) or remove it; groups and crowds are not characters',
    ]);
    expect(() => combineAnswers(lib.store, run, 'outline', [outline(['Aiko', 'Villagers'])])).toThrow(ZodError);
  });

  it('combines the scripts chunks and validates the whole', () => {
    const run = scriptsRun(10);
    const whole = scripts(breakdown(10), 'Aiko');
    const answers = [0, 4, 8].map((at) => ({ pages: whole.pages.slice(at, at + SCRIPTS_PAGES_PER_CALL) }));
    expect(combineAnswers(lib.store, run, 'scripts', answers)).toEqual(whole);
    expect(() => combineAnswers(lib.store, run, 'scripts', answers.slice(0, 2))).toThrow(ZodError);
  });

  it('writes image prompts one page per call, the cover last, each call limited to its own panels (F18)', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const bd = breakdown(2);
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE, outline: outline([]), breakdown: bd, scripts: scripts(bd, null) } });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    createCoverPage(lib.store, manga.id, chapter.id);
    const ids = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel.id);

    const requests = stepRequests(lib.store, run, 'prompts');
    const contexts = requests.map((r) => extractContext<PromptsContext>(r.prompt));
    expect(contexts.map((c) => c.panels.map((p) => p.panelId))).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    expect(requests.map((r) => r.progress)).toEqual(['Writing image prompts (page 1 of 2)…', 'Writing image prompts (page 2 of 2)…', 'Writing image prompts (cover)…']);
    expect(requests.every((r) => r.system.includes('use no colour words'))).toBe(true);

    const answer = (panelIds: string[]) => ({ panels: panelIds.map((panelId) => ({ panelId, scene: 'solo, rain' })) });
    expect(requests[0]!.schema.safeParse(answer(ids.slice(0, 2))).success).toBe(true);
    expect(requests[0]!.schema.safeParse(answer(ids.slice(0, 3))).success).toBe(false);
    const whole = combineAnswers(lib.store, run, 'prompts', [answer(ids.slice(0, 2)), answer(ids.slice(2, 4)), answer(ids.slice(4))]);
    expect((whole as { panels: Array<{ panelId: string }> }).panels.map((p) => p.panelId)).toEqual(ids);
    expect(() => combineAnswers(lib.store, run, 'prompts', [answer(ids.slice(0, 2))])).toThrow(/missing panelIds/);
  });

  it("keeps a natural-style panel's picture lines inside its per-page chunk (F3 with F18)", () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const mika = seedCharacter(lib.store, manga.id, 'Mika');
    const bd = breakdown(2);
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE, outline: outline([]), breakdown: bd, scripts: scripts(bd, null) } });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const secondPage = chapterPanels(lib.store, chapter.id, manga.readingDirection).filter((e) => e.pageNumber === 2);
    const duo = secondPage[1]!.panel;
    const stage = (id: string) => ({ characterId: id, pose: '', expression: '', position: 'left' as const });
    updatePanel(lib.store, duo.id, { characters: [stage(aiko.id), stage(mika.id)] }, { refCharacterIds: [aiko.id, mika.id] });

    const chunk = extractContext<PromptsContext>(stepRequests(lib.store, run, 'prompts')[1]!.prompt);
    expect(chunk.panels.map((p) => p.panelId)).toEqual(secondPage.map((e) => e.panel.id));
    expect(chunk.panels[1]).toMatchObject({ style: 'natural', pictures: ['picture 1 shows Aiko', 'picture 2 shows Mika'] });
    expect(chunk.panels[0]).toMatchObject({ style: 'tags' });
  });

  it('refuses several answers for a one-call step', () => {
    const run = scriptsRun(2);
    expect(() => combineAnswers(lib.store, run, 'premise', [PREMISE, PREMISE])).toThrow('step premise makes one call, got 2 answers');
    expect(combineAnswers(lib.store, run, 'premise', [PREMISE])).toEqual(PREMISE);
  });
});
