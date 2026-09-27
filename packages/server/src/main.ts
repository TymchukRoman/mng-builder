#!/usr/bin/env node
import { startServer } from './app.js';

try {
  const server = await startServer({ modules: () => [] });
  console.log(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(`manga server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
