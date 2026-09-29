import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Never 4317 (the real server's port). Override with MANGA_E2E_PORT when 4399 is taken.
const PORT = Number(process.env['MANGA_E2E_PORT'] ?? 4399);
// One throwaway library per run; workers inherit process.env, so they all see the same folder.
const FRESH = process.env['MANGA_E2E_LIBRARY'] === undefined;
const LIBRARY = (process.env['MANGA_E2E_LIBRARY'] ??= mkdtempSync(join(tmpdir(), 'manga-e2e-')));
// Only the process that created the folder removes it. The server may still hold the sqlite file when we exit; leaving the folder to the OS temp cleanup is fine then.
if (FRESH) {
  process.on('exit', () => {
    try { rmSync(LIBRARY, { recursive: true, force: true, maxRetries: 3 }); } catch { /* still in use */ }
  });
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  // The built server serves the built UI (packages/ui/dist) on its own origin: run `npm run build` first (`npm run e2e` does).
  webServer: {
    command: 'node packages/server/dist/main.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      MANGA_FAKES: '1',
      MANGA_LIBRARY: LIBRARY,
      MANGA_PORT: String(PORT),
      // A file that does not exist: the developer's real ~/.manga-builder/config.json is never read.
      MANGA_CONFIG: join(LIBRARY, 'no-config.json'),
    },
  },
});
