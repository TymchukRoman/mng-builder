import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, never against a stale dist/.
    alias: [
      { find: /^@manga\/shared$/, replacement: src('./packages/shared/src/index.ts') },
      { find: /^@manga\/server\/config$/, replacement: src('./packages/server/src/config.ts') },
      { find: /^@manga\/server$/, replacement: src('./packages/server/src/index.ts') },
    ],
  },
  test: {
    // Hermetic config: loadConfig never reads the developer's real ~/.manga-builder/config.json. A path below a file
    // can never exist, so this is always "no config file".
    env: { MANGA_CONFIG: src('./vitest.config.ts/no-config.json') },
    include: ['packages/*/test/**/*.test.ts?(x)'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
