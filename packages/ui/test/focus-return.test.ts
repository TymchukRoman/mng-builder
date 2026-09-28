import { describe, expect, it } from 'vitest';
import { openFocusTarget, shouldRestoreFocus } from '../src/ui/focusReturn';

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
