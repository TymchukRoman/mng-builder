import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '@manga/shared';
import { ClaudeEngine, LOGIN_HINT, buildClaudeArgs, claudeEnv, type ClaudeEngineOptions } from '../src/engines/claude.js';
import { EngineUnavailableError, QuotaExceededError } from '../src/engines/errors.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url));

interface Recorded { args: string[]; stdin: string; cwd: string; env: { anthropicBaseUrl: string | null; claudeCode: string | null; hasPath: boolean } }

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'manga-claude-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

function makeEngine(fx: string, extra: Partial<ClaudeEngineOptions> = {}): { engine: ClaudeEngine; record: string } {
  const record = join(dir, 'record.json');
  const engine = new ClaudeEngine({
    bin: process.execPath, binArgs: [FAKE, fx, record],
    cwd: join(dir, 'lib', '.claude-cwd'), mangasDir: join(dir, 'lib', 'mangas'),
    models: () => DEFAULT_SETTINGS.claude.models, ...extra,
  });
  return { engine, record };
}
const recorded = (path: string): Recorded => JSON.parse(readFileSync(path, 'utf8')) as Recorded;

const Scene = z.object({ scene: z.string() });
const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'You write scenes.', prompt: 'Panel: Аліса стоїть на даху.', schema: Scene };

describe('buildClaudeArgs', () => {
  it('disables every tool for text requests', () => {
    expect(buildClaudeArgs({ model: 'sonnet', system: 'S', vision: false, mcpConfigPath: 'M', mangasDir: 'D' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--system-prompt', 'S',
      '--tools', '', '--strict-mcp-config', '--mcp-config', 'M', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands',
    ]);
  });

  it('allows only Read, and only inside the mangas folder, for image requests', () => {
    const args = buildClaudeArgs({ model: 'opus', system: 'S', vision: true, mcpConfigPath: 'M', mangasDir: 'D' });
    const i = args.indexOf('--tools');
    expect(args.slice(i, i + 2)).toEqual(['--tools', 'Read']);
    expect(args.slice(-4)).toEqual(['--allowedTools', 'Read', '--add-dir', 'D']);
    expect(args).not.toContain('--bare');
  });
});

describe('claudeEnv', () => {
  it('drops API-key and host-session variables and keeps everything else', () => {
    expect(claudeEnv({
      Path: 'C:\\bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: 'C:\\cfg', HOME: 'h',
    })).toEqual({ Path: 'C:\\bin', CLAUDE_CONFIG_DIR: 'C:\\cfg', HOME: 'h' });
  });
});

describe('ClaudeEngine', () => {
  it('returns schema-checked JSON, runs in the isolated cwd and sends the prompt on stdin', async () => {
    const { engine, record } = makeEngine(fixture('json-reply'));
    await expect(engine.completeJson(req)).resolves.toEqual({ scene: 'solo, standing, school rooftop, sunset' });
    const r = recorded(record);
    expect(r.stdin).toBe('Panel: Аліса стоїть на даху.');
    expect(r.cwd.toLowerCase()).toBe(join(dir, 'lib', '.claude-cwd').toLowerCase());
    expect(r.args[r.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(r.args[r.args.indexOf('--system-prompt') + 1]).toContain('You write scenes.');
    const mcp = r.args[r.args.indexOf('--mcp-config') + 1]!;
    expect(JSON.parse(readFileSync(mcp, 'utf8'))).toEqual({ mcpServers: {} });
    expect(readdirSync(join(dir, 'lib', '.claude-cwd'))).toEqual([]);
  });

  it('never passes ANTHROPIC_* or host-session variables to the child', async () => {
    const saved = { base: process.env['ANTHROPIC_BASE_URL'], code: process.env['CLAUDECODE'] };
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:1';
    process.env['CLAUDECODE'] = '1';
    try {
      const { engine, record } = makeEngine(fixture('json-reply'));
      await engine.completeJson(req);
      expect(recorded(record).env).toEqual({ anthropicBaseUrl: null, claudeCode: null, hasPath: true });
    } finally {
      if (saved.base === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = saved.base;
      if (saved.code === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = saved.code;
    }
  });

  it('lists image paths for the Read tool on vision requests', async () => {
    const { engine, record } = makeEngine(fixture('review-reply'));
    const progress: string[] = [];
    const schema = z.object({ pass: z.boolean(), issues: z.array(z.object({ kind: z.string(), note: z.string() })) });
    const out = await engine.completeJson({
      name: 'review', task: 'review', system: 'Review.', prompt: 'Check.', schema,
      images: ['C:\\lib\\mangas\\a.png', 'C:\\lib\\mangas\\b.png'], onProgress: (l) => progress.push(l),
    });
    expect(out.pass).toBe(false);
    const r = recorded(record);
    expect(r.stdin).toBe('Check.\n\nImage files (open every one with the Read tool before answering):\n1. C:\\lib\\mangas\\a.png\n2. C:\\lib\\mangas\\b.png');
    expect(r.args.slice(-2)).toEqual(['--add-dir', join(dir, 'lib', 'mangas')]);
    expect(progress).toEqual(['Asking Claude (sonnet)', 'Looking at the images']);
  });

  it('turns a rejected rate-limit window into QuotaExceededError and reports it', async () => {
    const seen: Array<[string | null, string]> = [];
    const { engine } = makeEngine(fixture('rate-limited'), { onRateLimit: (at, reason) => { seen.push([at, reason]); } });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).resetsAt).toBe('2100-01-01T00:00:00.000Z');
    expect(seen).toEqual([['2100-01-01T00:00:00.000Z', 'Claude quota exhausted (five_hour window)']]);
  });

  it('explains how to log in when the CLI is signed out', async () => {
    const { engine } = makeEngine(fixture('not-logged-in'));
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe(LOGIN_HINT);
  });

  it('kills a run whose toolset is not locked down', async () => {
    const { engine } = makeEngine(fixture('tools-leak'));
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain('Bash, Read, Write');
  });

  it('reports a missing binary as engine unavailable', async () => {
    const engine = new ClaudeEngine({
      bin: join(dir, 'no-such-claude.exe'), cwd: join(dir, 'c'), mangasDir: dir, models: () => DEFAULT_SETTINGS.claude.models,
    });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toContain('claude CLI not found');
  });

  it('kills the child when the job is cancelled', async () => {
    const { engine } = makeEngine('hang');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    await expect(engine.completeJson({ ...req, signal: controller.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out a run that never ends', async () => {
    const { engine } = makeEngine('hang', { timeoutMs: 400 });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toContain('did not finish');
  });

  it('health reads claude auth status', async () => {
    await expect(makeEngine('logged-in').engine.health()).resolves.toEqual({ ok: true, detail: 'logged in (claude.ai)' });
    await expect(makeEngine('logged-out').engine.health()).resolves.toEqual({ ok: false, detail: LOGIN_HINT });
  });
});
