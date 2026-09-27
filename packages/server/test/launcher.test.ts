import type { SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComfyLauncher } from '../src/imaging/launcher.js';
import { fakeComfyRoot } from './helpers/comfy-root.js';

describe('ComfyLauncher', () => {
  it('builds the gen.py command line with the port from comfyUrl', () => {
    const root = fakeComfyRoot();
    const launcher = new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8190' });
    expect(launcher.command()).toEqual({
      file: join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
      args: [join(root, 'ComfyUI', 'main.py'), '--port', '8190', '--listen', '127.0.0.1', '--fast'],
      cwd: join(root, 'ComfyUI'),
    });
    expect(launcher.logPath).toBe(join(root, 'ComfyUI', 'server.log'));
    expect(launcher.timeoutMs).toBe(240_000);
    expect(new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1' }).command().args[2]).toBe('8188');
  });

  it('spawns detached and hidden, appending output to server.log', () => {
    const root = fakeComfyRoot();
    const calls: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawnImpl = ((file: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ file, args, options });
      return { unref() {}, on() { return this; } };
    }) as unknown as typeof spawn;
    new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8188', spawnImpl }).start();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ detached: true, windowsHide: true, cwd: join(root, 'ComfyUI') });
    const stdio = calls[0]!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(existsSync(join(root, 'ComfyUI', 'server.log'))).toBe(true);
  });

  it('refuses when ComfyUI is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-comfy-'));
    expect(() => new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8188' }).start()).toThrow(/ComfyUI is not installed at/);
  });
});
