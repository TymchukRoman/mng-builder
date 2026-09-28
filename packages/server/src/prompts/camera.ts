import type { PanelScript } from '@manga/shared';

/**
 * I2: shot and angle are directions from the script (the user in M2, the story step in M4), so the code maps them to
 * the image prompt deterministically instead of trusting the LLM to (live: qwen3:14b wrote "from below" for angle
 * "eye"). M2's panel-prompt step and M4's prompts step both use these helpers.
 */
export type Shot = PanelScript['shot'];
export type Angle = PanelScript['angle'];

const SHOT_TAGS: Record<Shot, readonly string[]> = {
  'extreme-close': ['extreme close-up'],
  close: ['close-up'],
  medium: ['upper body'],
  wide: ['full body', 'wide shot'],
  'extreme-wide': ['very wide shot'],
};
const ANGLE_TAGS: Record<Angle, readonly string[]> = {
  eye: [],
  low: ['from below'],
  high: ['from above'],
  dutch: ['dutch angle'],
  overhead: ['from above', 'overhead view'],
};

/** Danbooru camera tags for the tags style (SDXL/Anima). Eye level has no tag: it is the default. */
export function cameraTags(shot: Shot, angle: Angle): string[] {
  return [...SHOT_TAGS[shot], ...ANGLE_TAGS[angle]];
}

const SHOT_SENTENCE: Record<Shot, string> = {
  'extreme-close': 'Extreme close-up', close: 'Close-up', medium: 'Medium shot', wide: 'Wide full-body shot', 'extreme-wide': 'Very wide shot',
};
const ANGLE_SENTENCE: Record<Angle, string> = {
  eye: 'at eye level', low: 'from a low angle', high: 'from a high angle', dutch: 'at a tilted dutch angle', overhead: 'from directly overhead',
};

/** One framing sentence for the natural style (Qwen/klein), e.g. "Medium shot at eye level." */
export function cameraSentence(shot: Shot, angle: Angle): string {
  return `${SHOT_SENTENCE[shot]} ${ANGLE_SENTENCE[angle]}.`;
}

const SHOT_WORDING: Record<Shot, string> = {
  'extreme-close': 'extreme close-up', close: 'close-up', medium: 'medium shot', wide: 'wide shot (full body)', 'extreme-wide': 'extreme wide shot',
};
const ANGLE_WORDING: Record<Angle, string> = {
  eye: 'eye level', low: 'low angle (from below)', high: 'high angle (from above)', dutch: 'dutch angle (tilted)', overhead: 'overhead (from directly above)',
};

/** Readable camera wording for prompts that show the script (scriptBlock), e.g. "medium shot, eye level". */
export function cameraWording(shot: Shot, angle: Angle): string {
  return `${SHOT_WORDING[shot]}, ${ANGLE_WORDING[angle]}`;
}

/** Shot-size and camera-angle tags an LLM may write; stripped from its answer because the script decides them.
 *  Facing tags (`from side`, `from behind`, `pov`) are not camera framing and stay. */
export const CAMERA_TAGS: ReadonlySet<string> = new Set([
  'extreme close-up', 'extreme closeup', 'close-up', 'close up', 'closeup', 'portrait', 'upper body', 'cowboy shot', 'lower body',
  'full body', 'full shot', 'medium shot', 'medium close-up', 'long shot', 'wide shot', 'very wide shot', 'extreme wide shot',
  'establishing shot', 'from below', 'from above', 'low angle', 'high angle', 'eye level', 'dutch angle', 'tilted angle', 'overhead view',
  'overhead shot', 'from overhead', "bird's-eye view", "bird's eye view", 'birds-eye view', 'aerial view', "worm's-eye view", "worm's eye view",
]);

/** "(Cowboy_Shot:1.2)" → "cowboy shot". */
const normalizeTag = (tag: string): string =>
  tag.toLowerCase().replace(/_/g, ' ').trim().replace(/^\(+|\)+$/g, '').replace(/:\s*[\d.]+$/, '').replace(/\s+/g, ' ').trim();

/** Drops every camera tag (any case, `_` or weight syntax) from a comma-separated tag list. */
export function stripCameraTags(tags: string): string {
  return tags.split(',').map((t) => t.trim()).filter((t) => t && !CAMERA_TAGS.has(normalizeTag(t))).join(', ');
}

/** Explicit framing wording in plain sentences. Bare "from above/below" is not matched: in a sentence it is usually
 *  about light or position ("light falls from above"), not the camera. */
const FRAMING = new RegExp([
  String.raw`\b(?:extreme\s+)?close[- ]?ups?\b`, String.raw`\b(?:medium|cowboy|full[- ]body|wide|long|establishing)\s+shots?\b`,
  String.raw`\b(?:low|high|dutch|tilted|camera)[- ]angle\b`, String.raw`\beye[- ]level\b`, String.raw`\boverhead\s+(?:view|shot|angle)\b`,
  String.raw`\b(?:bird|worm)'?s[- ]eye\b`, String.raw`\b(?:seen|viewed|shot)\s+from\s+(?:below|above|overhead)\b`,
].join('|'), 'i');

/** Drops every sentence that states the framing (shot size or camera angle); the rest stays as written. */
export function stripCameraSentences(text: string): string {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() && !FRAMING.test(s)).join(' ').trim();
}
