import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { panelSelection, frameSelection, PAGE_SELECTION, type Selection } from '../src/editor/selection';
import { IdMap } from '../src/editor/history';
import { queryCache } from '../src/editor/cacheAdapter';
import { createOps } from '../src/editor/ops';
import { Inspector } from '../src/inspector/Inspector';
import { qk } from '../src/queryKeys';
import { api } from '../src/api';
import { makeDetail, makeFrame, makeImage, makeManga, makePanel } from './fixtures';

/** The accessible labels the E2E specs rely on, rendered once from a prefilled cache (no DOM in this test environment). */
function render(selection: Selection, mode: 'chapter' | 'cover' = 'chapter'): string {
  const manga = makeManga();
  const image = makeImage('im_1', { ownerId: 'pn_a' });
  const detail = { ...makeDetail('pg_1', [makeFrame('tf_1', 'pg_1', { text: 'Hello there' })]), images: { im_1: image } };
  detail.panels = [makePanel('pn_a', 'pg_1', { activeImageId: 'im_1' }), makePanel('pn_b', 'pg_1')];
  const qc = new QueryClient();
  qc.setQueryData(qk.characters(manga.id), []);
  qc.setQueryData(qk.panelImages('pn_a'), [image, makeImage('im_2', { ownerId: 'pn_a', createdAt: '2026-09-28T00:00:00.000Z' })]);
  qc.setQueryData(qk.jobs(), []);
  qc.setQueryData(qk.recipes(), []);
  const ops = createOps({ api, ids: new IdMap(), cache: queryCache(qc), format: () => manga.pageFormat });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Inspector manga={manga} detail={detail} pageNumber={2} selection={selection} onSelect={() => undefined} run={() => Promise.resolve()} ops={ops} mode={mode} />
    </QueryClientProvider>,
  );
}

describe('inspector render', () => {
  it('panel: image actions, variants, prompt and seed carry the labels the E2E uses, and thumbnails are grey in a B&W manga', () => {
    const html = render(panelSelection('pn_a'));
    for (const label of ['Generate a new variant', 'Review image (AI)', 'Upload image', 'Write the prompt with AI', 'Lock seed']) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`data-tip="${label}"`);
    }
    expect(html).toContain('data-variant-id="im_1"');
    expect(html).toContain('aria-label="Active image"');
    expect(html).toContain('aria-label="Use this image"');
    expect(html).toContain('filter:grayscale(1)');
    expect(html).toContain('accept="image/png,image/jpeg"');
  });

  it('frame: the text area and the delete button; title kind only on a cover', () => {
    const html = render(frameSelection('tf_1'));
    expect(html).toContain('Hello there');
    expect(html).toContain('aria-label="Delete frame"');
    expect(html).not.toContain('aria-label="Title"');
    expect(render(frameSelection('tf_1'), 'cover')).toContain('aria-label="Title"');
  });

  it('page: lists the text frames', () => {
    const html = render(PAGE_SELECTION);
    expect(html).toContain('Page 2');
    expect(html).toContain('Hello there');
  });
});
