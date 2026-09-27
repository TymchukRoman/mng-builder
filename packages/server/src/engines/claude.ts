import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * The prompt itself goes to stdin. Never --bare: it forces API-key auth and bypasses the subscription
 * login. `--safe-mode` disables user-level CLAUDE.md, skills, plugins, hooks and any MCP servers other
 * than --mcp-config's; it does not affect auth, model selection or built-in tools (verified against
 * `claude --help` on 2.1.281). `--system-prompt-file` was considered, to keep the system prompt (which
 * embeds a JSON Schema) off the command line and under Windows' ~32,767-char limit, but does not exist
 * on this CLI version — see the claude.ts header comment / task-6 fix report.
 */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', i.model,
    '--system-prompt', i.system,
    '--tools', i.vision ? 'Read' : '',
    '--safe-mode',
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

  /** Rewritten on every call, never just-if-missing: a previous crash or an external actor could have
   *  left something else at this path, and `--strict-mcp-config` must always see a genuinely empty file. */
  private mcpConfigPath(): string {
    const file = join(dirname(this.opts.cwd), '.claude-empty-mcp.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"mcpServers":{}}\n');
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
      let escalateTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
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
        clearTimeout(escalateTimer);
        clearTimeout(deadlineTimer);
        req.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(text);
      };
      // `child.killed` only means a signal was *sent*, not that the process actually exited — it flips
      // true synchronously inside child.kill(), so `if (!child.killed) …` below it never ran. Whether the
      // process is still alive is `exitCode`/`signalCode` staying null. A kill must always settle within
      // a bounded time even if the child traps or ignores termination (SIGTERM, then SIGKILL after 2s,
      // then force-settle 2s after that, tearing down stdout/stderr so nothing keeps the promise pending).
      const kill = (err: Error): void => {
        if (settled || pendingError) return;
        pendingError = err;
        child.kill();
        escalateTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          deadlineTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(pendingError);
          }, 2_000);
          deadlineTimer.unref();
        }, 2_000);
        escalateTimer.unref();
      };
      const onAbort = (): void => kill(abortError(req.signal));
      const acc = createClaudeAccumulator({
        onInit: (tools) => {
          // `tools === null` means the init event carried no tools array at all — the toolset could not
          // be verified, so this must fail closed exactly like an actually-unlocked toolset would.
          if (tools === null) {
            kill(new PermanentError('claude toolset could not be verified'));
            return;
          }
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
        // No init event ever arrived: same "could not verify the toolset" failure as a malformed one.
        const state = acc.end();
        if (state.tools === null) {
          finish(new PermanentError('claude toolset could not be verified'));
          return;
        }
        try {
          finish(null, this.interpret(state, code, stderr));
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
      // Anchored to the CLI's actual wording, not generic words like "login"/"credential"/"oauth" that
      // a transient failure could also mention in passing (that would misfile it as unavailable instead
      // of retryable).
      if (/not logged in|please run \/login|invalid api key|oauth token/i.test(blob)) throw new EngineUnavailableError(LOGIN_HINT);
      throw new TransientError(`claude failed${code !== null ? ` (exit ${code})` : ''}: ${blob.trim().slice(0, 500) || 'no output'}`);
    }
    return text;
  }

  private probe(): Promise<ServiceState> {
    mkdirSync(this.opts.cwd, { recursive: true });
    return new Promise<ServiceState>((resolve) => {
      let out = '';
      let settled = false;
      let timedOut = false;
      let escalateTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const child = spawn(this.opts.bin, [...(this.opts.binArgs ?? []), 'auth', 'status', '--json'], {
        ...HIDDEN, cwd: this.opts.cwd, shell: false, env: claudeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Settles only from 'close' (or 'error'), same reasoning as ask(): on Windows the child holds its
      // cwd open until it actually exits. A kill must always settle within a bounded time — see ask().
      const finish = (state: ServiceState): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalateTimer);
        clearTimeout(deadlineTimer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        escalateTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          deadlineTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish({ ok: false, detail: 'claude auth status did not answer within 10 s' });
          }, 2_000);
          deadlineTimer.unref();
        }, 2_000);
        escalateTimer.unref();
      }, 10_000);
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({ ok: false, detail: err.code === 'ENOENT' ? `claude CLI not found ("${this.opts.bin}")` : err.message });
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('close', () => {
        if (settled) return;
        if (timedOut) {
          finish({ ok: false, detail: 'claude auth status did not answer within 10 s' });
          return;
        }
        try {
          const status = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
          finish(status.loggedIn ? { ok: true, detail: `logged in (${status.authMethod ?? 'unknown'})` } : { ok: false, detail: LOGIN_HINT });
        } catch {
          finish({ ok: false, detail: `unexpected output from claude auth status: ${out.slice(0, 200)}` });
        }
      });
    });
  }
}
