import { newId, type Image, type RefSlot } from '@manga/shared';
import { ValidationError } from '../errors.js';
import { readImageMeta } from '../files/image-meta.js';
import type { Store } from '../store/index.js';

export const ACCEPTED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

export interface UploadRequest {
  mangaId: string;
  owner: { type: Image['ownerType']; id: string };
  role: RefSlot | null;
  bytes: Uint8Array;
  mimetype: string;
}

/** Stores the original bytes (PNG or JPEG only) and registers an `uploaded` Image. Nothing is written for a rejected file. */
export function saveUploadedImage(store: Store, req: UploadRequest): Image {
  if (!ACCEPTED_IMAGE_TYPES.has(req.mimetype)) throw new ValidationError(`unsupported file type ${req.mimetype}: upload a PNG or JPEG`);
  const meta = readImageMeta(req.bytes);
  if (meta === null) throw new ValidationError('the file is not a readable PNG or JPEG');
  const id = newId('im');
  const path = store.files.writeImage(req.mangaId, id, req.bytes);
  try {
    return store.images.create({
      id, mangaId: req.mangaId, ownerType: req.owner.type, ownerId: req.owner.id, role: req.role, path,
      width: meta.width, height: meta.height, source: 'uploaded', parentImageId: null, gen: null, review: null,
    });
  } catch (err) {
    store.files.remove(path);
    throw err;
  }
}
