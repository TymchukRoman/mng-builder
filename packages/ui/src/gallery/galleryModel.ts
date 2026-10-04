import type { GalleryItem, GalleryPageResult, GallerySource } from '@manga/shared';

export const GALLERY_PAGE_SIZE = 60;

export type OwnerFilter = 'all' | 'panel' | 'character';

/** `mangaId` is '' for every manga. */
export interface GalleryFilters { mangaId: string; source: GallerySource; ownerType: OwnerFilter }

/** The server's default too: only the images the app generated. */
export const DEFAULT_GALLERY_FILTERS: GalleryFilters = { mangaId: '', source: 'generated', ownerType: 'all' };

export const SOURCE_OPTIONS: ReadonlyArray<{ value: GallerySource; label: string }> = [
  { value: 'generated', label: 'Generated' },
  { value: 'upscaled', label: 'Upscaled' },
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'all', label: 'All' },
];

export const OWNER_OPTIONS: ReadonlyArray<{ value: OwnerFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'panel', label: 'Panels' },
  { value: 'character', label: 'Characters' },
];

/** The query string of GET /api/gallery for these filters; defaults of the server are left out. */
export function galleryQueryString(filters: GalleryFilters, before: string | null = null, limit = GALLERY_PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.mangaId !== '') params.set('mangaId', filters.mangaId);
  if (filters.ownerType !== 'all') params.set('ownerType', filters.ownerType);
  params.set('source', filters.source);
  params.set('limit', String(limit));
  if (before !== null) params.set('before', before);
  return `?${params.toString()}`;
}

/** Every gallery query shares the `['gallery']` prefix, so one invalidation (image events, a delete) refreshes them all. */
export function galleryKey(filters: GalleryFilters): readonly unknown[] {
  return ['gallery', filters.mangaId, filters.source, filters.ownerType];
}

export function sourceLabel(source: GallerySource): string {
  return SOURCE_OPTIONS.find((o) => o.value === source)?.label ?? source;
}


/** The short badge of a tile: "Ch 2 · p3", "Ch 2 · Cover", "Cover", "Aiko · portrait". */
export function ownerBadge(item: GalleryItem): string {
  const { owner } = item;
  switch (owner.kind) {
    case 'character':
      return owner.role === null ? owner.name : `${owner.name} · ${owner.role}`;
    case 'panel': {
      const chapter = owner.chapterNumber === null ? null : `Ch ${owner.chapterNumber}`;
      const where = owner.isCover ? 'Cover' : owner.pageNumber === null ? null : `p${owner.pageNumber}`;
      return [chapter, where].filter((part): part is string => part !== null).join(' · ') || 'Panel';
    }
    case 'missing':
      return 'Unknown owner';
  }
}

/** One line for alt text and the detail title: the badge, with the manga it belongs to. */
export function itemTitle(item: GalleryItem): string {
  return item.mangaTitle === '' ? ownerBadge(item) : `${item.mangaTitle} · ${ownerBadge(item)}`;
}

/** Where "Open in editor" goes, or null when the owner is gone. */
export function editorPath(item: GalleryItem): string | null {
  const { owner, image } = item;
  const manga = `/m/${encodeURIComponent(image.mangaId)}`;
  switch (owner.kind) {
    case 'character':
      return `${manga}?tab=characters`;
    case 'panel': {
      if (owner.chapterId === null) return `${manga}/cover`;
      const chapter = `${manga}/c/${encodeURIComponent(owner.chapterId)}`;
      return owner.isCover ? `${chapter}/cover` : `${chapter}?p=${encodeURIComponent(owner.pageId)}`;
    }
    case 'missing':
      return null;
  }
}

/** Every loaded page's items in order. */
export function flattenGallery(pages: readonly GalleryPageResult[] | undefined): GalleryItem[] {
  return (pages ?? []).flatMap((page) => page.items);
}

/** The count shown next to the filters: the last loaded page's total (it is the freshest). */
export function galleryTotal(pages: readonly GalleryPageResult[] | undefined): number | null {
  const last = pages?.[pages.length - 1];
  return last === undefined ? null : last.total;
}

export function describeEmpty(filters: GalleryFilters): string {
  const filtered = filters.mangaId !== '' || filters.ownerType !== 'all' || filters.source !== 'generated';
  return filtered ? 'No images match these filters' : 'No generated images yet';
}

/** "27 Sep 2026, 14:05" in the viewer's locale and time zone; the raw text if it is not a date. */
export function formatCreated(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "832 × 1216". */
export function sizeLabel(width: number, height: number): string {
  return `${width} × ${height}`;
}

