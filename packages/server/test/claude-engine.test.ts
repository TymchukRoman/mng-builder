import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '@manga/shared';
import { ClaudeEngine, LOGIN_HINT, buildClaudeArgs, claudeEnv, type ClaudeEngineOptions } from '../src/engines/claude.js';
import { EngineUnavailableError, QuotaExceededError } from '../src/engines/errors.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';

// The real spawn() by default (every existing test still runs the real fake-claude.mjs process); only the
// "ignores termination" test below overrides it once, to simulate a child that traps/ignores kill signals
// — something Windows cannot do for real, since child.kill() there always maps to a forceful TerminateProcess.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url));

interface Recorded { args: string[]; stdin: string; cwd: string; pid: number; env: { anthropicBaseUrl: string | null; claudeCode: string | null; hasPath: boolean } }

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

/** The pid of the most recent spawn() call, read straight from its return value rather than from
 *  anything the child itself writes. `spawn()` returns as soon as the OS assigns a pid, before the child
 *  has been scheduled to run any of its own code — unlike a file the child writes at startup, this can
 *  never race a slow-to-be-scheduled process under heavy parallel load. */
function lastSpawnedPid(): number {
  const results = vi.mocked(spawn).mock.results;
  const child = results.at(-1)?.value as { pid?: number } | undefined;
  if (!child?.pid) throw new Error('spawn() was not called, or returned no pid');
  return child.pid;
}

const Scene = z.object({ scene: z.string() });
const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'You write scenes.', prompt: 'Panel: Аліса стоїть на даху.', schema: Scene };

describe('buildClaudeArgs', () => {
  it('disables every tool for text requests', () => {
    expect(buildClaudeArgs({ model: 'sonnet', system: 'S', vision: false, mcpConfigPath: 'M', mangasDir: 'D' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--system-prompt', 'S',
      '--tools', '', '--safe-mode', '--strict-mcp-config', '--mcp-config', 'M', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands',
    ]);
  });

  it('allows only Read, and only inside the mangas folder, for image requests', () => {
    const args = buildClaudeArgs({ model: 'opus', system: 'S', vision: true, mcpConfigPath: 'M', mangasDir: 'D' });
    const i = args.indexOf('--tools');
    expect(args.slice(i, i + 2)).toEqual(['--tools', 'Read']);
    expect(args.slice(-4)).toEqual(['--allowedTools', 'Read', '--add-dir', 'D']);
    expect(args).toContain('--safe-mode');
    expect(args).not.toContain('--bare');
  });
});

describe('claudeEnv', () => {
  it('drops API-key and host-session variables (any case) and keeps everything else', () => {
    expect(claudeEnv({
      Path: 'C:\\bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: 'C:\\cfg', HOME: 'h',
      anthropic_api_key: 'lower-case-key', CLAUDE_AGENT_SDK_VERSION: '1.0.0', CLAUDE_EFFORT: 'high',
      CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '0.5',
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

  it('rewrites the empty MCP config file every call, even if something else is there already', async () => {
    const mcpPath = join(dir, 'lib', '.claude-empty-mcp.json');
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, 'not json, left over from a previous crash');
    const { engine, record } = makeEngine(fixture('json-reply'));
    await engine.completeJson(req);
    const r = recorded(record);
    const mcp = r.args[r.args.indexOf('--mcp-config') + 1]!;
    expect(mcp).toBe(mcpPath);
    expect(JSON.parse(readFileSync(mcp, 'utf8'))).toEqual({ mcpServers: {} });
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

  it('fails closed when the toolset was never reported (no system/init event at all)', async () => {
    const { engine } = makeEngine(fixture('no-init'));
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('claude toolset could not be verified');
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
    const err = await engine.completeJson({ ...req, signal: controller.signal }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error).message).toMatch(/aborted|cancelled/i);
    // The promise only settles once the child has actually exited (never before 'close') — precisely so
    // that its pid is gone by now, and a caller can safely rmSync a directory the child had as its cwd.
    const pid = lastSpawnedPid();
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('times out a run that never ends', async () => {
    const { engine } = makeEngine('hang', { timeoutMs: 400 });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toContain('did not finish');
  });

  it('settles within a bounded time even when the child ignores termination (stubbed kill)', async () => {
    // Windows cannot simulate a child that really ignores SIGTERM/SIGKILL: child.kill() there always maps
    // to a forceful TerminateProcess. So this stubs spawn() for one call with a fake ChildProcess whose
    // kill() is a no-op recorder that never actually exits, and drives fake timers to prove the promise
    // still settles, escalating to SIGKILL and then to a hard, close-independent deadline.
    vi.useFakeTimers();
    try {
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
        stdin: { on: vi.fn(), end: vi.fn() },
        kill: vi.fn(() => true),
        exitCode: null as number | null,
        signalCode: null as string | null,
      });
      vi.mocked(spawn).mockImplementationOnce(() => fakeChild as unknown as ReturnType<typeof spawn>);

      const engine = new ClaudeEngine({
        bin: 'unused', cwd: join(dir, 'lib', '.claude-cwd'), mangasDir: join(dir, 'lib', 'mangas'),
        models: () => DEFAULT_SETTINGS.claude.models, timeoutMs: 50,
      });
      const pending = engine.completeJson(req).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(50); // timeoutMs fires -> kill() -> child.kill() (SIGTERM-equivalent)
      expect(fakeChild.kill).toHaveBeenCalledTimes(1);
      expect(fakeChild.kill).toHaveBeenNthCalledWith(1);

      await vi.advanceTimersByTimeAsync(2_000); // still "alive" (exitCode/signalCode null) -> escalate
      expect(fakeChild.kill).toHaveBeenCalledTimes(2);
      expect(fakeChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(fakeChild.stdout.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000); // 'close' never came -> hard deadline forces settlement
      const err = await pending;
      expect(err).toBeInstanceOf(TransientError);
      expect((err as Error).message).toContain('did not finish');
      expect(fakeChild.stdout.destroy).toHaveBeenCalledTimes(1);
      expect(fakeChild.stderr.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('health reads claude auth status', async () => {
    await expect(makeEngine('logged-in').engine.health()).resolves.toEqual({ ok: true, detail: 'logged in (claude.ai)' });
    await expect(makeEngine('logged-out').engine.health()).resolves.toEqual({ ok: false, detail: LOGIN_HINT });
  });
});
