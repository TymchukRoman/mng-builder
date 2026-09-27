import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, loadConfig, readServerInfo, removeServerInfo, writeServerInfo } from '../src/config.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});
function dir(): string {
  const d = tempDir();
  dirs.push(d);
  return d.path;
}

describe('loadConfig', () => {
  it('defaults to ~/MangaBuilder, port 4317 and the claude-image-gen ComfyUI', () => {
    const c = loadConfig({}, { env: {}, file: join(dir(), 'missing.json') });
    expect(c.libraryPath).toMatch(/MangaBuilder$/);
    expect(c).toMatchObject({
      port: 4317,
      comfyRoot: 'C:/Users/roman/Dev/Exalink/claude-image-gen',
      comfyUrl: 'http://127.0.0.1:8188',
      ollamaUrl: 'http://127.0.0.1:11434',
      claudeBin: 'claude',
    });
  });

  it('reads config.json, then lets MANGA_LIBRARY / MANGA_PORT and explicit overrides win', () => {
    const file = join(dir(), 'config.json');
    writeFileSync(file, JSON.stringify({ libraryPath: 'D:/Manga', port: 5000, comfyUrl: 'http://127.0.0.1:9000' }));
    expect(loadConfig({}, { env: {}, file })).toMatchObject({ libraryPath: 'D:/Manga', port: 5000, comfyUrl: 'http://127.0.0.1:9000' });
    expect(loadConfig({}, { env: { MANGA_LIBRARY: 'E:/Lib', MANGA_PORT: '6000' }, file })).toMatchObject({ libraryPath: 'E:/Lib', port: 6000 });
    expect(loadConfig({ port: 0 }, { env: { MANGA_PORT: '6000' }, file }).port).toBe(0);
  });

  it('names the file when config.json is broken', () => {
    const file = join(dir(), 'config.json');
    writeFileSync(file, '{ not json');
    expect(() => loadConfig({}, { env: {}, file })).toThrow(/invalid config file .*config\.json/);
  });

  it('reads the file MANGA_CONFIG names instead of ~/.manga-builder/config.json; an explicit file still wins (F15)', () => {
    const file = join(dir(), 'custom.json');
    writeFileSync(file, JSON.stringify({ port: 5151, claudeBin: 'claude-dev' }));
    expect(configPath({ MANGA_CONFIG: file })).toBe(file);
    expect(configPath({})).toMatch(/[\\/]\.manga-builder[\\/]config\.json$/);
    expect(loadConfig({}, { env: { MANGA_CONFIG: file } })).toMatchObject({ port: 5151, claudeBin: 'claude-dev' });
    expect(loadConfig({}, { env: { MANGA_CONFIG: file }, file: join(dir(), 'missing.json') }).port).toBe(4317);
  });

  it('is hermetic under vitest: MANGA_CONFIG points at a file that cannot exist (F15)', () => {
    const path = process.env['MANGA_CONFIG'] ?? '';
    expect(path).toMatch(/no-config\.json$/);
    expect(existsSync(path)).toBe(false);
    expect(configPath()).toBe(path);
  });

  it('rejects a non-numeric MANGA_PORT', () => {
    expect(() => loadConfig({}, { env: { MANGA_PORT: 'abc' }, file: join(dir(), 'missing.json') })).toThrow(/port/);
  });
});

describe('server.json', () => {
  it('round-trips and is only removed by the process that wrote it', () => {
    const lib = dir();
    expect(readServerInfo(lib)).toBeNull();
    writeServerInfo(lib, { pid: 123, port: 4317, startedAt: '2026-09-27T00:00:00.000Z' });
    expect(readServerInfo(lib)).toEqual({ pid: 123, port: 4317, startedAt: '2026-09-27T00:00:00.000Z' });
    removeServerInfo(lib, 999);
    expect(readServerInfo(lib)).not.toBeNull();
    removeServerInfo(lib, 123);
    expect(readServerInfo(lib)).toBeNull();
  });

  it('treats a corrupt server.json as absent', () => {
    const lib = dir();
    writeFileSync(join(lib, 'server.json'), '{"pid":"x"}');
    expect(readServerInfo(lib)).toBeNull();
  });
});
