import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { dismissToast, errorText, pushToast, toastStore } from '../src/ui/toasts';

afterEach(() => { toastStore.set([]); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('toasts', () => {
  it('keeps at most four toasts, newest last', () => {
    for (let i = 0; i < 6; i++) pushToast('error', `e${i}`);
    expect(toastStore.get().map((t) => t.text)).toEqual(['e2', 'e3', 'e4', 'e5']);
  });
  it('dismisses by id and expires after the ttl', () => {
    vi.useFakeTimers();
    const a = pushToast('info', 'a', 1000);
    pushToast('info', 'b', 5000);
    dismissToast(a);
    expect(toastStore.get().map((t) => t.text)).toEqual(['b']);
    vi.advanceTimersByTime(5000);
    expect(toastStore.get()).toEqual([]);
  });
  it('cancels the pending ttl timer on a manual dismiss', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const a = pushToast('info', 'a', 1000);
    dismissToast(a);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // The (now cleared) timer never fires a second, harmless removal of an id that is already gone.
    const setSpy = vi.spyOn(toastStore, 'set');
    vi.advanceTimersByTime(1000);
    expect(setSpy).not.toHaveBeenCalled();
  });
  it('renders errors as readable text', () => {
    expect(errorText(new ApiError(409, 'conflict', 'Already exists'))).toBe('Already exists');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });
});
