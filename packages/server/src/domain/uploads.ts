import { newId, type Image, type RefSlot } from '@manga/shared';
import { ValidationError } from '../errors.js';
import { readImageMeta } from '../files/image-meta.js';
import type { Store } from '../store/index.js';
import { removeFiles } from './delete.js';

/** The declared content type is not trusted: the bytes decide (PNG or JPEG). */
export interface UploadRequest {
  mangaId: string;
  owner: { type: Image['ownerType']; id: string };
  role: RefSlot | null;
  bytes: Uint8Array;
}

function requireOwner(store: Store, owner: UploadRequest['owner']): void {
  if (owner.type === 'panel') store.panels.require(owner.id);
  else store.characters.require(owner.id);
}

/**
 * Stores the original bytes (a PNG or JPEG, recognised by its content) and registers an `uploaded` Image. One
 * transaction re-checks that the owner still exists (it may have been deleted while the upload was read), inserts
 * the row and runs `attach` (which points the owner at the image). Nothing is left behind when any of it fails.
 */
export function saveUploadedImage(store: Store, req: UploadRequest, attach: (image: Image) => void = () => {}): Image {
  const meta = readImageMeta(req.bytes);
  if (meta === null) throw new ValidationError('the file is not a readable PNG or JPEG image');
  const id = newId('im');
  const path = store.files.writeImage(req.mangaId, id, req.bytes);
  try {
    return store.tx(() => {
      requireOwner(store, req.owner);
      const image = store.images.create({
        id, mangaId: req.mangaId, ownerType: req.owner.type, ownerId: req.owner.id, role: req.role, path,
        width: meta.width, height: meta.height, source: 'uploaded', parentImageId: null, gen: null, review: null,
      });
      attach(image);
      return image;
    });
  } catch (err) {
    removeFiles(store, [path]);
    throw err;
  }
}
