import { humanCount, isEnglishScene } from '@manga/shared';
import type { PromptStyle } from '../imaging/route.js';
import { cameraSentence, cameraTags, stripCameraSentences, stripCameraTags, type Angle, type Shot } from './camera.js';
import { castPrompt } from './count.js';
import { sanitizeSentences, sanitizeTags } from './sanitize.js';

/**
 * True once the sanitized scene has at least one letter or digit left. Rejects both an empty scene and one that
 * sanitized down to only punctuation/whitespace (m2-rulings Task 20 addition: never send that to the image model).
 */
function hasUsableScene(scene: string): boolean {
  return /[a-z0-9]/i.test(scene);
}

/**
 * Turns a scene the LLM wrote into the stored panel scene (M2 panel-prompt and the M4 prompts step alike):
 * forbidden words are sanitized away, whatever camera framing the model wrote is dropped (I2: the script decides
 * shot and angle), and the mapped camera tags (or framing sentence) go first, so the scene can never contradict the
 * script. Returns null when nothing usable is left; the caller fails with its own error.
 */
export function finishScene(style: PromptStyle, shot: Shot, angle: Angle, raw: string): string | null {
  const written = style === 'tags' ? stripCameraTags(sanitizeTags(raw)) : stripCameraSentences(sanitizeSentences(raw));
  if (!hasUsableScene(written)) return null;
  return style === 'tags' ? [...cameraTags(shot, angle), written].join(', ') : `${cameraSentence(shot, angle)} ${written}`;
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN_LETTER = /[a-z]/i;
/** A word (between spaces and punctuation) that holds a Cyrillic letter. */
const CYRILLIC_WORD = /[^\s,.;:!?()"«»]*\p{Script=Cyrillic}[^\s,.;:!?()"«»]*/gu;

/** Latin letters and no Cyrillic (@manga/shared): Roman's Ukrainian run got "Вельм, … віз, мішки, сіре небо". */
export { isEnglishScene };

/**
 * The English part of a mixed scene: every comma-separated part loses its Cyrillic words, and a part left without a
 * Latin letter is dropped ("Вельм, smile, віз" → "smile"). Text without Cyrillic comes back unchanged.
 */
export function englishPart(text: string): string {
  if (!CYRILLIC.test(text)) return text;
  return text.split(',')
    .map((part) => part.replace(CYRILLIC_WORD, '').replace(/\s+([.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim())
    .filter((part) => LATIN_LETTER.test(part))
    .join(', ');
}

/** The English part of a mixed scene when a usable one is left; otherwise the scene as written (for the English check to flag). */
export function preferEnglish(scene: string): string {
  const english = englishPart(scene);
  return english !== scene && isEnglishScene(english) ? english : scene;
}

/** finishScene for the English part of `raw` only: null when no usable English is left. */
export function usableScene(style: PromptStyle, shot: Shot, angle: Angle, raw: string): string | null {
  const text = englishPart(raw);
  return isEnglishScene(text) ? finishScene(style, shot, angle, text) : null;
}

const NEUTRAL: Record<PromptStyle, string> = { tags: 'scenery, no humans', natural: 'An establishing view of the scene.' };

/**
 * A scene written from the panel's cast when the AI gave no usable English one: the tags style gets the cast's count
 * tags and appearance tags (castPrompt, as the image build counts them, `mature male` included); the natural style a
 * count sentence and the appearance. The script's background is added only when it is English. No cast: neutral scenery.
 */
export function castScene(style: PromptStyle, cast: ReadonlyArray<{ appearanceTags: string }>, background: string): string {
  const bg = isEnglishScene(background) ? background.trim() : '';
  const subject = castPrompt(style, cast, '');
  const tags = subject.characterTags.map((t) => t.trim()).filter((t) => t !== '');
  if (tags.length === 0 && humanCount(subject.count) === 0) {
    return style === 'tags' ? [NEUTRAL.tags, bg].filter((p) => p !== '').join(', ') : NEUTRAL.natural;
  }
  if (style === 'tags') return [...tags, bg].filter((p) => p !== '').join(', ');
  return [subject.scene, tags.length > 0 ? `Appearance: ${tags.join('; ')}.` : '', bg !== '' ? `Background: ${bg}.` : '']
    .filter((p) => p !== '').join(' ');
}

/** castScene finished with the script's camera (never null: neutral scenery when even the cast sanitizes away). */
export function fallbackScene(
  style: PromptStyle, shot: Shot, angle: Angle, cast: ReadonlyArray<{ appearanceTags: string }>, background: string,
  prepare: (raw: string) => string = (raw) => raw,
): string {
  return finishScene(style, shot, angle, prepare(castScene(style, cast, background)))
    ?? finishScene(style, shot, angle, NEUTRAL[style])
    ?? NEUTRAL[style];
}
