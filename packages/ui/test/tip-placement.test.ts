import { describe, expect, it } from 'vitest';
import { placePopover, placeTip } from '../src/ui/tipPlacement';

const vp = { width: 1000, height: 800 };
const anchor = { left: 480, top: 100, width: 40, height: 28 };

describe('placeTip', () => {
  it('centres below the anchor by default', () => {
    expect(placeTip(anchor, { width: 100, height: 24 }, vp, 'bottom')).toEqual({ x: 450, y: 134, side: 'bottom' });
  });
  it('flips to the top when the bottom has no room', () => {
    const low = { left: 480, top: 780, width: 40, height: 16 };
    expect(placeTip(low, { width: 100, height: 24 }, vp, 'bottom').side).toBe('top');
  });
  it('clamps horizontally inside the viewport', () => {
    const edge = { left: 0, top: 100, width: 20, height: 20 };
    expect(placeTip(edge, { width: 100, height: 24 }, vp, 'bottom').x).toBe(4);
  });
  it('honours a right preference when there is room', () => {
    expect(placeTip(anchor, { width: 100, height: 24 }, vp, 'right')).toEqual({ x: 526, y: 102, side: 'right' });
  });
});

describe('placePopover', () => {
  it('opens below and start-aligned', () => {
    expect(placePopover(anchor, { width: 200, height: 100 }, vp, 'start')).toEqual({ x: 480, y: 132 });
  });
  it('end-aligns to the anchor right edge', () => {
    expect(placePopover(anchor, { width: 200, height: 100 }, vp, 'end')).toEqual({ x: 320, y: 132 });
  });
  it('opens above when there is no room below', () => {
    const low = { left: 100, top: 740, width: 40, height: 28 };
    expect(placePopover(low, { width: 200, height: 100 }, vp, 'start')).toEqual({ x: 100, y: 636 });
  });
});
