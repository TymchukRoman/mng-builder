import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServiceState, Settings } from '@manga/shared';
import { PermanentError, TransientError } from '../jobs/index.js';
import { abortError } from '../util/abort.js';
import { HIDDEN } from '../util/hidden.js';
import { createClaudeAccumulator, type ClaudeRunState } from './claude-stream.js';
import { EngineUnavailableError, QuotaExceededError } from './errors.js';
import { completeStructured } from './structured.js';
import type { JsonRequest, TextEngine } from './types.js';

export const LOGIN_HINT = 'Claude is not logged in. Run `claude` once in a terminal (or `claude auth login`) to sign in with your subscription.';

export interface ClaudeEngineOptions {
  /** config.claudeBin, normally 'claude' (a native exe on this machine). */
  bin: string;
  /** Arguments placed before the claude arguments (tests run `node fake-claude.mjs …`). */
  binArgs?: string[];
  /** <library>/.claude-cwd — empty, no CLAUDE.md, outside any repo. */
  cwd: string;
  /** <library>/mangas — the only directory Read may open. */
  mangasDir: string;
  models: () => Settings['claude']['models'];
  onRateLimit?: (resetsAt: string | null, reason: string) => void;
  timeoutMs?: number;
  healthTtlMs?: number;
}

export interface ClaudeArgsInput { model: string; system: string; vision: boolean; mcpConfigPath: string; mangasDir: string }

/** The prompt itself goes to stdin. Never --bare: it forces API-key auth and bypasses the subscription login. */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', i.model,
    '--system-prompt', i.system,
    '--tools', i.vision ? 'Read' : '',
    '--strict-mcp-config', '--mcp-config', i.mcpConfigPath,
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--disable-slash-commands',
  ];
  if (i.vision) args.push('--allowedTools', 'Read', '--add-dir', i.mangasDir);
  return args;
}

const HOST_SESSION_VARS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR']);

/**
 * The inherited environment minus API-key and host-session variables. A server
 * started from inside a Claude Code session inherits ANTHROPIC_BASE_URL and
 * CLAUDE_CODE_*; passing them on would make the child use the host session
 * instead of the owner's subscription login. Keys keep their original case
 * (Windows `Path`), which is why this copies rather than rebuilds.
 */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_CODE_') || HOST_SESSION_VARS.has(upper)) continue;
    out[key] = value;
  }
  return out;
}

function imageList(paths: string[]): string {
  return `Image files (open every one with the Read tool before answering):\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}

function resetSuffix(text: string): string | null {
  const match = /\|(\d{10})\b/.exec(text);
  return match ? new Date(Number(match[1]) * 1000).toISOString() : null;
}

type AskContext = Pick<JsonRequest<unknown>, 'task' | 'images' | 'signal' | 'onProgress'>;

export class ClaudeEngine implements TextEngine {
  readonly name = 'claude' as const;
  private healthCache: { at: number; state: ServiceState } | null = null;

  constructor(private readonly opts: ClaudeEngineOptions) {}

  completeJson<T>(req: JsonRequest<T>): Promise<T> {
    return completeStructured(({ system, prompt }) => this.ask(system, prompt, req), req);
  }

  async health(): Promise<ServiceState> {
    const ttl = this.opts.healthTtlMs ?? 30_000;
    if (this.healthCache && Date.now() - this.healthCache.at < ttl) return this.healthCache.state;
    const state = await this.probe();
    this.healthCache = { at: Date.now(), state };
    return state;
  }

  private mcpConfigPath(): string {
    const file = join(dirname(this.opts.cwd), '.claude-empty-mcp.json');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"mcpServers":{}}\n');
    }
    return file;
  }

  private ask(system: string, prompt: string, req: AskContext): Promise<string> {
    const images = req.images ?? [];
    const vision = images.length > 0;
    const model = this.opts.models()[req.task];
    mkdirSync(this.opts.cwd, { recursive: true });
    const args = [
      ...(this.opts.binArgs ?? []),
      ...buildClaudeArgs({ model, system, vision, mcpConfigPath: this.mcpConfigPath(), mangasDir: this.opts.mangasDir }),
    ];
    const input = vision ? `${prompt}\n\n${imageList(images)}` : prompt;
    const allowed = vision ? ['Read'] : [];
    const timeoutMs = this.opts.timeoutMs ?? 600_000;
    req.onProgress?.(`Asking Claude (${model})`);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      // Set once a proactive kill (toolset breach, timeout, abort) is in flight. The promise settles
      // from 'close', never before: on Windows the child holds a lock on its own cwd until it actually
      // exits, and callers routinely rmSync that directory right after completeJson settles.
      let pendingError: Error | null = null;
      const child = spawn(this.opts.bin, args, {
        ...HIDDEN, cwd: this.opts.cwd, shell: false, env: claudeEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'],
      });
      const finish = (err: Error | null, text = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(text);
      };
      const kill = (err: Error): void => {
        if (settled || pendingError) return;
        pendingError = err;
        child.kill();
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2_000).unref();
      };
      const onAbort = (): void => kill(abortError(req.signal));
      const acc = createClaudeAccumulator({
        onInit: (tools) => {
          const unexpected = tools.filter((t) => !allowed.includes(t));
          if (unexpected.length > 0) {
            kill(new PermanentError(`claude run aborted: unexpected tools available (${unexpected.join(', ')}). The --tools flag did not take effect with this CLI version.`));
          }
        },
        onToolUse: (name) => req.onProgress?.(name === 'Read' ? 'Looking at the images' : `Using ${name}`),
      });

      timer = setTimeout(() => kill(new TransientError(`claude did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      if (req.signal?.aborted) queueMicrotask(onAbort);
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(err.code === 'ENOENT'
          ? new EngineUnavailableError(`claude CLI not found ("${this.opts.bin}"). Install Claude Code or set "claudeBin" in ~/.manga-builder/config.json.`)
          : new TransientError(`claude could not start: ${err.message}`));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (!settled && !pendingError) acc.push(chunk); });
      child.on('close', (code) => {
        if (settled) return;
        if (pendingError) { finish(pendingError); return; }
        try {
          finish(null, this.interpret(acc.end(), code, stderr));
        } catch (err) {
          finish(err as Error);
        }
      });
      child.stdin.on('error', () => { /* the child exited before reading stdin; 'close' or 'error' reports why */ });
      child.stdin.end(input, 'utf8');
    });
  }

  private interpret(state: ClaudeRunState, code: number | null, stderr: string): string {
    const text = state.result?.text ?? state.text;
    const failed = state.result ? state.result.isError : code !== 0;
    const blob = `${text}\n${stderr}`;
    if (failed && (state.rateLimit?.status === 'rejected' || /usage limit|hit your limit|rate limit/i.test(blob))) {
      const resetsAt = state.rateLimit?.resetsAt ? new Date(state.rateLimit.resetsAt * 1000).toISOString() : resetSuffix(blob);
      const reason = state.rateLimit ? `Claude quota exhausted (${state.rateLimit.rateLimitType} window)` : 'Claude quota exhausted';
      this.opts.onRateLimit?.(resetsAt, reason);
      throw new QuotaExceededError(resetsAt);
    }
    if (failed) {
      if (/not logged in|\/login|log ?in|authenticat|invalid api key|oauth|credential/i.test(blob)) throw new EngineUnavailableError(LOGIN_HINT);
      throw new TransientError(`claude failed${code !== null ? ` (exit ${code})` : ''}: ${blob.trim().slice(0, 500) || 'no output'}`);
    }
    return text;
  }

  private probe(): Promise<ServiceState> {
    mkdirSync(this.opts.cwd, { recursive: true });
    return new Promise<ServiceState>((resolve) => {
      let out = '';
      let timedOut = false;
      const child = spawn(this.opts.bin, [...(this.opts.binArgs ?? []), 'auth', 'status', '--json'], {
        ...HIDDEN, cwd: this.opts.cwd, shell: false, env: claudeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Resolve only from 'close', same reasoning as ask(): on Windows the child holds its cwd open
      // until it actually exits, and a timed-out or missing binary must not race that exit.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 10_000);
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: err.code === 'ENOENT' ? `claude CLI not found ("${this.opts.bin}")` : err.message });
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('close', () => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, detail: 'claude auth status did not answer within 10 s' });
          return;
        }
        try {
          const status = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
          resolve(status.loggedIn ? { ok: true, detail: `logged in (${status.authMethod ?? 'unknown'})` } : { ok: false, detail: LOGIN_HINT });
        } catch {
          resolve({ ok: false, detail: `unexpected output from claude auth status: ${out.slice(0, 200)}` });
        }
      });
    });
  }
}
