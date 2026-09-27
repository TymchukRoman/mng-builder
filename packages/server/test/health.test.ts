import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStamp, fetchHealth } from '../src/health.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

function file(path: string, mtimeSec: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '// js');
  utimesSync(path, mtimeSec, mtimeSec);
}

describe('buildStamp', () => {
  it('is the newest .js mtime in the server dist (nested folders included) and the shared dist beside it', () => {
    const d = tempDir();
    dirs.push(d);
    const main = join(d.path, 'packages', 'server', 'dist', 'main.js');
    file(main, 1_000);
    file(join(d.path, 'packages', 'server', 'dist', 'api', 'system.js'), 2_000);
    file(join(d.path, 'packages', 'server', 'dist', 'api', 'system.js.map'), 9_000);
    file(join(d.path, 'packages', 'shared', 'dist', 'index.js'), 1_500);
    expect(buildStamp(main)).toBe('2000000');
    file(join(d.path, 'packages', 'shared', 'dist', 'schemas.js'), 3_000);
    expect(buildStamp(main)).toBe('3000000');
  });

  it("is 'unknown' when there is no compiled code", () => {
    const d = tempDir();
    dirs.push(d);
    expect(buildStamp(join(d.path, 'packages', 'server', 'dist', 'main.js'))).toBe('unknown');
  });
});

describe('fetchHealth', () => {
  it('is null when nothing answers', async () => {
    expect(await fetchHealth('http://127.0.0.1:9')).toBeNull();
  });
});
