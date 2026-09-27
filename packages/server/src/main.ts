#!/usr/bin/env node
import { startServer, type RunningServer } from './app.js';

let server: RunningServer | null = null;
let closing = false;

/** Ctrl+C, SIGTERM and POST /api/shutdown (`manga stop`) all end here: stop the server, then exit. */
function shutdown(): void {
  if (closing) return;
  closing = true;
  (server?.stop() ?? Promise.resolve()).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}

try {
  server = await startServer({ modules: () => [], onShutdown: shutdown });
  console.log(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(`manga server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
