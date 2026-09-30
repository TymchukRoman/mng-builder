import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CUT_OFF_PROBLEM, completeStructured, extractJson, jsonSchemaOf, parseAgainst, repairJson, withJsonInstruction } from '../src/engines/structured.js';
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

  it('rejects with the abort reason and makes no call when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    let calls = 0;
    const err = await completeStructured(async () => {
      calls += 1;
      return '{"scene":"solo"}';
    }, { ...req, signal: controller.signal }).catch((e: unknown) => e);
    expect(calls).toBe(0);
    expect(err).toBe(reason);
  });

  it('aborts between the two calls when the signal is aborted during the first answer', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-flight');
    let calls = 0;
    const err = await completeStructured(async () => {
      calls += 1;
      controller.abort(reason);
      return '{"scene":""}';
    }, { ...req, signal: controller.signal }).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBe(reason);
  });
});

describe('repairJson (R3)', () => {
  // Roman's two prompts-step answers (~1.4 KB) ended in `}]` with the final `}` missing.
  const cutOff = '{"panels":[{"panelId":"pn_aaaaaaaaaa","scene":"1girl, rain, harbour street"},{"panelId":"pn_bbbbbbbbbb","scene":"cat, box, rain"}]';

  it('appends the missing closing brace of a real cut-off answer', () => {
    expect(JSON.parse(repairJson(cutOff)!)).toEqual({
      panels: [{ panelId: 'pn_aaaaaaaaaa', scene: '1girl, rain, harbour street' }, { panelId: 'pn_bbbbbbbbbb', scene: 'cat, box, rain' }],
    });
  });

  it('repairs the real failing shape: a panel with a negative field, ending in `}]` without the final brace', () => {
    const real = '{"panels":[{"panelId":"pn_aaaaaaaaaa","scene":"1girl, rain","negative":"extra people"},{"panelId":"pn_bbbbbbbbbb","scene":"cat, box","negative": "extra people"}]';
    const out = parseAgainst(real, z.object({ panels: z.array(z.object({ panelId: z.string(), scene: z.string(), negative: z.string() })) }));
    expect(out.ok).toBe(true);
  });

  it('strips fences and prose before the first brace', () => {
    expect(repairJson('Sure!\n```json\n{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  it('removes trailing commas before a closer', () => {
    expect(repairJson('{"a":[1,2,],"b":{"c":1,},}')).toBe('{"a":[1,2],"b":{"c":1}}');
  });

  it('closes a string left open at the end, dropping a dangling escape', () => {
    expect(JSON.parse(repairJson('{"scene":"a rainy stre')!)).toEqual({ scene: 'a rainy stre' });
    expect(JSON.parse(repairJson('{"scene":"say \\')!)).toEqual({ scene: 'say ' });
  });

  it('ignores brackets inside strings when it counts what to close', () => {
    expect(JSON.parse(repairJson('{"scene":"a [b {c","x":[1')!)).toEqual({ scene: 'a [b {c', x: [1] });
  });

  it('cuts a dangling key or value back to the last complete entry', () => {
    expect(JSON.parse(repairJson('{"a":1,"b"')!)).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{"a":1,"b":')!)).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{"a":1,"b":{"c"')!)).toEqual({ a: 1 });
  });

  it('keeps a complete object and ignores what follows it', () => {
    expect(repairJson('{"a":1,} and more {"b":2}')).toBe('{"a":1}');
  });

  it('gives up (null) on text without an object, with mismatched closers, or with nothing complete to keep', () => {
    expect(repairJson('no json here')).toBeNull();
    expect(repairJson('{"a":[1}')).toBeNull();
    expect(repairJson('{"ok":tr')).toBeNull(); // the only entry dangles: cutting it back leaves nothing
    expect(repairJson('{')).toBe('{}'); // an empty object is not an invented value; the schema then rejects it
  });
});

describe('parseAgainst with repair (R3)', () => {
  const schema = z.object({ panels: z.array(z.object({ panelId: z.string(), scene: z.string() })).min(1) });

  it('uses a repaired answer that then validates', () => {
    const out = parseAgainst('{"panels":[{"panelId":"pn_a","scene":"rain"}]', schema);
    expect(out).toEqual({ ok: true, data: { panels: [{ panelId: 'pn_a', scene: 'rain' }] } });
  });

  it('still validates a repaired answer against the schema', () => {
    const out = parseAgainst('{"panels":[', schema);
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.problems).toContain('panels');
  });

  it('says the answer was cut off when the repair fails', () => {
    expect(parseAgainst('{"panels":[{"panelId":"pn_a"]', schema)).toEqual({ ok: false, problems: CUT_OFF_PROBLEM });
  });

  it('keeps the old messages for no object at all', () => {
    expect(parseAgainst('no json', schema)).toEqual({ ok: false, problems: 'The answer contained no JSON object.' });
  });
});

describe('completeStructured with repair (R3)', () => {
  it('a cut-off first answer is repaired without a correction round', async () => {
    const schema = z.object({ ok: z.boolean(), items: z.array(z.number()) });
    const prompts: string[] = [];
    const ask = async ({ prompt }: { system: string; prompt: string }): Promise<string> => { prompts.push(prompt); return '{"ok":true,"items":[1,2'; };
    await expect(completeStructured(ask, { name: 't', task: 'story', system: 's', prompt: 'p', schema })).resolves.toEqual({ ok: true, items: [1, 2] });
    expect(prompts).toHaveLength(1);
  });

  it('the correction round tells the model its answer was cut off', async () => {
    const schema = z.object({ ok: z.boolean() });
    const answers = ['{"ok":tr', '{"ok":true}'];
    const prompts: string[] = [];
    const ask = async ({ prompt }: { system: string; prompt: string }): Promise<string> => { prompts.push(prompt); return answers.shift()!; };
    await expect(completeStructured(ask, { name: 't', task: 'story', system: 's', prompt: 'p', schema })).resolves.toEqual({ ok: true });
    expect(prompts[1]).toContain(CUT_OFF_PROBLEM);
  });
});
