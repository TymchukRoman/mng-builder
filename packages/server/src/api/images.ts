import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { deleteImage } from '../domain/index.js';
import { NotFoundError } from '../errors.js';
import { sniffImageMime } from '../files/image-meta.js';
import { emitEntity, OK, type IdParams } from './util.js';

/** The size and the first bytes (enough to tell PNG from JPEG) of a file. */
async function head(path: string): Promise<{ size: number; bytes: Buffer }> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(8);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return { size: (await file.stat()).size, bytes: bytes.subarray(0, bytesRead) };
  } finally {
    await file.close();
  }
}

export function registerImageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/images/:id', async (req): Promise<Image> => store.images.require(req.params.id));

  /** Also clears the active/ref pointers that referenced it. */
  app.delete<IdParams>('/api/images/:id', async (req) => {
    const image = deleteImage(store, req.params.id);
    emitEntity(bus, 'image', image.id, 'deleted', image.mangaId);
    emitEntity(bus, image.ownerType, image.ownerId, 'updated', image.mangaId);
    return OK;
  });

  /** Image bytes by id, streamed from disk. Uploaded JPEGs keep their bytes under the .png name, so the type is sniffed. */
  app.get<{ Params: { file: string } }>('/files/images/:file', async (req, reply) => {
    const { file } = req.params;
    if (!file.endsWith('.png')) throw new NotFoundError('image file', file);
    const image = store.images.require(file.slice(0, -'.png'.length));
    const path = store.files.abs(image.path);
    let start: { size: number; bytes: Buffer };
    try {
      start = await head(path);
    } catch {
      throw new NotFoundError('image file', image.path);
    }
    return reply
      .type(sniffImageMime(start.bytes))
      .header('content-length', start.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(path));
  });
}
