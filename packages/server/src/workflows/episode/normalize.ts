// packages/server/src/workflows/episode/normalize.ts
import { AngleSchema, CharacterRoleSchema, DialogueKindSchema, ShotSchema, StagePositionSchema, withCountTag } from '@manga/shared';
import { preferEnglish } from '../../prompts/scene.js';
import type { PromptsPanelBrief } from './context.js';
import type { LlmStepName } from './steps.js';

/**
 * The shape of a step's LLM answer, as far as the normaliser repairs it. It mirrors the step output schemas in
 * @manga/shared (a test checks every string and enum field of their JSON Schemas is covered).
 */
type Shape =
  | { kind: 'text'; nullable?: boolean }
  | { kind: 'enum'; values: readonly string[]; fallback: string; synonyms: Readonly<Record<string, string>> }
  | { kind: 'int' }
  | { kind: 'speaker' }
  | { kind: 'id' }
  | { kind: 'array'; of: Shape; mayBeEmpty: boolean }
  | { kind: 'object'; fields: Readonly<Record<string, Shape>> };

const text = (nullable = false): Shape => ({ kind: 'text', nullable });
const list = (of: Shape, mayBeEmpty = true): Shape => ({ kind: 'array', of, mayBeEmpty });
const object = (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields });
const choice = (values: readonly string[], fallback: string, synonyms: Record<string, string>): Shape => ({ kind: 'enum', values, fallback, synonyms });

const SHOT = choice(ShotSchema.options, 'medium', {
  'extreme-close-up': 'extreme-close', 'extreme-closeup': 'extreme-close', ecu: 'extreme-close', macro: 'extreme-close',
  'close-up': 'close', closeup: 'close', cu: 'close', 'medium-close-up': 'close', 'medium-closeup': 'close',
  mid: 'medium', 'medium-shot': 'medium', 'mid-shot': 'medium', 'cowboy': 'medium', 'upper-body': 'medium',
  long: 'wide', full: 'wide', 'full-body': 'wide', 'long-shot': 'wide',
  'extreme-long': 'extreme-wide', 'extreme-long-shot': 'extreme-wide', establishing: 'extreme-wide', panorama: 'extreme-wide', panoramic: 'extreme-wide',
});
const ANGLE = choice(AngleSchema.options, 'eye', {
  'eye-level': 'eye', level: 'eye', straight: 'eye', front: 'eye', frontal: 'eye',
  'worms-eye': 'low', 'worm-eye': 'low', 'from-below': 'low', upward: 'low',
  'from-above': 'high', downward: 'high',
  'birds-eye': 'overhead', 'bird-eye': 'overhead', 'top-down': 'overhead', topdown: 'overhead', aerial: 'overhead',
  tilted: 'dutch', canted: 'dutch', oblique: 'dutch',
});
const KIND = choice(DialogueKindSchema.options, 'speech', {
  narrator: 'narration', caption: 'narration', narrative: 'narration',
  sound: 'sfx', 'sound-effect': 'sfx', 'sound-effects': 'sfx', onomatopoeia: 'sfx', effect: 'sfx', fx: 'sfx',
  'thought-bubble': 'thought', thinking: 'thought', thoughts: 'thought', think: 'thought', monologue: 'thought', 'inner-monologue': 'thought',
  shouting: 'shout', yell: 'shout', yelling: 'shout', scream: 'shout', screaming: 'shout', exclamation: 'shout',
  dialogue: 'speech', dialog: 'speech', say: 'speech', says: 'speech', speaking: 'speech', talk: 'speech', line: 'speech',
});
const POSITION = choice(StagePositionSchema.options, 'center', { centre: 'center', middle: 'center', mid: 'center', centered: 'center' });
const ROLE = choice(CharacterRoleSchema.options, 'supporting', {
  protagonist: 'main', lead: 'main', hero: 'main', heroine: 'main', primary: 'main', major: 'main',
  side: 'supporting', secondary: 'supporting', support: 'supporting', sidekick: 'supporting',
  background: 'minor', extra: 'minor', cameo: 'minor', tertiary: 'minor',
});

/** One shape per LLM step, following PremiseOutputSchema … PromptsOutputSchema. */
export const STEP_SHAPES: Readonly<Record<LlmStepName, Shape>> = {
  premise: object({ title: text(), synopsis: text(), tone: text(), setting: text() }),
  outline: object({
    scenes: list(object({ summary: text(), purpose: text(), location: text(), characterNames: list(text()) }), false),
    newCharacters: list(object({ name: text(), role: ROLE, personality: text(), speechStyle: text(), appearanceTags: text() })),
  }),
  breakdown: object({
    pages: list(object({ sceneIdx: list({ kind: 'int' }, false), panelCount: { kind: 'int' }, pacing: text(), layoutPreset: text() }), false),
  }),
  scripts: object({
    pages: list(object({
      panels: list(object({
        action: text(), shot: SHOT, angle: ANGLE,
        characters: list(object({ name: text(), pose: text(), expression: text(), position: POSITION })),
        background: text(),
        dialogue: list(object({ speaker: { kind: 'speaker' }, kind: KIND, text: text() })),
      }), false),
    }), false),
  }),
  prompts: object({ panels: list(object({ panelId: { kind: 'id' }, scene: text(), negative: text(true) }), false) }),
};

/** What a request offers: for prompts, the panels of this call (unknown ids are dropped, missing ones filled). */
export interface NormalizeContext { panels?: readonly PromptsPanelBrief[] }
/** `filled`: prompts panels whose scene was written from their script because the answer had none. */
export interface NormalizedAnswer { value: unknown; filled: string[] }

const MAX_DEPTH = 8;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text pieces of any value: strings and numbers as they are, objects by their values (and the keys of `true`). */
function pieces(v: unknown, depth: number): string[] {
  if (depth > MAX_DEPTH || v === null || v === undefined || v === false) return [];
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return [String(v)];
  if (Array.isArray(v)) return v.flatMap((item) => pieces(item, depth + 1));
  if (isRecord(v)) return Object.entries(v).flatMap(([key, value]) => (value === true ? [key] : pieces(value, depth + 1)));
  return [];
}

function toText(v: unknown, nullable: boolean): unknown {
  if (typeof v === 'string') return v;
  if (v === undefined) return nullable ? undefined : '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const joined = [...new Set(pieces(v, 0))].join(', ');
  if (joined !== '') return joined;
  return nullable ? null : '';
}

/** "Bird's eye", "close_up", " EYE LEVEL " → "birds-eye", "close-up", "eye-level". */
function enumKey(v: string): string {
  return v.trim().toLowerCase().replace(/['’`]/g, '').replace(/[\s_/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function toEnum(v: unknown, shape: Extract<Shape, { kind: 'enum' }>): string {
  if (typeof v === 'string' && shape.values.includes(v)) return v;
  const raw = typeof v === 'string' ? v : toText(v, true);
  if (typeof raw !== 'string') return shape.fallback;
  const lookup = (key: string): string | undefined => (shape.values.includes(key) ? key : shape.synonyms[key]);
  const key = enumKey(raw);
  const trimmed = key.replace(/-(shot|angle|view|level|bubble|character|role|panel)$/, '');
  const whole = lookup(key) ?? lookup(trimmed);
  if (whole !== undefined) return whole;
  for (const token of key.split('-')) {
    const hit = lookup(token);
    if (hit !== undefined) return hit;
  }
  return shape.fallback;
}

const NO_SPEAKER = new Set(['', 'none', 'null', 'nil', 'nobody', 'no-one', 'noone', 'n/a', 'na', 'narrator', 'narration', 'sfx', '-']);

function toSpeaker(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const name = typeof v === 'string' ? v : toText(v, true);
  if (typeof name !== 'string') return null;
  return NO_SPEAKER.has(name.trim().toLowerCase()) ? null : name;
}

function toInt(v: unknown): unknown {
  return typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
}

function repair(v: unknown, shape: Shape, depth: number): unknown {
  if (depth > MAX_DEPTH) return v;
  switch (shape.kind) {
    case 'text':
      return toText(v, shape.nullable === true);
    case 'enum':
      return toEnum(v, shape);
    case 'int':
      return toInt(v);
    case 'speaker':
      return toSpeaker(v);
    case 'id':
      return v;
    case 'array': {
      const items = Array.isArray(v) ? v
        : v === null || v === undefined ? (shape.mayBeEmpty ? [] : v)
          : isRecord(v) || typeof v === 'string' || typeof v === 'number' ? [v]
            : v;
      return Array.isArray(items) ? items.map((item) => repair(item, shape.of, depth + 1)) : items;
    }
    case 'object': {
      if (!isRecord(v)) return v;
      const out: Record<string, unknown> = { ...v };
      for (const [key, field] of Object.entries(shape.fields)) {
        const fixed = repair(v[key], field, depth + 1);
        if (fixed !== undefined) out[key] = fixed;
      }
      return out;
    }
  }
}

/**
 * A scene for a panel the answer skipped, from its script (action and background, never the names: the pictures and
 * count tags identify the characters); the prompts effect finishes it (camera, sanitising) like any other. A Ukrainian
 * script keeps only its English part, or stays as written for the English check to send back.
 */
export function sceneFromScript(panel: PromptsPanelBrief): string {
  const action = panel.action.trim();
  const background = panel.background.trim();
  const raw = panel.style === 'tags'
    ? [action.replace(/[.!?…]+$/, ''), background].filter((p) => p !== '').join(', ')
    : [action === '' || /[.!?…]$/.test(action) ? action : `${action}.`, background === '' ? '' : `Background: ${background}.`].filter((p) => p !== '').join(' ');
  return preferEnglish(raw);
}

/** Every entry's scene keeps its English part when it mixes in Cyrillic. */
function englishScenes(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['panels'])) return value;
  return {
    ...value,
    panels: value['panels'].map((e: unknown) => (isRecord(e) && typeof e['scene'] === 'string' ? { ...e, scene: preferEnglish(e['scene']) } : e)),
  };
}

/**
 * Prompts: only the offered panels, the first entry per panel, and a scene from the script for every panel left without one.
 * W1 F19 (accepted): a cut-off answer that `repairJson` (R3) mended by dropping its last, half-written entry lands here too.
 * That panel then gets its scene from its script, with no correction round and only the console warning in llm.ts. Nothing
 * is invented (the script is the user's story), but the model's own scene for that panel is lost without a visible error.
 */
function fitPrompts(value: unknown, offered: readonly PromptsPanelBrief[]): NormalizedAnswer {
  if (!isRecord(value) || !Array.isArray(value['panels'])) return { value, filled: [] };
  const byId = new Map(offered.map((p) => [p.panelId, p]));
  const seen = new Set<string>();
  const kept: Array<Record<string, unknown>> = [];
  for (const entry of value['panels']) {
    if (!isRecord(entry) || typeof entry['panelId'] !== 'string') continue;
    const id = entry['panelId'];
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    const scene = entry['scene'];
    if (typeof scene === 'string' && scene.trim() !== '') kept.push(entry);
  }
  const written = new Set(kept.map((e) => e['panelId'] as string));
  const missing = offered.filter((p) => !written.has(p.panelId));
  return {
    value: { ...value, panels: [...kept, ...missing.map((p) => ({ panelId: p.panelId, scene: sceneFromScript(p) }))] },
    filled: missing.map((p) => p.panelId),
  };
}

/**
 * Outline: a new character's appearanceTags start with the count tag its words call for (withCountTag): a local model
 * wrote "1other, fat man", and the portrait came out a woman. A correct, unknown or non-human count stays as written.
 */
function fitOutlineCounts(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['newCharacters'])) return value;
  return {
    ...value,
    newCharacters: value['newCharacters'].map((c: unknown) =>
      (isRecord(c) && typeof c['appearanceTags'] === 'string' ? { ...c, appearanceTags: withCountTag(c['appearanceTags']) } : c)),
  };
}

/**
 * Repairs the shape slips of a parsed LLM answer before it is validated (a local model often writes an object where
 * a string belongs, "close-up" for "close", one object for a list…): free-text fields become text, enum fields map
 * synonyms or fall back to a neutral value, a lone item becomes a list, an outline's new characters get the count tag
 * their words call for, and a prompts answer keeps only the offered panels and gets a scene from the script for any it
 * skipped. Only the LLM path uses it; user edits stay strict.
 * Pure: never throws, never mutates `raw`, and returns what it cannot help unchanged.
 */
export function normalizeLlmAnswer(step: LlmStepName, raw: unknown, ctx: NormalizeContext = {}): NormalizedAnswer {
  try {
    const value = repair(raw, STEP_SHAPES[step], 0);
    if (step === 'outline') return { value: fitOutlineCounts(value), filled: [] };
    if (step !== 'prompts') return { value, filled: [] };
    const english = englishScenes(value);
    return ctx.panels ? fitPrompts(english, ctx.panels) : { value: english, filled: [] };
  } catch {
    return { value: raw, filled: [] };
  }
}
