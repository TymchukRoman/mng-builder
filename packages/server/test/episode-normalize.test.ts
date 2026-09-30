// packages/server/test/episode-normalize.test.ts
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BreakdownOutputSchema, OutlineOutputSchema, PremiseOutputSchema, PromptsOutputSchema, ScriptsOutputSchema,
} from '@manga/shared';
import type { PromptsPanelBrief } from '../src/workflows/episode/context.js';
import { jsonSchemaOf } from '../src/engines/structured.js';
import { STEP_SHAPES, normalizeLlmAnswer } from '../src/workflows/episode/normalize.js';
import { PREMISE, breakdown, outline, scripts } from './helpers/episode-fixtures.js';

const panel = (over: Record<string, unknown> = {}) => ({
  action: 'Aiko runs', shot: 'wide', angle: 'eye', characters: [{ name: 'Aiko', pose: 'running', expression: 'calm', position: 'left' }],
  background: 'street', dialogue: [{ speaker: 'Aiko', kind: 'speech', text: 'Hi' }], ...over,
});
const scriptsAnswer = (p: Record<string, unknown>) => ({ pages: [{ panels: [p] }] });
const firstPanel = (value: unknown) => (value as { pages: Array<{ panels: Array<Record<string, unknown>> }> }).pages[0]!.panels[0]!;

const brief = (panelId: string, over: Partial<PromptsPanelBrief> = {}): PromptsPanelBrief => ({
  panelId, page: 1, isCover: false, style: 'tags', camera: 'medium shot', action: 'Naruto leaps over the gate', background: 'village gate at dawn',
  characters: [{ name: 'Naruto', pose: 'leaping', expression: 'grinning', position: 'left' }, { name: 'Sasuke', pose: 'standing', expression: 'calm', position: 'right' }],
  ...over,
});

describe('normalizeLlmAnswer: free-text fields', () => {
  it("coerces Roman's object negative to its text, and an empty one to null", () => {
    const raw = { panels: [{ panelId: 'pn_a', scene: 'x', negative: { 'extra people': 'extra people' } }, { panelId: 'pn_b', scene: 'y', negative: {} }] };
    const { value } = normalizeLlmAnswer('prompts', raw, { panels: [brief('pn_a'), brief('pn_b')] });
    expect(value).toEqual({ panels: [{ panelId: 'pn_a', scene: 'x', negative: 'extra people' }, { panelId: 'pn_b', scene: 'y', negative: null }] });
    expect(PromptsOutputSchema.safeParse(value).success).toBe(true);
  });

  it('joins arrays and objects (values, and the keys of true values); numbers and booleans become strings', () => {
    const raw = {
      scenes: [{ summary: ['Naruto trains', 'Sasuke watches', { at: 'dawn' }], purpose: 3, location: { place: 'Konoha', gate: true, closed: false }, characterNames: ['Naruto'] }],
      newCharacters: [{ name: 'Naruto', role: 'main', personality: true, speechStyle: null, appearanceTags: ['1boy', 'spiky blond hair'] }],
    };
    const { value } = normalizeLlmAnswer('outline', raw);
    expect(value).toEqual({
      scenes: [{ summary: 'Naruto trains, Sasuke watches, dawn', purpose: '3', location: 'Konoha, gate', characterNames: ['Naruto'] }],
      newCharacters: [{ name: 'Naruto', role: 'main', personality: 'true', speechStyle: '', appearanceTags: '1boy, spiky blond hair' }],
    });
    expect(OutlineOutputSchema.safeParse(value).success).toBe(true);
  });

  it('coerces the premise and scripts text fields too', () => {
    expect(normalizeLlmAnswer('premise', { ...PREMISE, tone: ['dark', 'tense'], setting: { city: 'Konoha' } }).value)
      .toEqual({ ...PREMISE, tone: 'dark, tense', setting: 'Konoha' });
    const p = firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({
      action: ['Aiko runs', 'she stops'], background: 42,
      characters: [{ name: 'Aiko', pose: ['running'], expression: { mood: 'calm' }, position: 'left' }],
      dialogue: [{ speaker: 'Aiko', kind: 'speech', text: ['Wait', 'for me!'] }],
    }))).value);
    expect(p).toMatchObject({
      action: 'Aiko runs, she stops', background: '42', characters: [{ pose: 'running', expression: 'calm' }], dialogue: [{ text: 'Wait, for me!' }],
    });
  });
});

describe('normalizeLlmAnswer: enum fields', () => {
  const shotOf = (shot: unknown) => firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({ shot }))).value)['shot'];
  const angleOf = (angle: unknown) => firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({ angle }))).value)['angle'];
  const kindOf = (kind: unknown) => (firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({ dialogue: [{ speaker: null, kind, text: 'x' }] }))).value)['dialogue'] as Array<{ kind: string }>)[0]!.kind;
  const positionOf = (position: unknown) => (firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({ characters: [{ name: 'A', pose: '', expression: '', position }] }))).value)['characters'] as Array<{ position: string }>)[0]!.position;
  const roleOf = (role: unknown) => (normalizeLlmAnswer('outline', outline(['A'], [{ name: 'A', role: role as 'main', personality: '', speechStyle: '', appearanceTags: '1boy' }])).value as { newCharacters: Array<{ role: string }> }).newCharacters[0]!.role;

  it('maps case, spacing, hyphens and synonyms of shots', () => {
    expect(['Close-Up', 'closeup', ' CLOSE ', 'close_up', 'close shot'].map(shotOf)).toEqual(['close', 'close', 'close', 'close', 'close']);
    expect(['extreme close up', 'Extreme-Close', 'ECU'].map(shotOf)).toEqual(['extreme-close', 'extreme-close', 'extreme-close']);
    expect(['long shot', 'Wide Shot', 'full shot', 'establishing shot', 'extreme wide'].map(shotOf)).toEqual(['wide', 'wide', 'wide', 'extreme-wide', 'extreme-wide']);
    expect(['mid shot', 'medium close-up', 'dramatic', 7, null].map(shotOf)).toEqual(['medium', 'close', 'medium', 'medium', 'medium']);
  });

  it('maps angles, dialogue kinds, positions and roles, with a safe default', () => {
    expect(['eye level', 'Eye-Level', "bird's eye", 'birds-eye', 'top-down', "worm's eye", 'low angle', 'Dutch angle', 'weird'].map(angleOf))
      .toEqual(['eye', 'eye', 'overhead', 'overhead', 'overhead', 'low', 'low', 'dutch', 'eye']);
    expect(['narrator', 'Narration', 'caption', 'sound', 'Sound Effect', 'SFX', 'thought bubble', 'thinking', 'yell', 'dialogue', '??'].map(kindOf))
      .toEqual(['narration', 'narration', 'narration', 'sfx', 'sfx', 'sfx', 'thought', 'thought', 'shout', 'speech', 'speech']);
    expect(['Centre', 'middle', 'LEFT', 'far right', 'above'].map(positionOf)).toEqual(['center', 'center', 'left', 'right', 'center']);
    expect(['Protagonist', 'side character', 'Minor', 'villain'].map(roleOf)).toEqual(['main', 'supporting', 'minor', 'supporting']);
  });
});

describe('normalizeLlmAnswer: arrays, numbers and speakers', () => {
  it('wraps a single object or string where an array is expected; null becomes [] where an array may be empty', () => {
    const p = firstPanel(normalizeLlmAnswer('scripts', { pages: [{ panels: panel({ characters: { name: 'Aiko', pose: '', expression: '', position: 'left' }, dialogue: null }) }] }).value);
    expect(p['characters']).toEqual([{ name: 'Aiko', pose: '', expression: '', position: 'left' }]);
    expect(p['dialogue']).toEqual([]);
    const o = normalizeLlmAnswer('outline', { scenes: { summary: 's', purpose: '', location: '', characterNames: 'Naruto' } }).value;
    expect(o).toEqual({ scenes: [{ summary: 's', purpose: '', location: '', characterNames: ['Naruto'] }], newCharacters: [] });
    // An array that needs items stays empty-handed, so validation still refuses it.
    expect(normalizeLlmAnswer('outline', { scenes: null, newCharacters: [] }).value).toEqual({ scenes: null, newCharacters: [] });
  });

  it('reads whole numbers written as text, and wraps a lone scene index', () => {
    const raw = { pages: [{ sceneIdx: 1, panelCount: '4', pacing: 'fast', layoutPreset: '2x2' }, { sceneIdx: ['0', 1], panelCount: 3.5, pacing: '', layoutPreset: '3-rows' }] };
    expect(normalizeLlmAnswer('breakdown', raw).value).toEqual({
      pages: [{ sceneIdx: [1], panelCount: 4, pacing: 'fast', layoutPreset: '2x2' }, { sceneIdx: [0, 1], panelCount: 3.5, pacing: '', layoutPreset: '3-rows' }],
    });
  });

  it('turns an empty, "none" or "narrator" speaker into no speaker', () => {
    const lines = ['', '  ', 'none', 'None', 'narrator', 'N/A', 'null', 'Aiko', null].map((speaker) => ({ speaker, kind: 'narration', text: 'x' }));
    const p = firstPanel(normalizeLlmAnswer('scripts', scriptsAnswer(panel({ dialogue: lines }))).value);
    expect((p['dialogue'] as Array<{ speaker: string | null }>).map((d) => d.speaker)).toEqual([null, null, null, null, null, null, null, 'Aiko', null]);
  });
});

describe('normalizeLlmAnswer: prompts', () => {
  it('drops unknown panel ids, keeps the first entry per panel and writes a missing panel from its script', () => {
    const offered = [brief('pn_a'), brief('pn_b', { style: 'natural' }), brief('pn_c', { characters: [] })];
    const raw = {
      panels: [
        { panelId: 'pn_a', scene: 'first' }, { panelId: 'pn_zz', scene: 'invented' }, { panelId: 'pn_a', scene: 'second' }, 'junk', { scene: 'no id' },
      ],
    };
    const { value, filled } = normalizeLlmAnswer('prompts', raw, { panels: offered });
    expect(filled).toEqual(['pn_b', 'pn_c']);
    expect(value).toEqual({
      panels: [
        { panelId: 'pn_a', scene: 'first' },
        { panelId: 'pn_b', scene: 'Naruto and Sasuke: Naruto leaps over the gate. Background: village gate at dawn.' },
        { panelId: 'pn_c', scene: 'Naruto leaps over the gate, village gate at dawn' },
      ],
    });
    expect(PromptsOutputSchema.safeParse(value).success).toBe(true);
  });

  it('a tags panel lists its characters first; a panel with an empty scene is written from its script too', () => {
    const { value, filled } = normalizeLlmAnswer('prompts', { panels: [{ panelId: 'pn_a', scene: '  ' }] }, { panels: [brief('pn_a')] });
    expect(filled).toEqual(['pn_a']);
    expect(value).toEqual({ panels: [{ panelId: 'pn_a', scene: 'Naruto, Sasuke, Naruto leaps over the gate, village gate at dawn' }] });
  });

  it('without the offered panels it only fixes the fields', () => {
    const raw = { panels: [{ panelId: 'pn_zz', scene: 'x', negative: ['a', 'b'] }] };
    expect(normalizeLlmAnswer('prompts', raw)).toEqual({ value: { panels: [{ panelId: 'pn_zz', scene: 'x', negative: 'a, b' }] }, filled: [] });
  });
});

describe('normalizeLlmAnswer: safety', () => {
  it('leaves a valid answer of every step exactly as it was', () => {
    const bd = breakdown(2);
    const cases = [
      ['premise', PREMISE, PremiseOutputSchema], ['outline', outline(['Aiko']), OutlineOutputSchema], ['breakdown', bd, BreakdownOutputSchema],
      ['scripts', scripts(bd, 'Aiko'), ScriptsOutputSchema], ['scripts', scripts(bd, null), ScriptsOutputSchema],
      ['prompts', { panels: [{ panelId: 'pn_a', scene: 'x', negative: 'blur' }, { panelId: 'pn_b', scene: 'y' }] }, PromptsOutputSchema],
    ] as const;
    for (const [step, answer, schema] of cases) {
      const before = structuredClone(answer);
      const { value, filled } = normalizeLlmAnswer(step, answer, step === 'prompts' ? { panels: [brief('pn_a'), brief('pn_b')] } : {});
      expect(value).toEqual(before);
      expect(answer).toEqual(before); // the input is never mutated
      expect(filled).toEqual([]);
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it('never throws, and returns what it cannot help unchanged', () => {
    const odd: unknown[] = [null, undefined, 42, 'text', [], [1, 2], { pages: 'x' }, { panels: [null, 3] }, { scenes: [[]] }];
    for (const step of ['premise', 'outline', 'breakdown', 'scripts', 'prompts'] as const) {
      for (const raw of odd) {
        expect(() => normalizeLlmAnswer(step, raw, { panels: [brief('pn_a')] })).not.toThrow();
      }
      expect(normalizeLlmAnswer(step, 'text').value).toBe('text');
      expect(normalizeLlmAnswer(step, null).value).toBeNull();
    }
    const cyclic: Record<string, unknown> = { title: 't' };
    cyclic['synopsis'] = cyclic;
    expect(() => normalizeLlmAnswer('premise', cyclic)).not.toThrow();
  });
});

describe('STEP_SHAPES', () => {
  type Json = { type?: string; enum?: string[]; properties?: Record<string, Json>; items?: Json; anyOf?: Json[] };
  /** Every string or enum leaf of a JSON Schema, as "pages[].panels[].shot" → "string" | "enum:a|b". */
  function leaves(node: Json, path: string, out: Map<string, string>): Map<string, string> {
    if (node.anyOf) for (const alt of node.anyOf) leaves(alt, path, out);
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) leaves(v, path === '' ? k : `${path}.${k}`, out);
    if (node.items) leaves(node.items, `${path}[]`, out);
    if (node.type === 'string') out.set(path, node.enum ? `enum:${node.enum.join('|')}` : 'string');
    return out;
  }
  function shapeLeaves(shape: (typeof STEP_SHAPES)[keyof typeof STEP_SHAPES], path: string, out: Map<string, string>): Map<string, string> {
    if (shape.kind === 'object') for (const [k, v] of Object.entries(shape.fields)) shapeLeaves(v, path === '' ? k : `${path}.${k}`, out);
    else if (shape.kind === 'array') shapeLeaves(shape.of, `${path}[]`, out);
    else if (shape.kind === 'enum') out.set(path, `enum:${shape.values.join('|')}`);
    else if (shape.kind === 'text' || shape.kind === 'speaker' || shape.kind === 'id') out.set(path, 'string');
    return out;
  }

  it('covers every string and enum field of the step output schemas, with their real enum values', () => {
    const schemas: Record<keyof typeof STEP_SHAPES, z.ZodType<unknown>> = {
      premise: PremiseOutputSchema, outline: OutlineOutputSchema, breakdown: BreakdownOutputSchema, scripts: ScriptsOutputSchema, prompts: PromptsOutputSchema,
    };
    for (const [step, schema] of Object.entries(schemas)) {
      const fromSchema = leaves(jsonSchemaOf(schema) as Json, '', new Map());
      const fromShape = shapeLeaves(STEP_SHAPES[step as keyof typeof schemas], '', new Map());
      expect(fromSchema.size).toBeGreaterThan(0);
      for (const [path, kind] of fromSchema) expect(`${step} ${path} ${fromShape.get(path)}`).toBe(`${step} ${path} ${kind}`);
    }
  });
});

describe('normalizeLlmAnswer: outline count tags (Roman: "Дебіл" was "1other, fat man" and rendered as a woman)', () => {
  const tagsOf = (appearanceTags: unknown) =>
    (normalizeLlmAnswer('outline', { scenes: outline(['A']).scenes, newCharacters: [{ name: 'A', role: 'main', personality: '', speechStyle: '', appearanceTags }] }).value as
      { newCharacters: Array<{ appearanceTags: string }> }).newCharacters[0]!.appearanceTags;

  it('turns a clearly gendered 1other into 1boy or 1girl, and adds a missing count tag', () => {
    expect(tagsOf('1other, fat man, long hair, wavy hair, aristocratic clothes')).toBe('1boy, fat man, long hair, wavy hair, aristocratic clothes');
    expect(tagsOf('1other, old woman, shawl')).toBe('1girl, old woman, shawl');
    expect(tagsOf(['king', 'beard', 'crown'])).toBe('1boy, king, beard, crown');
  });

  it('keeps a correct, unknown or non-human count as the model wrote it', () => {
    for (const tags of ['1boy, spiky blond hair', '1girl, bob cut', '1other, hooded cloak', 'no humans, cat']) expect(tagsOf(tags)).toBe(tags);
  });
});
