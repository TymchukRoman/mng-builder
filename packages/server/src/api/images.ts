import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { deleteImage } from '../domain/index.js';
import { NotFoundError } from '../errors.js';
import { sniffImageMime } from '../files/image-meta.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerImageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/images/:id', async (req): Promise<Image> => store.images.require(req.params.id));

  /** Also clears the active/ref pointers that referenced it. */
  app.delete<IdParams>('/api/images/:id', async (req) => {
    const image = deleteImage(store, req.params.id);
    emitEntity(bus, 'image', image.id, 'deleted', image.mangaId);
    emitEntity(bus, image.ownerType, image.ownerId, 'updated', image.mangaId);
    return OK;
  });

  /** Image bytes by id. Uploaded JPEGs keep their bytes under the .png name, so the type is sniffed. */
  app.get<{ Params: { file: string } }>('/files/images/:file', async (req, reply) => {
    const { file } = req.params;
    if (!file.endsWith('.png')) throw new NotFoundError('image file', file);
    const image = store.images.require(file.slice(0, -'.png'.length));
    let bytes: Buffer;
    try {
      bytes = readFileSync(store.files.abs(image.path));
    } catch {
      throw new NotFoundError('image file', image.path);
    }
    return reply
      .type(sniffImageMime(bytes))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(bytes);
  });
}
