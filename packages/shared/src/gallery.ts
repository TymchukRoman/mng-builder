import { z } from 'zod';
import { IdSchema, ImageOwnerTypeSchema, type Image } from './schemas.js';

/** `all` means no source filter. */
export const GALLERY_SOURCES = ['all', 'generated', 'upscaled', 'uploaded'] as const;
export type GallerySource = (typeof GALLERY_SOURCES)[number];

/** GET /api/gallery: every image that has not been deleted, newest first, one page at a time. */
export const GalleryQuerySchema = z.object({
  mangaId: IdSchema.optional(),
  ownerType: ImageOwnerTypeSchema.optional(),
  source: z.enum(GALLERY_SOURCES).default('generated'),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  /** Opaque cursor: the previous page's `nextBefore`. */
  before: z.string().optional(),
});
export type GalleryQuery = z.infer<typeof GalleryQuerySchema>;

export type GalleryOwner =
  | { kind: 'panel'; panelId: string; pageId: string; chapterId: string | null; chapterNumber: number | null; chapterTitle: string | null; pageNumber: number | null; isCover: boolean }
  | { kind: 'character'; characterId: string; name: string; role: string | null }
  | { kind: 'missing' };

export interface GalleryItem {
  image: Image;
  mangaTitle: string;
  owner: GalleryOwner;
  /** The panel's active image, or one of the character's ref slots. */
  active: boolean;
}

export interface GalleryPageResult {
  items: GalleryItem[];
  nextBefore: string | null;
  /** Images matching the filter, ignoring `before` and `limit`. */
  total: number;
}
