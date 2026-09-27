import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** packages/ui/dist (both src/api and dist/api sit three levels below packages/). */
export function defaultUiDir(): string {
  return fileURLToPath(new URL('../../../ui/dist', import.meta.url));
}

/**
 * Serves the built UI when the folder exists, with an SPA fallback: a GET outside /api and /files with no file
 * extension gets index.html. Everything else that matches no route is a JSON 404. The wildcard route looks files up
 * per request, so a UI rebuilt while the server runs (new hashed asset names) is served without a restart; a file it
 * cannot find falls through to the not-found handler below.
 */
export async function registerStaticUi(app: FastifyInstance, uiDir: string | null): Promise<void> {
  const root = uiDir !== null && existsSync(uiDir) ? uiDir : null;
  if (root !== null) await app.register(fastifyStatic, { root, wildcard: true });
  const hasUi = root !== null;
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const reserved = path === '/api' || path.startsWith('/api/') || path === '/files' || path.startsWith('/files/');
    if (hasUi && !reserved && (req.method === 'GET' || req.method === 'HEAD') && extname(path) === '') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: `no route for ${req.method} ${path}` } });
  });
}
