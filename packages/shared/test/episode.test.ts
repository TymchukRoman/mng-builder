// packages/shared/test/episode.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EDITABLE_STEPS, OutlineOutputSchema, PremiseOutputSchema, PromptsOutputSchema, RenderOutputSchema, STEP_TASK,
  REVIEW_AVG_SECONDS, TYPICAL_PANELS_PER_PAGE, breakdownSchemaFor, estimateChapter, estimateReviewSeconds, estimateSeconds, formatChapterEstimate, formatEstimate, gateText, isEnglishScene, outlineSchemaFor, promptsSchemaFor, renderGate, sameName,
  scriptsSchemaFor, stepIndex,
  type PanelScriptDraft,
} from '../src/episode.js';
import { DEFAULT_SETTINGS, EPISODE_STEPS, type EpisodeRun } from '../src/schemas.js';
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

describe('outlineSchemaFor (a scene names only known or new characters)', () => {
  const schema = outlineSchemaFor({ knownNames: ['Aiko'] });
  const scene = (characterNames: string[]) => ({ summary: 'They meet', purpose: 'setup', location: 'village gate', characterNames });
  const draft = (name: string) => ({ name, role: 'main', personality: 'loud', speechStyle: 'shouts', appearanceTags: '1boy, spiky blond hair, orange jumpsuit' });

  it('flags a scene name that is neither a known character nor a new one', () => {
    const r = schema.safeParse({ scenes: [scene(['Aiko']), scene(['Rogue Ninja', 'Naruto'])], newCharacters: [draft('Rogue Ninja')] });
    expect(issuesOf(r)).toEqual([
      'scenes.1.characterNames.1: unknown character "Naruto": add "Naruto" to newCharacters (with appearanceTags) or remove it; groups and crowds are not characters',
    ]);
  });

  it('accepts known characters and names listed in newCharacters, case-insensitively', () => {
    expect(schema.safeParse({ scenes: [scene([' aiko', 'NARUTO', 'sasuke  uchiha'])], newCharacters: [draft('Naruto'), draft('Sasuke Uchiha')] }).success).toBe(true);
  });

  it('allows up to 8 new characters', () => {
    const eight = Array.from({ length: 8 }, (_, i) => draft(`Ninja ${i + 1}`));
    expect(schema.safeParse({ scenes: [scene(['Aiko'])], newCharacters: eight }).success).toBe(true);
    expect(schema.safeParse({ scenes: [scene(['Aiko'])], newCharacters: [...eight, draft('Ninja 9')] }).success).toBe(false);
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

  it('lenient (an LLM answer) accepts unknown characters and speakers and a panel count that differs; the page count stays strict', () => {
    const lenient = scriptsSchemaFor({ panelCounts: [2, 2], knownNames: ['Aiko'], lenient: true });
    const stranger = panel({
      characters: [{ name: 'Naruto', pose: 'running', expression: 'grinning', position: 'left' }],
      dialogue: [{ speaker: 'Naruto', kind: 'shout', text: 'Believe it!' }],
    });
    expect(lenient.safeParse({ pages: [{ panels: [stranger, panel()] }, { panels: [panel()] }] }).success).toBe(true);
    expect(lenient.safeParse({ pages: [{ panels: [panel(), panel(), panel()] }, { panels: [panel(), panel()] }] }).success).toBe(true);
    expect(issuesOf(lenient.safeParse({ pages: [{ panels: [stranger] }] }))).toEqual(['pages: expected exactly 2 pages (from the breakdown), got 1']);
    const strict = scriptsSchemaFor({ panelCounts: [2, 2], knownNames: ['Aiko'] });
    expect(issuesOf(strict.safeParse({ pages: [{ panels: [panel(), panel(), panel()] }, { panels: [panel(), panel()] }] })))
      .toEqual(['pages.0.panels: page 1 needs exactly 2 panels (from the breakdown), got 3']);
  });

  it('names where the panel counts come from (a user edit of materialized pages checks their layouts)', () => {
    const pagesSchema = scriptsSchemaFor({ panelCounts: [3], knownNames: ['Aiko'], panelSource: 'its page layout' });
    expect(issuesOf(pagesSchema.safeParse({ pages: [{ panels: [panel(), panel()] }] })))
      .toEqual(['pages.0.panels: page 1 needs exactly 3 panels (from its page layout), got 2']);
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

  it('englishScenes (an LLM answer) flags a scene with Cyrillic or without Latin text, for the correction round', () => {
    const english = promptsSchemaFor({ panelIds: ['pn_a', 'pn_b'], englishScenes: true });
    const roman = 'Вельм, Вельм спокійно усміхається й піднімає долоню, наче дає слово, віз, мішки, сіре небо';
    const answer = { panels: [{ panelId: 'pn_a', scene: roman }, { panelId: 'pn_b', scene: '1boy, smile' }] };
    expect(issuesOf(english.safeParse(answer))).toEqual([
      'panels.0.scene: scene must be English (Danbooru-style tags or plain English sentences as asked), with no Cyrillic and no character names',
    ]);
    expect(english.safeParse({ panels: [{ panelId: 'pn_a', scene: '...' }, { panelId: 'pn_b', scene: 'smile' }] }).success).toBe(false);
    expect(schema.safeParse(answer).success).toBe(true); // a user edit is stored verbatim
    expect(isEnglishScene('1boy, smile')).toBe(true);
    expect(isEnglishScene('smile, віз')).toBe(false);
  });

  it('accepts exactly one entry per panel id', () => {
    expect(schema.safeParse({ panels: [{ panelId: 'pn_b', scene: 'rain' }, { panelId: 'pn_a', scene: 'sun', negative: 'blur' }] }).success).toBe(true);
  });

  it('describes "negative" as an optional string in its JSON Schema, so constrained decoding cannot put an object there', () => {
    const json = z.toJSONSchema(PromptsOutputSchema, { unrepresentable: 'any' }) as unknown as {
      properties: { panels: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(json.properties.panels.items.properties['negative']).toEqual({ type: 'string' });
    expect(json.properties.panels.items.required).toEqual(['panelId', 'scene']);
    expect(schema.safeParse({ panels: [{ panelId: 'pn_a', scene: 'x', negative: { 'extra people': 'extra people' } }, { panelId: 'pn_b', scene: 'y' }] }).success).toBe(false);
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
  });

  it('compares names loosely', () => {
    expect(sameName(' Aiko  Tanaka', 'aiko tanaka')).toBe(true);
    expect(sameName('Олена', 'ОЛЕНА')).toBe(true);
    expect(sameName('Aiko', 'Aika')).toBe(false);
  });

  it('estimates render time from recipe averages', () => {
    expect(estimateSeconds(['anime', 'qwen-edit-ref', null, 'mystery'])).toBe(195);
    // M4 final S5: review rounds. 4 images, 400 s of rendering, 2 rounds: 4 reviews + half re-rendered and reviewed
    // again + a quarter re-rendered in the last round (not reviewed again).
    expect(estimateReviewSeconds(400, 4, 2)).toBe(4 * REVIEW_AVG_SECONDS + 0.5 * 400 + 0.5 * 4 * REVIEW_AVG_SECONDS + 0.25 * 400);
    expect(estimateReviewSeconds(400, 4, 0)).toBe(0);
    expect(estimateReviewSeconds(0, 0, 2)).toBe(0);
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

describe('chapter estimate (W1 C2)', () => {
  it('is pages x 4.5 panels x the routed recipes, with the review rounds', () => {
    expect(TYPICAL_PANELS_PER_PAGE).toBe(4.5);
    // (anime 30 + anime-ref 32 + klein-ref 17) / 3 per panel; review 2 rounds (estimateReviewSeconds)
    expect(estimateChapter(8, DEFAULT_SETTINGS)).toEqual({ panels: 36, seconds: 2199 });
    expect(formatChapterEstimate(8, DEFAULT_SETTINGS)).toBe('8 pages ≈ 36 panels ≈ 37 min');
  });

  it('leaves the review out when episodes do not review, and says "page" for one', () => {
    const noReview = { ...DEFAULT_SETTINGS, review: { autoInEpisode: false, rounds: 2 } };
    expect(estimateChapter(2, noReview)).toEqual({ panels: 9, seconds: 237 });
    expect(formatChapterEstimate(1, noReview)).toBe('1 page ≈ 5 panels ≈ 2 min');
  });

  it('adds the bw refine pass after the natural-prompt recipes of a black-and-white book (Task 2 M4)', () => {
    const noReview = { ...DEFAULT_SETTINGS, review: { autoInEpisode: false, rounds: 2 } };
    const refined = { ...noReview, routing: { ...noReview.routing, bwRefine: 'anime-refine' } };
    // (anime 30 + anime-ref 32 + klein-ref 17 + anime-refine 20) / 3 per panel, 9 panels
    expect(estimateChapter(2, refined, 'bw')).toEqual({ panels: 9, seconds: 297 });
    expect(estimateChapter(2, refined, 'color')).toEqual({ panels: 9, seconds: 237 }); // colour books are not refined
    expect(estimateChapter(2, refined)).toEqual({ panels: 9, seconds: 237 });
    expect(estimateChapter(2, noReview, 'bw')).toEqual({ panels: 9, seconds: 237 }); // no refine recipe set
  });
});

describe('renderGate (W1 Q2, C2)', () => {
  const base = { jobs: [], reviewed: 0, flagged: 0, rounds: 0 };
  it('names the stop of a render output; a finished render and old outputs are none', () => {
    expect(renderGate({ ...base, failedPanelIds: [], preview: true, remainingPanels: 4, estimateSeconds: 120 })).toBe('preview');
    expect(renderGate({ ...base, failedPanelIds: [], confirm: true, panels: 40, estimateSeconds: 4000 })).toBe('confirm');
    expect(renderGate({ ...base, failedPanelIds: ['pn_a'] })).toBeNull();
    expect(renderGate(base)).toBeNull(); // stored before W1: failedPanelIds defaults to []
    expect(RenderOutputSchema.parse(base).failedPanelIds).toEqual([]);
    expect(renderGate(null)).toBeNull();
  });
});

describe('gateText (W1 F20: the status text of a render stop, shared by the UI and the CLI)', () => {
  const base = { jobs: [], reviewed: 0, flagged: 0, rounds: 0, failedPanelIds: [] };
  const T = '2026-09-30T10:00:00.000Z';
  const at = (output: unknown, over: Partial<EpisodeRun> = {}): EpisodeRun => ({
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode: 'autopilot', currentStep: stepIndex('render'), status: 'awaiting-review',
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < stepIndex('render') ? 'done' as const : i === stepIndex('render') ? 'awaiting-review' as const : 'pending' as const,
      output: name === 'render' ? output : null, error: null, startedAt: T, finishedAt: null,
    })),
    createdAt: T, updatedAt: T, ...over,
  } as EpisodeRun);

  it('words the preview stop and the size stop', () => {
    expect(gateText(at({ ...base, preview: true, remainingPanels: 34, estimateSeconds: 1800 }))).toBe('Page 1 is ready — continue with 34 panels (~30 min)?');
    expect(gateText(at({ ...base, confirm: true, panels: 40, estimateSeconds: 3600 }))).toBe('Render 40 panels (~1 h)?');
  });

  it('is null for a finished render, another step, or a run that is not waiting', () => {
    expect(gateText(at(base))).toBeNull();
    expect(gateText(at({ ...base, preview: true, remainingPanels: 3, estimateSeconds: 60 }, { currentStep: 1 }))).toBeNull();
    expect(gateText(at({ ...base, preview: true, remainingPanels: 3, estimateSeconds: 60 }, { status: 'running' }))).toBeNull();
  });
});
