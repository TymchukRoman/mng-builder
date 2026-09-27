import { z } from 'zod';
import { InvalidOutputError } from './errors.js';
import type { JsonRequest } from './types.js';

/**
 * Pulls the first balanced JSON object out of a model's answer. Copied from
 * cleopatra (packages/gateway/src/engines/local.ts, extractJson): counting depth
 * while skipping string literals is the smallest thing that is actually correct.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; problems: string };

export function parseAgainst<T>(raw: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(raw);
  if (json === null) return { ok: false, problems: 'The answer contained no JSON object.' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, problems: `The JSON did not parse: ${(err as Error).message}` };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export function jsonSchemaOf<T>(schema: z.ZodType<T>): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
}

export function withJsonInstruction<T>(system: string, schema: z.ZodType<T>): string {
  return `${system.trim()}\n\nAnswer with exactly one JSON object and nothing else: no prose, no code fences. It must validate against this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`;
}

export function correctionPrompt(prompt: string, raw: string, problems: string): string {
  return `${prompt}\n\nYour previous answer could not be used: ${problems}\n\nPrevious answer:\n${raw.slice(0, 4000)}\n\nAnswer again with exactly one JSON object that fixes these problems.`;
}

export type Ask = (input: { system: string; prompt: string }) => Promise<string>;

/** Both engines: prompt → extract JSON → zod safeParse → one correction round → InvalidOutputError. */
export async function completeStructured<T>(ask: Ask, req: JsonRequest<T>): Promise<T> {
  req.signal?.throwIfAborted();
  const system = withJsonInstruction(req.system, req.schema);
  const first = await ask({ system, prompt: req.prompt });
  const a = parseAgainst(first, req.schema);
  if (a.ok) return a.data;
  req.signal?.throwIfAborted();
  req.onProgress?.('Correcting the answer');
  const second = await ask({ system, prompt: correctionPrompt(req.prompt, first, a.problems) });
  const b = parseAgainst(second, req.schema);
  if (b.ok) return b.data;
  throw new InvalidOutputError(
    `${req.name}: the answer still did not match after one correction round (${b.problems}). Raw output: ${second.slice(0, 2000)}`,
    second,
  );
}
