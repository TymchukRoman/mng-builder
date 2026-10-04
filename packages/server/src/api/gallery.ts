import type { FastifyInstance } from 'fastify';
import { GalleryQuerySchema, type GalleryItem, type GalleryOwner, type GalleryPageResult, type Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { chapterPages } from '../domain/order.js';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import type { ImageCursor } from '../store/types.js';

/** The cursor is `createdAt|rowid` in base64url: the keyset position of the last item of the previous page. */
export function encodeGalleryCursor(cursor: ImageCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.rowid}`, 'utf8').toString('base64url');
}

export function decodeGalleryCursor(text: string): ImageCursor {
  const raw = Buffer.from(text, 'base64url').toString('utf8');
  const cut = raw.lastIndexOf('|');
  const rowid = Number(raw.slice(cut + 1));
  if (cut <= 0 || !Number.isInteger(rowid) || rowid < 0) throw new ValidationError('invalid gallery cursor');
  return { createdAt: raw.slice(0, cut), rowid };
}

function resolveOwner(store: Store, image: Image): { owner: GalleryOwner; active: boolean } {
  if (image.ownerType === 'character') {
    const character = store.characters.get(image.ownerId);
    if (character === null) return { owner: { kind: 'missing' }, active: false };
    return {
      owner: { kind: 'character', characterId: character.id, name: character.name, role: image.role },
      active: Object.values(character.refs).includes(image.id),
    };
  }
  const panel = store.panels.get(image.ownerId);
  const page = panel === null ? null : store.pages.get(panel.pageId);
  if (panel === null || page === null) return { owner: { kind: 'missing' }, active: false };
  const chapter = page.chapterId === null ? null : store.chapters.get(page.chapterId);
  const isCover = page.kind === 'cover';
  const index = isCover || chapter === null ? -1 : chapterPages(store, chapter.id).findIndex((p) => p.id === page.id);
  return {
    owner: {
      kind: 'panel', panelId: panel.id, pageId: page.id, chapterId: chapter?.id ?? null,
      chapterNumber: chapter?.number ?? null, chapterTitle: chapter?.title ?? null,
      pageNumber: index >= 0 ? index + 1 : null, isCover,
    },
    active: panel.activeImageId === image.id,
  };
}

export function registerGalleryRoutes(app: FastifyInstance, { store }: CoreDeps): void {
  /** Every image that still has a row (deleting removes it), newest first; `before` is the previous page's `nextBefore`. */
  app.get('/api/gallery', async (req): Promise<GalleryPageResult> => {
    const query = GalleryQuerySchema.parse(req.query ?? {});
    const filter = {
      ...(query.mangaId === undefined ? {} : { mangaId: query.mangaId }),
      ...(query.ownerType === undefined ? {} : { ownerType: query.ownerType }),
      ...(query.source === 'all' ? {} : { source: query.source }),
    };
    const before = query.before === undefined ? undefined : decodeGalleryCursor(query.before);
    const rows = store.images.listPage({ ...filter, limit: query.limit + 1, ...(before === undefined ? {} : { before }) });
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const titles = new Map<string, string>();
    const mangaTitle = (id: string): string => {
      let title = titles.get(id);
      if (title === undefined) {
        title = store.mangas.get(id)?.title ?? '';
        titles.set(id, title);
      }
      return title;
    };
    const items = page.map(({ image }): GalleryItem => ({ image, mangaTitle: mangaTitle(image.mangaId), ...resolveOwner(store, image) }));
    const last = page[page.length - 1];
    return {
      items,
      nextBefore: more && last !== undefined ? encodeGalleryCursor({ createdAt: last.image.createdAt, rowid: last.rowid }) : null,
      total: store.images.count(filter),
    };
  });
}
