import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { dismissToast, errorText, pushToast, toastStore } from '../src/ui/toasts';

afterEach(() => { toastStore.set([]); vi.useRealTimers(); });

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
  it('renders errors as readable text', () => {
    expect(errorText(new ApiError(409, 'conflict', 'Already exists'))).toBe('Already exists');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });
});
