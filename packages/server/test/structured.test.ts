import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeStructured, extractJson, jsonSchemaOf, parseAgainst, withJsonInstruction } from '../src/engines/structured.js';
import { InvalidOutputError } from '../src/engines/errors.js';

describe('extractJson (from cleopatra)', () => {
  it('finds an object among prose', () => expect(extractJson('Sure! {"a":1} hope that helps')).toBe('{"a":1}'));
  it('handles nesting a regex would get wrong', () => expect(extractJson('x {"a":{"b":2}} y')).toBe('{"a":{"b":2}}'));
  it('is not fooled by braces inside strings', () => expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}'));
  it('survives a thinking preamble and fences', () =>
    expect(extractJson('<think>hm</think>\n```json\n{"ok":true}\n```')).toBe('{"ok":true}'));
  it('returns null when there is no object', () => expect(extractJson('no json here')).toBeNull());
});

describe('parseAgainst', () => {
  const schema = z.object({ pass: z.boolean(), issues: z.array(z.object({ kind: z.string() })) });

  it('parses JSON wrapped in prose and fences', () => {
    expect(parseAgainst('Sure!\n```json\n{"pass":true,"issues":[]}\n```', schema)).toEqual({ ok: true, data: { pass: true, issues: [] } });
  });

  it('explains a missing object', () => {
    expect(parseAgainst('no json', schema)).toEqual({ ok: false, problems: 'The answer contained no JSON object.' });
  });

  it('names the failing paths', () => {
    const result = parseAgainst('{"pass":"yes","issues":[{}]}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContain('pass:');
      expect(result.problems).toContain('issues.0.kind:');
    }
  });
});

describe('JSON schema instruction', () => {
  it('embeds the JSON schema of the zod schema after the system prompt', () => {
    const schema = z.object({ scene: z.string() });
    expect((jsonSchemaOf(schema)['properties'] as Record<string, unknown>)['scene']).toEqual({ type: 'string' });
    const system = withJsonInstruction('Be brief.', schema);
    expect(system.startsWith('Be brief.\n\nAnswer with exactly one JSON object and nothing else')).toBe(true);
    expect(system).toContain('"scene":{"type":"string"}');
  });
});

describe('completeStructured', () => {
  const schema = z.object({ scene: z.string().min(1) });
  const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'SYS', prompt: 'USER', schema };

  it('returns the first valid answer after one call', async () => {
    const calls: Array<{ system: string; prompt: string }> = [];
    const out = await completeStructured(async (input) => {
      calls.push(input);
      return 'Here you go: {"scene":"solo"}';
    }, req);
    expect(out).toEqual({ scene: 'solo' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain('SYS');
    expect(calls[0]!.prompt).toBe('USER');
  });

  it('runs exactly one correction round that quotes the problem and the answer', async () => {
    const answers = ['{"scene":""}', '{"scene":"solo"}'];
    const prompts: string[] = [];
    const progress: string[] = [];
    const out = await completeStructured(async (input) => {
      prompts.push(input.prompt);
      return answers.shift()!;
    }, { ...req, onProgress: (label) => progress.push(label) });
    expect(out).toEqual({ scene: 'solo' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('USER');
    expect(prompts[1]).toContain('scene:');
    expect(prompts[1]).toContain('{"scene":""}');
    expect(progress).toEqual(['Correcting the answer']);
  });

  it('fails with InvalidOutputError holding the raw second answer', async () => {
    let n = 0;
    const err = await completeStructured(async () => {
      n += 1;
      return `nope ${n}`;
    }, req).catch((e: unknown) => e);
    expect(n).toBe(2);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).raw).toBe('nope 2');
    expect((err as Error).message).toContain('panel-prompt');
    expect((err as Error).message).toContain('Raw output: nope 2');
  });
});
