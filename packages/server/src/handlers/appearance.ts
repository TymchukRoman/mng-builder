import { z } from 'zod';
import { InvalidOutputError } from '../engines/errors.js';
import { PermanentError } from '../jobs/index.js';
import type { LlmStepHandler } from '../jobs/llm-step.js';
import { loadPrompt } from '../prompts/load.js';
import { normalizeAppearanceTags } from '../prompts/sanitize.js';
import { emitEntity } from './context.js';
import type { HandlerServices } from './types.js';

export const AppearanceOutputSchema = z.object({ appearanceTags: z.string().min(1) });

/**
 * Spec §11 "AI suggest appearance": turns a free-text description into the canonical Danbooru appearance tag
 * string for a character. The answer is normalized again in code (forbidden words dropped, lowercased,
 * de-duplicated) before it ever overwrites the character's tags.
 */
export function appearanceStep(services: HandlerServices): LlmStepHandler {
  return async (ctx, payload) => {
    if (payload.type !== 'appearance') throw new PermanentError(`appearance step received a "${payload.type}" payload`);
    const character = ctx.store.characters.require(payload.characterId);
    const engine = services.engines.for('prompts');
    ctx.progress('Writing appearance tags');
    const out = await engine.completeJson({
      name: 'appearance', task: 'prompts', system: loadPrompt('appearance'),
      prompt: `Character: ${character.name} (${character.role})\n\nDescription:\n${payload.description.trim()}\n\nWrite the appearance tags.`,
      schema: AppearanceOutputSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    const appearanceTags = normalizeAppearanceTags(out.appearanceTags);
    // Nothing usable survived normalization (e.g. only forbidden words) — fail loudly instead of overwriting the
    // character's existing tags with an empty string (m2-rulings Task 20 addition).
    if (!appearanceTags) throw new InvalidOutputError('appearance: the AI wrote no usable appearance tags', out.appearanceTags);

    // One transaction re-checks the character still exists (it may have been deleted during the LLM call) before
    // writing the tags back (M1 owner-recheck pattern, G1; controller ruling, Task 20 addition). A deleted
    // character rejects with NotFoundError instead of crashing.
    ctx.store.tx(() => {
      ctx.store.characters.require(character.id);
      ctx.store.characters.update(character.id, { appearanceTags });
    });
    emitEntity(ctx.bus, 'character', character.id, 'updated', character.mangaId);
    return { appearanceTags };
  };
}
