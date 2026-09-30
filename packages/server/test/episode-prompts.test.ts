// packages/server/test/episode-prompts.test.ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { withJsonInstruction } from '../src/engines/structured.js';
import { ConflictError } from '../src/errors.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import {
  buildStepContext, contextBlock, extractContext, templateVars,
  type BreakdownContext, type PremiseContext, type PromptsContext,
} from '../src/workflows/episode/context.js';
import { loadStepPrompt, renderTemplate } from '../src/workflows/episode/prompts.js';
import { LLM_STEPS } from '../src/workflows/episode/steps.js';
import { validationSchema } from '../src/workflows/episode/validation.js';
import { PREMISE, TWO_PANEL_PRESET, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** A run whose outputs exist up to prompts, with two story pages and a cover materialized. */
function fullWorld() {
  const { manga, chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
  const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, short black hair');
  const bd = breakdown(2);
  const run = seedRun(lib.store, chapter.id, {
    input: { characterIds: [aiko.id], tone: 'gentle' },
    outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') },
  });
  const p1 = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  createCoverPage(lib.store, manga.id, chapter.id);
  const first = p1.panels[0]!;
  lib.store.panels.update(first.id, { script: { ...first.script, characters: [{ characterId: aiko.id, pose: 'running', expression: 'worried', position: 'right' }] } });
  return { manga, chapter, aiko, run };
}

const renderedSystem = (run: Parameters<typeof buildStepContext>[1], step: (typeof LLM_STEPS)[number]): string =>
  renderTemplate(loadStepPrompt(step).system, templateVars(lib.store, run, buildStepContext(lib.store, run, step)));

describe('step prompts', () => {
  it('every step prompt has a system part and a user part ending with the context', () => {
    for (const step of LLM_STEPS) {
      const p = loadStepPrompt(step);
      expect(p.system).toContain('Reply with only a JSON object');
      expect(p.system).not.toContain('<!--');
      expect(p.user.trimEnd().endsWith('{{context}}')).toBe(true);
    }
  });

  it('are read by the M2 loadPrompt from the prompts/episode sub-folder (F28)', () => {
    for (const step of LLM_STEPS) expect(existsSync(fileURLToPath(new URL(`../src/prompts/episode/${step}.md`, import.meta.url)))).toBe(true);
  });

  it('renders placeholders literally and refuses unknown ones', () => {
    expect(renderTemplate('a {{x}} b', { x: '$1 $&' })).toBe('a $1 $& b');
    expect(() => renderTemplate('{{nope}}', {})).toThrow('template placeholder {{nope}} has no value');
  });

  it('every prompt renders completely for its step', () => {
    const { run } = fullWorld();
    for (const step of LLM_STEPS) {
      const vars = templateVars(lib.store, run, buildStepContext(lib.store, run, step));
      const p = loadStepPrompt(step);
      const text = renderTemplate(p.system, vars) + renderTemplate(p.user, vars);
      expect(text).not.toMatch(/\{\{\w+\}\}/);
      expect(text).toContain('<context>');
    }
    expect(templateVars(lib.store, run, buildStepContext(lib.store, run, 'premise'))['languageName']).toBe('Ukrainian');
  });

  it('keeps the context out of the system prompt, which stays small for the Claude argv (G2)', () => {
    const { run } = fullWorld();
    for (const step of LLM_STEPS) {
      const system = renderedSystem(run, step);
      expect(system).not.toContain('<context>');
      expect(withJsonInstruction(system, validationSchema(lib.store, run, step)).length).toBeLessThan(8000);
    }
  });

  it('never asks the prompts step for camera framing: the code adds it from the script (F2, I2)', () => {
    const { run } = fullWorld();
    const system = renderedSystem(run, 'prompts');
    expect(system).toContain('never write shot size or camera angle');
    expect(system).not.toMatch(/Map the (script's )?shot/i);
    const ctx = buildStepContext(lib.store, run, 'prompts') as PromptsContext;
    expect(ctx.panels[0]).toMatchObject({ camera: 'medium shot, eye level' });
    expect(ctx.panels[0]).not.toHaveProperty('shot');
    expect(ctx.panels[0]).not.toHaveProperty('angle');
  });

  it('forbids colour words for a black-and-white manga only (F26)', () => {
    const { run, manga } = fullWorld();
    expect(renderedSystem(run, 'prompts')).toContain('use no colour words');
    lib.store.mangas.update(manga.id, { colorMode: 'color' });
    expect(renderedSystem(run, 'prompts')).not.toContain('no colour words');
  });
});

describe('step contexts', () => {
  it('premise context carries the request and the chosen cast, without appearance', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'premise') as PremiseContext;
    expect(ctx.request).toEqual({ prompt: 'A lost cat in the rain', tone: 'gentle', pages: 2 });
    expect(ctx.characters).toEqual([{ name: 'Aiko', role: 'main', personality: '', speechStyle: '' }]);
    expect(contextBlock(ctx)).not.toContain('short black hair');
  });

  it('breakdown context numbers the scenes and lists every preset with its panel count', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'breakdown') as BreakdownContext;
    expect(ctx.scenes.map((s) => s.idx)).toEqual([0, 1]);
    expect(ctx.presets).toContainEqual({ name: TWO_PANEL_PRESET, panelCount: 2 });
  });

  it('prompts context lists story panels in reading order, then the cover, with character names', () => {
    const { run, chapter, manga } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'prompts') as PromptsContext;
    const entries = chapterPanels(lib.store, chapter.id, manga.readingDirection);
    expect(ctx.panels.map((p) => p.panelId)).toEqual(entries.map((e) => e.panel.id));
    expect(ctx.panels.map((p) => [p.page, p.isCover])).toEqual([[1, false], [1, false], [2, false], [2, false], [0, true]]);
    expect(ctx.panels.map((p) => p.style)).toEqual(['tags', 'tags', 'tags', 'tags', 'tags']);
    expect(ctx.panels.find((p) => p.characters.length > 0)?.characters[0]).toEqual({ name: 'Aiko', pose: 'running', expression: 'worried', position: 'right' });
  });

  it('gives each panel the style of the recipe it will route to, assuming every cast member gets a portrait (F3)', () => {
    const { run, chapter, manga, aiko } = fullWorld();
    const mika = seedCharacter(lib.store, manga.id, 'Mika');
    const [duo, solo] = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel);
    const stage = (id: string, position: 'left' | 'right') => ({ characterId: id, pose: '', expression: '', position });
    updatePanel(lib.store, duo!.id, { characters: [stage(aiko.id, 'left'), stage(mika.id, 'right')] }, { refCharacterIds: [aiko.id, mika.id] });
    updatePanel(lib.store, solo!.id, { characters: [stage(aiko.id, 'left')] }, { refCharacterIds: [aiko.id] });

    let ctx = buildStepContext(lib.store, run, 'prompts') as PromptsContext;
    // Nobody has a portrait yet: two cast members still route to multiChar (qwen-edit-ref), one to oneChar (anime-ref).
    expect(ctx.panels[0]).toMatchObject({ style: 'natural', pictures: ['picture 1 shows Aiko', 'picture 2 shows Mika'] });
    expect(ctx.panels[1]!.style).toBe('tags');
    expect(ctx.panels[1]).not.toHaveProperty('pictures');

    // A natural oneChar recipe numbers one character's portrait and full body like pickRefs does.
    lib.store.settings.patch({ routing: { oneChar: 'klein-ref' } });
    giveRefs(lib.store, aiko, ['portrait', 'fullbody']);
    ctx = buildStepContext(lib.store, run, 'prompts') as PromptsContext;
    expect(ctx.panels[1]).toMatchObject({ style: 'natural', pictures: ['picture 1 shows Aiko', 'picture 2 shows Aiko'] });
  });

  it('extractContext reads the block back', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'outline');
    expect(extractContext(`intro\n${contextBlock(ctx)}\n`)).toEqual(ctx);
    expect(() => extractContext('no block')).toThrow('prompt has no <context> block');
  });
});

describe('validationSchema', () => {
  it("uses the run's page count and the manga's character names", () => {
    const { run } = fullWorld();
    expect(validationSchema(lib.store, run, 'breakdown').safeParse(breakdown(1)).success).toBe(false);
    expect(validationSchema(lib.store, run, 'breakdown').safeParse(breakdown(2)).success).toBe(true);
    expect(validationSchema(lib.store, run, 'scripts').safeParse(scripts(breakdown(2), 'aiko')).success).toBe(true);
    expect(validationSchema(lib.store, run, 'scripts').safeParse(scripts(breakdown(2), 'Mika')).success).toBe(false);
  });

  it('refuses to build a schema that needs a missing earlier output', () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE } });
    expect(() => validationSchema(lib.store, run, 'breakdown')).toThrow(ConflictError);
    expect(() => validationSchema(lib.store, run, 'breakdown')).toThrow('step outline has no output yet');
  });
});
