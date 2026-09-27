import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { ForbiddenError } from '../errors.js';

/** The port the app listens on; null before listen (app.inject in tests, where nothing can reach it). */
function boundPort(app: FastifyInstance): number | null {
  const address = app.server.address();
  return address !== null && typeof address === 'object' ? (address as AddressInfo).port : null;
}

/**
 * Against DNS rebinding and cross-site WebSockets: the Host header must be `127.0.0.1:<port>` or `localhost:<port>`,
 * and a WebSocket upgrade that carries an Origin must come from `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 * Anything else is 403 forbidden. A dev proxy (M3's Vite) must rewrite Host and Origin to the server's.
 */
export function installRequestGuards(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const port = boundPort(app);
    if (port === null) return;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !hosts.includes(host)) throw new ForbiddenError(`host ${host ?? '(none)'} is not allowed`);
    const origin = req.headers.origin?.toLowerCase();
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (upgrade && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      throw new ForbiddenError(`origin ${origin} is not allowed`);
    }
  });
}
