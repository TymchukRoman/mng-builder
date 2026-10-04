import { useMemo, useState, type JSX } from 'react';
import type { GalleryItem } from '@manga/shared';
import { sortMangas } from '../mangas/mangaList';
import { useMangas } from '../queries';
import { ChevronDown } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Segmented } from '../ui/Segmented';
import { StatusLoader } from '../ui/StatusLoader';
import { GalleryDetail } from './GalleryDetail';
import { GalleryEmpty, GalleryTile } from './GalleryTile';
import {
  DEFAULT_GALLERY_FILTERS, OWNER_OPTIONS, SOURCE_OPTIONS, describeEmpty, flattenGallery, galleryTotal, type GalleryFilters,
} from './galleryModel';
import { useGallery } from './useGallery';
import './gallery.css';

/** Every image that was generated and not deleted, newest first, filterable by manga, source and owner. */
export function GalleryPage(): JSX.Element {
  const [filters, setFilters] = useState<GalleryFilters>(DEFAULT_GALLERY_FILTERS);
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const mangas = useMangas();
  const gallery = useGallery(filters);
  const items = useMemo(() => flattenGallery(gallery.data?.pages), [gallery.data]);
  const total = galleryTotal(gallery.data?.pages);
  const set = (patch: Partial<GalleryFilters>): void => setFilters((f) => ({ ...f, ...patch }));
  return (
    <section className="screen" aria-label="Gallery">
      <div className="gallery-filters">
        <Field label="Manga">
          <select className="select" value={filters.mangaId} onChange={(e) => set({ mangaId: e.target.value })}>
            <option value="">All manga</option>
            {sortMangas(mangas.data).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </Field>
        <Field label="Source" group>
          <Segmented label="Source" value={filters.source} options={[...SOURCE_OPTIONS]} onChange={(source) => set({ source })} />
        </Field>
        <Field label="Shows" group>
          <Segmented label="Image owner" value={filters.ownerType} options={[...OWNER_OPTIONS]} onChange={(ownerType) => set({ ownerType })} />
        </Field>
        {total !== null && <span className="gallery-count muted" aria-live="polite">{total === 1 ? '1 image' : `${total} images`}</span>}
      </div>
      {gallery.isPending && <StatusLoader label="Loading images" />}
      {gallery.error && <ErrorState error={gallery.error} onRetry={() => void gallery.refetch()} retrying={gallery.isFetching} />}
      {gallery.data && items.length === 0 && <GalleryEmpty text={describeEmpty(filters)} />}
      {items.length > 0 && (
        <ul className="gallery-grid" aria-label="Images">
          {items.map((item) => <GalleryTile key={item.image.id} item={item} onOpen={setSelected} />)}
        </ul>
      )}
      {gallery.hasNextPage && (
        <div className="gallery-more">
          <IconButton icon={ChevronDown} label="Load more" tipSide="top" busy={gallery.isFetchingNextPage} onClick={() => void gallery.fetchNextPage()} />
          <span className="muted">{items.length} of {total ?? items.length}</span>
        </div>
      )}
      <GalleryDetail
        item={selected === null ? null : items.find((i) => i.image.id === selected.image.id) ?? null}
        onClose={() => setSelected(null)}
      />
    </section>
  );
}
