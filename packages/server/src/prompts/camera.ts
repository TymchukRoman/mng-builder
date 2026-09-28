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

/** Framing terms (shot size, camera angle) that get stripped out of a natural-style sentence — the script decides
 *  these (I2), so whatever the model wrote about them must go, but the scene content around them must not. Bare
 *  "from above/below" is not matched: in a sentence it is usually about light or position ("light falls from
 *  above"), not the camera. */
const FRAMING_TERM = [
  String.raw`(?:extreme\s+)?close[- ]?ups?`, String.raw`(?:medium|cowboy|full[- ]body|wide|long|establishing)\s+shots?`,
  String.raw`(?:low|high|dutch|tilted|camera)[- ]angle`, String.raw`eye[- ]level`, String.raw`overhead\s+(?:view|shot|angle)`,
  String.raw`(?:bird|worm)'?s[- ]eye(?:\s+view)?`, String.raw`(?:seen|viewed|shot)\s+from\s+(?:below|above|overhead)`,
].join('|');

/** A framing term plus the connector/article that leads into it ("Close-up of", "at eye level", "from a low
 *  angle") or the "of" that follows a shot-size term ("wide shot of"): the whole phrase is removed as one unit,
 *  R2, so the noun phrase it was attached to (the actual scene) stays in place. */
const FRAMING_PHRASE = new RegExp(
  String.raw`\b(?:(?:from|at|in|with)\s+)?(?:(?:an?|the)\s+)?(?:${FRAMING_TERM})\b(?:\s+of\b)?`, 'gi',
);

/** A sentence keeps at least this many words once its framing phrases are stripped, else it was framing only
 *  (e.g. "A medium shot at eye level!") and is dropped outright instead of left as a punctuation fragment. */
const MIN_CONTENT_WORDS = 3;

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Removes `sentence`'s framing phrases and tidies the leftover spacing/punctuation. */
function stripFraming(sentence: string): string {
  return sentence.replace(FRAMING_PHRASE, '').replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

/** Strips framing phrases (shot size, camera angle) out of natural-style prose; the rest of each sentence — the
 *  scene it describes — stays as written (R2: the old whole-sentence drop lost the scene along with the framing,
 *  e.g. "Close-up of the character crying." used to lose "the character crying" too). */
export function stripCameraSentences(text: string): string {
  const kept: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const stripped = stripFraming(sentence);
    if (countWords(stripped) >= MIN_CONTENT_WORDS) kept.push(stripped);
  }
  return kept.join(' ').trim();
}
