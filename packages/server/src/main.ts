#!/usr/bin/env node
import { defaultModules } from './all-modules.js';
import { startServer, type RunningServer } from './app.js';
import { exitControl } from './exit-control.js';

let server: RunningServer | null = null;
// Ctrl+C, SIGTERM and POST /api/shutdown (`manga stop`) all end here; a second Ctrl+C exits at once (130).
const control = exitControl(() => server?.stop() ?? Promise.resolve(), (code) => process.exit(code));

try {
  server = await startServer({ modules: defaultModules, onShutdown: control.request });
  console.log(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})`);
  process.on('SIGINT', control.signal);
  process.on('SIGTERM', control.signal);
} catch (err) {
  console.error(`manga server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
