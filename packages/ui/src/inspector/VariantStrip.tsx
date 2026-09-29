import type { JSX } from 'react';
import type { Image } from '@manga/shared';
import { imageUrl } from '../api';
import { cx } from '../lib/cx';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { visibleVariants } from './inspectorModel';
import { ReviewBadge } from './ReviewBadge';

/** `filter` is the page's display filter for the manga's colour mode (panelImageFilter), so a thumbnail looks like the panel. */
export function VariantStrip({ images, activeId, filter, onActivate, onDelete }: {
  images: readonly Image[]; activeId: string | null; filter: string | undefined; onActivate(imageId: string): void; onDelete(imageId: string): void;
}): JSX.Element {
  const variants = visibleVariants(images);
  if (variants.length === 0) return <p className="muted">No images yet</p>;
  return (
    <div className="variant-strip">
      {variants.map((img) => {
        const active = img.id === activeId;
        return (
          <div key={img.id} className={cx('variant-strip__item', active && 'is-active')}>
            <button type="button" className="variant-strip__pick" data-variant-id={img.id} aria-pressed={active}
              aria-label={active ? 'Active image' : 'Use this image'} data-tip={active ? 'Active image' : 'Use this image'}
              onClick={() => { if (!active) onActivate(img.id); }}>
              <img src={imageUrl(img.id)} alt="" style={filter === undefined ? undefined : { filter }} />
            </button>
            {img.review && <span className="variant-strip__review"><ReviewBadge review={img.review} /></span>}
            <ConfirmIconButton size="sm" className="variant-strip__delete" label="Delete image" confirmLabel="Click again to delete" onConfirm={() => onDelete(img.id)} />
          </div>
        );
      })}
    </div>
  );
}
