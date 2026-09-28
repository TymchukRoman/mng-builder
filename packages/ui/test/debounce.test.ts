import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../src/lib/debounce';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('debounce', () => {
  it('calls once with the last arguments after the quiet period', () => {
    const fn = vi.fn();
    const d = debounce(fn, 300);
    d('a'); d('b'); vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    d('c'); vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });
  it('flush runs a pending call immediately; cancel drops it', () => {
    const fn = vi.fn();
    const d = debounce(fn, 300);
    d(1);
    expect(d.pending()).toBe(true);
    d.flush();
    expect(fn).toHaveBeenCalledWith(1);
    expect(d.pending()).toBe(false);
    d(2); d.cancel(); vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('flush with nothing pending does nothing', () => {
    const fn = vi.fn();
    debounce(fn, 300).flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
