import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { PermanentError } from '../jobs/index.js';
import { HIDDEN_DETACHED } from '../util/hidden.js';

export interface ComfyLauncherOptions {
  comfyRoot: string;
  comfyUrl: string;
  timeoutMs?: number;
  pollMs?: number;
  spawnImpl?: typeof spawn;
}

/** Starts the shared claude-image-gen ComfyUI exactly as gen.py's ensure_server() does. */
export class ComfyLauncher {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly logPath: string;
  private readonly dir: string;
  private readonly python: string;
  private readonly main: string;
  private readonly port: string;
  private readonly spawnImpl: typeof spawn;

  constructor(opts: ComfyLauncherOptions) {
    this.dir = join(opts.comfyRoot, 'ComfyUI');
    this.python = join(this.dir, '.venv', 'Scripts', 'python.exe');
    this.main = join(this.dir, 'main.py');
    this.logPath = join(this.dir, 'server.log');
    this.port = new URL(opts.comfyUrl).port || '8188';
    this.timeoutMs = opts.timeoutMs ?? 240_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  command(): { file: string; args: string[]; cwd: string } {
    return { file: this.python, args: [this.main, '--port', this.port, '--listen', '127.0.0.1', '--fast'], cwd: this.dir };
  }

  /** Spawns and forgets: the server outlives this process so later images start warm. */
  start(): void {
    if (!existsSync(this.python) || !existsSync(this.main)) {
      throw new PermanentError(`ComfyUI is not installed at ${this.dir} (set "comfyRoot" in ~/.manga-builder/config.json)`);
    }
    const { file, args, cwd } = this.command();
    const log = openSync(this.logPath, 'a');
    try {
      const child = this.spawnImpl(file, args, { ...HIDDEN_DETACHED, cwd, stdio: ['ignore', log, log] });
      child.on('error', () => { /* surfaces as the health poll timing out, with the log path */ });
      child.unref();
    } finally {
      closeSync(log);
    }
  }
}
