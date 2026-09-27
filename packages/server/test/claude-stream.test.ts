import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyLine, createClaudeAccumulator, parseClaudeStream } from '../src/engines/claude-stream.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url)), 'utf8');

describe('claude stream-json parsing', () => {
  it('reads the result text, empty toolset and window from a real capture', () => {
    const state = parseClaudeStream(fixture('simple-reply'));
    expect(state.result).toEqual({ isError: false, text: 'ready' });
    expect(state.tools).toEqual([]);
    expect(state.rateLimit).toEqual({ status: 'allowed', resetsAt: 1787500200, rateLimitType: 'five_hour' });
  });

  it('assembles a long streamed reply', () => {
    const state = parseClaudeStream(fixture('long-stream'));
    expect(state.result?.isError).toBe(false);
    expect(state.result?.text).toContain('40');
  });

  it('survives arbitrary chunk boundaries', () => {
    const raw = fixture('long-stream');
    const acc = createClaudeAccumulator();
    for (let i = 0; i < raw.length; i += 7) acc.push(raw.slice(i, i + 7));
    expect(acc.end()).toEqual(parseClaudeStream(raw));
  });

  it('keeps a rejected window even when an allowed one arrives later', () => {
    const state = parseClaudeStream(fixture('rate-limited'));
    expect(state.rateLimit).toEqual({ status: 'rejected', resetsAt: 4102444800, rateLimitType: 'five_hour' });
    expect(state.result?.isError).toBe(true);
  });

  it('reports the init toolset and tool uses through hooks', () => {
    const inits: Array<string[] | null> = [];
    const uses: string[] = [];
    const state = parseClaudeStream(fixture('review-reply'), { onInit: (t) => inits.push(t), onToolUse: (n) => uses.push(n) });
    expect(inits).toEqual([['Read']]);
    expect(uses).toEqual(['Read']);
    expect(state.result?.text).toContain('"pass":false');
  });

  it('reports a null toolset when system/init carries no tools array, distinct from a declared empty one', () => {
    expect(classifyLine('{"type":"system","subtype":"init"}')).toEqual({ kind: 'init', tools: null });
    expect(classifyLine('{"type":"system","subtype":"init","tools":[]}')).toEqual({ kind: 'init', tools: [] });
  });

  it('ignores garbage and host chatter', () => {
    expect(classifyLine('not json')).toEqual({ kind: 'ignore' });
    expect(classifyLine('{"type":"system","subtype":"hook_started"}')).toEqual({ kind: 'ignore' });
    expect(classifyLine('{"type":"stream_event","event":{"type":"message_stop"}}')).toEqual({ kind: 'ignore' });
  });
});
