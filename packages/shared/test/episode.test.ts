// packages/shared/test/episode.test.ts
import { describe, expect, it } from 'vitest';
import {
  EDITABLE_STEPS, OutlineOutputSchema, PremiseOutputSchema, RenderOutputSchema, STEP_OUTPUT_SCHEMAS, STEP_TASK,
  breakdownSchemaFor, estimateSeconds, formatEstimate, promptsSchemaFor, sameName, scriptsSchemaFor, stepIndex,
  type PanelScriptDraft,
} from '../src/episode.js';
import { PRESET_NAMES, presetPanelCount } from '../src/layout/index.js';

const TWO = PRESET_NAMES.find((n) => presetPanelCount(n) === 2)!;
const THREE = PRESET_NAMES.find((n) => presetPanelCount(n) === 3)!;
const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

const panel = (over: Partial<PanelScriptDraft> = {}): PanelScriptDraft => ({
  action: 'Aiko opens the door', shot: 'medium', angle: 'eye',
  characters: [{ name: 'Aiko', pose: 'standing', expression: 'surprised', position: 'left' }],
  background: 'hallway', dialogue: [{ speaker: 'Aiko', kind: 'speech', text: 'Who is there?' }], ...over,
});

describe('premise and outline', () => {
  it('accepts a complete premise and rejects an empty title', () => {
    expect(PremiseOutputSchema.safeParse({ title: 'Rain', synopsis: 'A cat.', tone: 'soft', setting: 'Kyiv' }).success).toBe(true);
    expect(PremiseOutputSchema.safeParse({ title: '', synopsis: 'A cat.', tone: '', setting: '' }).success).toBe(false);
  });

  it('trims new character names and refuses a blank one (M4 final M1)', () => {
    const scene = { summary: 'They meet', purpose: 'setup', location: 'street', characterNames: ['Aiko'] };
    const draft = { role: 'supporting', personality: '', speechStyle: '', appearanceTags: '1girl' };
    expect(OutlineOutputSchema.safeParse({ scenes: [scene], newCharacters: [{ ...draft, name: '   ' }] }).success).toBe(false);
    expect(OutlineOutputSchema.parse({ scenes: [scene], newCharacters: [{ ...draft, name: ' Mika ' }] }).newCharacters[0]!.name).toBe('Mika');
  });

  it('needs at least one scene and a valid role for new characters', () => {
    expect(OutlineOutputSchema.safeParse({ scenes: [], newCharacters: [] }).success).toBe(false);
    const scene = { summary: 'They meet', purpose: 'setup', location: 'street', characterNames: ['Aiko'] };
    expect(OutlineOutputSchema.safeParse({ scenes: [scene], newCharacters: [] }).success).toBe(true);
    const bad = { name: 'Mika', role: 'hero', personality: '', speechStyle: '', appearanceTags: '1girl' };
    expect(OutlineOutputSchema.safeParse({ scenes: [scene], newCharacters: [bad] }).success).toBe(false);
  });
});

describe('breakdownSchemaFor', () => {
  const schema = breakdownSchemaFor({ pages: 2, sceneCount: 2 });
  const page = (layoutPreset: string, panelCount: number, sceneIdx = [0]) => ({ sceneIdx, panelCount, pacing: 'steady', layoutPreset });

  it('accepts presets whose panel count matches', () => {
    expect(schema.safeParse({ pages: [page(TWO, 2), page(THREE, 3, [1])] }).success).toBe(true);
  });

  it('rejects an unknown preset and names the valid ones', () => {
    const r = schema.safeParse({ pages: [page('nope', 2), page(TWO, 2)] });
    expect(issuesOf(r)[0]).toMatch(/^pages\.0\.layoutPreset: unknown layout preset "nope"; use one of: /);
  });

  it('rejects a preset whose panel count differs', () => {
    const r = schema.safeParse({ pages: [page(TWO, 3), page(TWO, 2)] });
    expect(issuesOf(r)).toEqual([`pages.0.panelCount: layout "${TWO}" has 2 panels but panelCount is 3`]);
  });

  it('rejects the wrong number of pages and out-of-range scene indexes', () => {
    const r = schema.safeParse({ pages: [page(TWO, 2, [0, 5])] });
    expect(issuesOf(r)).toEqual([
      'pages: expected exactly 2 pages, got 1',
      'pages.0.sceneIdx.1: scene index 5 does not exist (the outline has 2 scenes, numbered from 0)',
    ]);
  });
});

describe('scriptsSchemaFor', () => {
  const schema = scriptsSchemaFor({ panelCounts: [2], knownNames: ['Aiko', 'Ren'] });

  it('accepts known names and null speakers', () => {
    const narration = panel({ dialogue: [{ speaker: null, kind: 'narration', text: 'Night.' }] });
    expect(schema.safeParse({ pages: [{ panels: [panel(), narration] }] }).success).toBe(true);
  });

  it('scripts schema matches names case-insensitively', () => {
    const odd = panel({
      characters: [{ name: '  aiko ', pose: '', expression: '', position: 'center' }],
      dialogue: [{ speaker: 'REN', kind: 'shout', text: 'Wait!' }],
    });
    expect(schema.safeParse({ pages: [{ panels: [odd, panel()] }] }).success).toBe(true);
  });

  it('treats an empty or blank speaker as no speaker', () => {
    const blank = panel({ dialogue: [{ speaker: '', kind: 'sfx', text: 'BOOM' }, { speaker: '  ', kind: 'narration', text: 'Later.' }] });
    const r = schema.safeParse({ pages: [{ panels: [blank, panel()] }] });
    expect(r.success).toBe(true);
    expect(r.data?.pages[0]?.panels[0]?.dialogue.map((d) => d.speaker)).toEqual([null, null]);
  });

  it('trims speaker names (M4 final M1)', () => {
    const padded = panel({ dialogue: [{ speaker: '  Aiko ', kind: 'speech', text: 'Hi' }] });
    const r = schema.safeParse({ pages: [{ panels: [padded, panel()] }] });
    expect(r.data?.pages[0]?.panels[0]?.dialogue[0]?.speaker).toBe('Aiko');
  });

  it('rejects unknown characters and speakers with the valid names listed', () => {
    const stranger = panel({ dialogue: [{ speaker: 'Mika', kind: 'speech', text: 'Hi' }] });
    const r = schema.safeParse({ pages: [{ panels: [stranger, panel()] }] });
    expect(issuesOf(r)).toEqual(['pages.0.panels.0.dialogue.0.speaker: unknown character "Mika"; use one of: Aiko, Ren']);
  });

  it('rejects a page whose panel count differs from the breakdown', () => {
    const r = schema.safeParse({ pages: [{ panels: [panel()] }] });
    expect(issuesOf(r)).toEqual(['pages.0.panels: page 1 needs exactly 2 panels (from the breakdown), got 1']);
  });
});

describe('scriptsSchemaFor with a pageOffset (a chunk of the chapter)', () => {
  const chunk = scriptsSchemaFor({ panelCounts: [2, 1], knownNames: ['Aiko'], pageOffset: 4 });

  it('names absolute page numbers in its messages', () => {
    const r = chunk.safeParse({ pages: [{ panels: [panel(), panel()] }, { panels: [panel(), panel()] }] });
    expect(issuesOf(r)).toEqual(['pages.1.panels: page 6 needs exactly 1 panels (from the breakdown), got 2']);
    expect(issuesOf(chunk.safeParse({ pages: [{ panels: [panel(), panel()] }] })))
      .toEqual(['pages: expected exactly 2 pages (pages 5–6 of the breakdown), got 1']);
  });

  it('accepts a chunk that matches its slice of the breakdown', () => {
    expect(chunk.safeParse({ pages: [{ panels: [panel(), panel()] }, { panels: [panel()] }] }).success).toBe(true);
  });
});

describe('promptsSchemaFor', () => {
  const schema = promptsSchemaFor({ panelIds: ['pn_a', 'pn_b'] });

  it('accepts exactly one entry per panel id', () => {
    expect(schema.safeParse({ panels: [{ panelId: 'pn_b', scene: 'rain' }, { panelId: 'pn_a', scene: 'sun', negative: 'blur' }] }).success).toBe(true);
  });

  it('accepts a null negative and normalises it to undefined', () => {
    const r = schema.safeParse({ panels: [{ panelId: 'pn_a', scene: 'x', negative: null }, { panelId: 'pn_b', scene: 'y' }] });
    expect(r.success).toBe(true);
    expect(r.data?.panels[0]?.negative).toBeUndefined();
  });

  it('rejects unknown, duplicate and missing ids', () => {
    const r = schema.safeParse({ panels: [{ panelId: 'pn_a', scene: 'x' }, { panelId: 'pn_a', scene: 'y' }, { panelId: 'pn_zz', scene: 'z' }] });
    expect(issuesOf(r)).toEqual([
      'panels.1.panelId: duplicate panelId "pn_a"',
      'panels.2.panelId: unknown panelId "pn_zz"; use one of: pn_a, pn_b',
      'panels: missing panelIds: pn_b',
    ]);
  });
});

describe('step tables and estimates', () => {
  it('maps steps to tasks, editability and indexes', () => {
    expect(STEP_TASK).toEqual({ premise: 'story', outline: 'story', breakdown: 'story', scripts: 'dialogue', prompts: 'prompts', render: null, lettering: null });
    expect([...EDITABLE_STEPS]).toEqual(['premise', 'outline', 'breakdown', 'scripts', 'prompts']);
    expect(stepIndex('scripts')).toBe(3);
    expect(STEP_OUTPUT_SCHEMAS.render).toBe(RenderOutputSchema);
  });

  it('compares names loosely', () => {
    expect(sameName(' Aiko  Tanaka', 'aiko tanaka')).toBe(true);
    expect(sameName('Олена', 'ОЛЕНА')).toBe(true);
    expect(sameName('Aiko', 'Aika')).toBe(false);
  });

  it('estimates render time from recipe averages', () => {
    expect(estimateSeconds(['anime', 'qwen-edit-ref', null, 'mystery'])).toBe(195);
    expect(formatEstimate(45)).toBe('~45 s');
    expect(formatEstimate(110)).toBe('~2 min');
    expect(formatEstimate(3900)).toBe('~1 h 5 min');
    expect(formatEstimate(7200)).toBe('~2 h');
  });

  it('formats unit boundaries without overflowing', () => {
    expect(formatEstimate(59.6)).toBe('~1 min');
    expect(formatEstimate(3599)).toBe('~1 h');
    expect(formatEstimate(7170)).toBe('~2 h');
    expect(formatEstimate(0)).toBe('~0 s');
  });
});
