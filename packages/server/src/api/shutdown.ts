import type { FastifyInstance } from 'fastify';
import { ForbiddenError } from '../errors.js';
import { OK } from './util.js';

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * POST /api/shutdown (loopback only): answers {ok:true}, then — once the response is sent — calls `onShutdown`,
 * which stops the server (and, from main.ts, exits the process). Repeated requests are answered but trigger it once.
 * Only startServer registers it; an app built without `onShutdown` (the test app) has no such route.
 */
export function registerShutdownRoute(app: FastifyInstance, onShutdown: () => void): void {
  let requested = false;
  app.post('/api/shutdown', {
    onResponse: (_req, reply, done) => {
      done();
      if (reply.statusCode !== 200 || requested) return;
      requested = true;
      setImmediate(onShutdown);
    },
  }, async (req) => {
    if (!LOOPBACK.has(req.ip)) throw new ForbiddenError('shutdown is only accepted from this machine');
    return OK;
  });
}
