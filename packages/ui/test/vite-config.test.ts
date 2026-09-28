import { describe, expect, it } from 'vitest';
import type { ProxyOptions } from 'vite';
import config from '../vite.config';

// F1 (controller ruling, blocker): without changeOrigin and an explicit lowercase `origin` header,
// the server's Host/Origin guard (api/guards.ts) answers 403 to every proxied /api and /files
// request and to the /api/events WebSocket upgrade. See docs/superpowers/plans/2026-09-27-00-contracts.md
// Contract B for the requirement this config satisfies.
describe('vite.config proxy', () => {
  const proxy = config.server?.proxy as Record<string, ProxyOptions>;

  it('rewrites Host and Origin for /api, including the websocket upgrade', () => {
    expect(proxy['/api']).toMatchObject({
      target: 'http://127.0.0.1:4317',
      ws: true,
      changeOrigin: true,
      headers: { origin: 'http://127.0.0.1:4317' },
    });
  });

  it('rewrites Host for /files', () => {
    expect(proxy['/files']).toMatchObject({
      target: 'http://127.0.0.1:4317',
      changeOrigin: true,
    });
  });
});
