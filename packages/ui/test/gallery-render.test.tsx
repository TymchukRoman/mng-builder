import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GalleryItem } from '@manga/shared';
import { GalleryEmpty, GalleryTile } from '../src/gallery/GalleryTile';
import { makeImage } from './fixtures';

const noop = (): void => undefined;
const item = (over: Partial<GalleryItem> = {}): GalleryItem => ({
  image: makeImage('im_7'), mangaTitle: 'Oni', active: false,
  owner: { kind: 'panel', panelId: 'pn_1', pageId: 'pg_1', chapterId: 'ch_2', chapterNumber: 2, chapterTitle: 'Two', pageNumber: 3, isCover: false },
  ...over,
});

describe('GalleryTile', () => {
  it('shows a lazy thumbnail of the image with its badge, as one labelled button', () => {
    const html = renderToStaticMarkup(<ul><GalleryTile item={item()} onOpen={noop} /></ul>);
    expect(html).toContain('src="/files/images/im_7.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('aria-label="Open image: Oni · Ch 2 · p3"');
    expect(html).toContain('>Ch 2 · p3<');
    expect(html).not.toContain('Active image');
  });
  it('marks the active image', () => {
    const html = renderToStaticMarkup(<ul><GalleryTile item={item({ active: true })} onOpen={noop} /></ul>);
    expect(html).toContain('aria-label="Active image"');
    expect(html).toContain('is-active');
  });
});

describe('GalleryEmpty', () => {
  it('says why there is nothing to show', () => {
    const html = renderToStaticMarkup(<GalleryEmpty text="No generated images yet" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('No generated images yet');
  });
});
