import { describe, expect, it, vi } from 'vitest';
import { createChapterFlow, startFailureMessage } from '../src/chapter/createChapterFlow';

const chapter = { id: 'ch_1' };

describe('create chapter flow', () => {
  it('posts once, starts the episode and reports no error', async () => {
    const post = vi.fn(async () => chapter);
    const start = vi.fn(async () => undefined);
    const onStartError = vi.fn();
    await expect(createChapterFlow({ post, start, onStartError })).resolves.toBe(chapter);
    expect(post).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('ch_1');
    expect(onStartError).not.toHaveBeenCalled();
  });
  it('creates a plain chapter when there is no episode to start', async () => {
    const post = vi.fn(async () => chapter);
    await expect(createChapterFlow({ post, start: null, onStartError: vi.fn() })).resolves.toBe(chapter);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('still returns the chapter when the episode fails to start, and reports the error once', async () => {
    const post = vi.fn(async () => chapter);
    const boom = new Error('claude offline');
    const onStartError = vi.fn();
    await expect(createChapterFlow({ post, start: async () => { throw boom; }, onStartError })).resolves.toBe(chapter);
    expect(post).toHaveBeenCalledTimes(1);
    expect(onStartError).toHaveBeenCalledExactlyOnceWith(boom);
  });
  it('lets a failed POST reject, without starting anything', async () => {
    const start = vi.fn(async () => undefined);
    await expect(createChapterFlow({ post: async () => { throw new Error('nope'); }, start, onStartError: vi.fn() })).rejects.toThrow('nope');
    expect(start).not.toHaveBeenCalled();
  });
  it('words the failure so it says the chapter exists', () => {
    expect(startFailureMessage(new Error('claude offline'))).toBe('Chapter created, but the episode could not start: claude offline');
  });
});
