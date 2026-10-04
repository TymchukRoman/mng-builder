import type { JSX } from 'react';
import type { GalleryItem } from '@manga/shared';
import { imageUrl } from '../api';
import { cx } from '../lib/cx';
import { CircleCheck, ImageIcon } from '../ui/icons';
import { itemTitle, ownerBadge } from './galleryModel';

/** One thumbnail: opens the detail on click. The badge says what the image is; the check marks the active one. */
export function GalleryTile({ item, onOpen }: { item: GalleryItem; onOpen(item: GalleryItem): void }): JSX.Element {
  const { image } = item;
  const badge = ownerBadge(item);
  return (
    <li className="gallery-tile-item">
      <button
        type="button" className={cx('gallery-tile', item.active && 'is-active')} aria-label={`Open image: ${itemTitle(item)}`}
        onClick={() => onOpen(item)}
      >
        <img src={imageUrl(image.id)} alt="" loading="lazy" decoding="async" width={image.width} height={image.height} />
        <span className="gallery-tile__badge">{badge}</span>
        {item.active && (
          <span className="gallery-tile__active" role="img" aria-label="Active image" data-tip="Active image"><CircleCheck size={14} aria-hidden /></span>
        )}
      </button>
    </li>
  );
}

export function GalleryEmpty({ text }: { text: string }): JSX.Element {
  return (
    <div className="gallery-empty" role="status">
      <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
      <p className="muted">{text}</p>
    </div>
  );
}
