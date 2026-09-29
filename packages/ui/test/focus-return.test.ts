import { describe, expect, it } from 'vitest';
import { initialFocusIndex, openFocusTarget, shouldRestoreFocus } from '../src/ui/focusReturn';

describe('openFocusTarget', () => {
  it('targets the first focusable descendant when there is one', () => {
    expect(openFocusTarget(true)).toBe('first');
  });
  it('falls back to the container itself when nothing inside is focusable', () => {
    expect(openFocusTarget(false)).toBe('self');
  });
});

describe('shouldRestoreFocus', () => {
  it('restores focus when the previous element is still in the document', () => {
    expect(shouldRestoreFocus(true)).toBe(true);
  });
  it('skips restoring focus when the previous element was removed', () => {
    expect(shouldRestoreFocus(false)).toBe(false);
  });
});

describe('initialFocusIndex (I2: a dialog opens on its first field, not on the header Close button)', () => {
  const close = { autofocus: false, inBody: false };
  const field = { autofocus: false, inBody: true };
  const marked = { autofocus: true, inBody: true };
  it('prefers the element marked data-autofocus', () => {
    expect(initialFocusIndex([close, field, marked])).toBe(2);
  });
  it('else takes the first focusable element of the body, skipping the header', () => {
    expect(initialFocusIndex([close, field, field])).toBe(1);
  });
  it('falls back to the first focusable element when the body has none', () => {
    expect(initialFocusIndex([close])).toBe(0);
  });
  it('returns -1 when nothing is focusable', () => {
    expect(initialFocusIndex([])).toBe(-1);
  });
});
