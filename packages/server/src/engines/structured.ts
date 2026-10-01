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

/** The correction round's message when an answer's JSON object never ended and could not be repaired (R3). */
export const CUT_OFF_PROBLEM =
  'The answer was cut off before its JSON object ended. Answer again with the complete JSON object; keep text fields short if needed.';

interface Level { closer: '}' | ']'; openAt: number; commas: number[] }

const parses = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** `out` without a trailing comma (and the whitespace after it), found by index from the end (Task 1 F1). The scan does
 *  not call it per closer (reading a string built by appending flattens it); it tracks the trailing comma's index instead. */
function trimTrailingComma(out: string): string {
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i]!)) i--;
  return i >= 0 && out[i] === ',' ? out.slice(0, i) : out;
}

/** `out` without a trailing comma, then every open level closed, innermost first. */
function closeAll(out: string, levels: readonly Level[]): string {
  return trimTrailingComma(out) + levels.map((l) => l.closer).reverse().join('');
}

/**
 * R3: the JSON object of an answer that was cut off or is slightly malformed, repaired; null when no repair parses.
 * - Starts at the first "{" (code fences and prose before it are dropped). A complete object ends the scan; text after it is ignored.
 * - Removes a trailing comma before "}" or "]". Brackets inside strings are ignored (the scan tracks strings and escapes).
 * - At a cut-off end: closes an open string (dropping a dangling backslash), then appends the missing closers in nesting order.
 *   When that does not parse (a dangling key, "key":, or a half-written entry), cuts back to the last comma of the innermost
 *   level, or drops that level's container when it has no comma, and tries again. It never invents a value.
 * Only a result that parses is returned; the caller still validates it against the schema.
 */
export function repairJson(text: string): string | null {
  return repairJsonDetailed(text)?.json ?? null;
}

/** repairJson's result, and whether it had to close a string the cut left open (its value is then clipped). */
interface Repair { json: string; closedString: boolean }

function repairJsonDetailed(text: string): Repair | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let out = '';
  const levels: Level[] = [];
  let inString = false;
  let escaped = false;
  /** Task 1 F1: the index in `out` of a comma that nothing but whitespace has followed yet, else -1. */
  let trailingComma = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; trailingComma = -1; out += ch; continue; }
    if (ch === '{' || ch === '[') {
      levels.push({ closer: ch === '{' ? '}' : ']', openAt: out.length, commas: [] });
      trailingComma = -1;
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (levels.at(-1)?.closer !== ch) return null; // mismatched closer: not a cut-off we can mend
      if (trailingComma >= 0) out = out.slice(0, trailingComma);
      trailingComma = -1;
      out += ch;
      levels.pop();
      if (levels.length === 0) return parses(out) ? { json: out, closedString: false } : null;
      continue;
    }
    if (ch === ',') {
      levels.at(-1)!.commas.push(out.length);
      trailingComma = out.length;
    } else if (!/\s/.test(ch)) {
      trailingComma = -1;
    }
    out += ch;
  }
  // Cut off before the object ended.
  const closedString = inString;
  if (inString) out = `${escaped ? out.slice(0, -1) : out}"`;
  const openAt = out.length; // a cut-back to before this point dropped the string that was closed
  for (;;) {
    const candidate = closeAll(out, levels);
    if (parses(candidate)) return { json: candidate, closedString: closedString && out.length >= openAt };
    const top = levels.at(-1);
    if (top === undefined) return null;
    const comma = top.commas.pop();
    if (comma !== undefined) {
      out = out.slice(0, comma); // drop the comma and the dangling entry after it
    } else {
      out = out.slice(0, top.openAt); // drop the innermost container; its key in the parent now dangles
      levels.pop();
      if (levels.length === 0) return null;
    }
  }
}

/**
 * `repaired` (W1 final M2) is set only when repairJson produced the value: 'mended' (brackets, commas or a dropped
 * half-written entry) or 'clipped' (a string value the cut left open was closed, so that value is cut short).
 */
export type Parsed<T> = { ok: true; data: T; repaired?: 'mended' | 'clipped' } | { ok: false; problems: string };

export function parseAgainst<T>(raw: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(raw);
  let value: unknown;
  let parseProblem: string | null = null;
  let repaired: 'mended' | 'clipped' | undefined;
  if (json !== null) {
    try {
      value = JSON.parse(json);
    } catch (err) {
      parseProblem = `The JSON did not parse: ${(err as Error).message}`;
    }
  }
  if (json === null || parseProblem !== null) {
    // R3: a cut-off or slightly malformed answer is repaired before the correction round is spent on it.
    const repair = repairJsonDetailed(raw);
    if (repair === null) {
      const problems = parseProblem ?? (raw.includes('{') ? CUT_OFF_PROBLEM : 'The answer contained no JSON object.');
      return { ok: false, problems };
    }
    value = JSON.parse(repair.json);
    repaired = repair.closedString ? 'clipped' : 'mended';
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data, ...(repaired ? { repaired } : {}) };
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

/** W1 final M2: a parsed answer's value; a repaired one is accepted, but never silently. */
export function accepted<T>(parsed: { data: T; repaired?: 'mended' | 'clipped' }, name: string): T {
  if (parsed.repaired) console.warn(`[manga] structured: repaired a cut-off answer for ${name}`);
  return parsed.data;
}

/**
 * Both engines: prompt → extract JSON (repaired if needed, R3) → zod safeParse → one correction round → InvalidOutputError.
 * W1 final M2: a first answer whose repair had to close a cut-off string (that value would be clipped) goes to the
 * correction round too; its repaired value is used only when the correction round fails as well.
 */
export async function completeStructured<T>(ask: Ask, req: JsonRequest<T>): Promise<T> {
  req.signal?.throwIfAborted();
  const system = withJsonInstruction(req.system, req.schema);
  const first = await ask({ system, prompt: req.prompt });
  const a = parseAgainst(first, req.schema);
  if (a.ok && a.repaired !== 'clipped') return accepted(a, req.name);
  req.signal?.throwIfAborted();
  req.onProgress?.('Correcting the answer');
  const second = await ask({ system, prompt: correctionPrompt(req.prompt, first, a.ok ? CUT_OFF_PROBLEM : a.problems) });
  const b = parseAgainst(second, req.schema);
  if (b.ok) return accepted(b, req.name);
  if (a.ok) return accepted(a, req.name);
  throw new InvalidOutputError(
    `${req.name}: the answer still did not match after one correction round (${b.problems}). Raw output: ${second.slice(0, 2000)}`,
    second,
  );
}
