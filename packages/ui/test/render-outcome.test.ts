import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT } from '@manga/shared';
import { pageSizePx } from '../src/page/geometry';
import { renderPageSize, renderSize } from '../src/page/pageModel';
import { renderOutcome } from '../src/render/renderOutcome';

describe('renderOutcome', () => {
  it('is ready when there are no images or all of them decoded', () => {
    expect(renderOutcome([])).toEqual({ ready: true });
    expect(renderOutcome([{ label: 'pn_a', ok: true }, { label: 'pn_b', ok: true }])).toEqual({ ready: true });
  });

  it('is not ready, and names every panel whose image failed', () => {
    expect(renderOutcome([{ label: 'pn_a', ok: true }, { label: 'pn_b', ok: false }])).toEqual({
      ready: false, error: 'Could not decode the image of pn_b',
    });
    const out = renderOutcome([{ label: 'pn_a', ok: false }, { label: 'pn_b', ok: false }]);
    expect(out).toEqual({ ready: false, error: 'Could not decode the image of pn_a, pn_b' });
  });
});

describe('renderPageSize', () => {
  it('gives the root exactly the height PageView derives from the width, at every scale', () => {
    for (const scale of ['0.5', '1', '1.5', '2', '4']) {
      const root = renderPageSize(DEFAULT_PAGE_FORMAT, scale);
      const width = renderSize(DEFAULT_PAGE_FORMAT, scale).w;
      expect(root.w).toBe(width);
      expect(root.h).toBe(pageSizePx(DEFAULT_PAGE_FORMAT, width).h);
    }
  });

  it('is the print size at the default scale', () => {
    expect(renderPageSize(DEFAULT_PAGE_FORMAT, null)).toEqual({ w: 2150, h: 3035 });
  });
});
