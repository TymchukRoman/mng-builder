import type { Image } from '@manga/shared';
import type { Store } from '../store/index.js';

export type NewImageRow = Omit<Image, 'id' | 'createdAt'>;

/** Inserts an Image row under an id chosen by the caller (the PNG is written to <id>.png first). */
export function createImageWithId(store: Store, id: string, row: NewImageRow): Image {
  const created = store.images.create({ ...row, id });
  if (created.id !== id) throw new Error(`images.create ignored the explicit id ${id} (got ${created.id}); see M2 Task 1`);
  return created;
}
