import type { PromptStyle } from '../imaging/route.js';
import { cameraSentence, cameraTags, stripCameraSentences, stripCameraTags, type Angle, type Shot } from './camera.js';
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
