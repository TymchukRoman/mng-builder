import { describe, expect, it } from 'vitest';
import { afterSave } from '../src/lib/useAutosaveDraft';

describe('afterSave (M5: what the autosave draft does once a save settles)', () => {
  it('a saved draft is clean and follows the server again', () => {
    expect(afterSave('saved', false)).toEqual({ dirty: false, reset: false });
  });
  it('a failed save resets the draft to the stored value, so the field never looks saved when it is not', () => {
    expect(afterSave('failed', false)).toEqual({ dirty: false, reset: true });
  });
  it('a declined save keeps the draft', () => {
    expect(afterSave('declined', false)).toEqual({ dirty: true, reset: false });
  });
  it('a newer edit waiting to save keeps the draft whatever happened to the older one', () => {
    for (const outcome of ['saved', 'failed', 'declined'] as const) expect(afterSave(outcome, true)).toEqual({ dirty: true, reset: false });
  });
});
