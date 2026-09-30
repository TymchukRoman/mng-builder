import { describe, expect, it, vi } from 'vitest';
import { StartEpisodeSchema } from '@manga/shared';
import { ApiError } from '../src/api';
import { EMPTY_AI_INPUT, clampPages, makeStart, parsePages, toStartEpisode, toggleId } from '../src/chapter/aiSection';

describe('AI section model', () => {
  it('starts nothing while closed or without a prompt', () => {
    expect(toStartEpisode(EMPTY_AI_INPUT)).toBeNull();
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: '   ' })).toBeNull();
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: false, prompt: 'A cat' })).toBeNull();
  });

  it('builds the StartEpisode body', () => {
    expect(toStartEpisode({ open: true, prompt: '  A cat in the rain ', pages: 3, tone: ' gentle ', characterIds: ['cr_a'], autopilot: true })).toEqual({
      input: { prompt: 'A cat in the rain', pages: 3, tone: 'gentle', characterIds: ['cr_a'] }, mode: 'autopilot',
    });
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: 'x' })?.mode).toBe('review');
  });

  it('builds a body the server route accepts, even from out-of-range pages', () => {
    const body = toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: 'x', pages: 99 });
    expect(StartEpisodeSchema.parse(body).input.pages).toBe(30);
    expect(StartEpisodeSchema.parse(toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: 'x' }))).toEqual({
      input: { prompt: 'x', pages: 8, tone: '', characterIds: [], previewFirst: true }, mode: 'review',
    });
  });

  it('keeps pages within 1..30 and toggles characters', () => {
    expect([clampPages(0), clampPages(31), clampPages(Number.NaN), clampPages(4.6)]).toEqual([1, 30, 8, 5]);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('reads typed pages: a cleared or unreadable field means the default, not 1', () => {
    expect([parsePages(''), parsePages('  '), parsePages('abc'), parsePages('12'), parsePages('0'), parsePages('7,4')]).toEqual([8, 8, 8, 12, 1, 7]);
  });

  describe('makeStart', () => {
    const filled = { ...EMPTY_AI_INPUT, open: true, prompt: ' A cat ', pages: 3, tone: 'soft', characterIds: ['cr_a'], autopilot: true };

    it('registers nothing while closed or without a prompt', () => {
      const post = vi.fn();
      expect(makeStart(EMPTY_AI_INPUT, post)).toBeNull();
      expect(makeStart({ ...filled, open: false }, post)).toBeNull();
      expect(makeStart({ ...filled, prompt: '  ' }, post)).toBeNull();
      expect(post).not.toHaveBeenCalled();
    });

    it('posts the exact body to the chapter episode path', async () => {
      const post = vi.fn(async () => ({}));
      const start = makeStart(filled, post);
      await start?.('ch_abc');
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith('/api/chapters/ch_abc/episode', {
        input: { prompt: 'A cat', pages: 3, tone: 'soft', characterIds: ['cr_a'] }, mode: 'autopilot',
      });
    });

    it('encodes the id as one path segment', async () => {
      const post = vi.fn(async (_path: string, _body: unknown) => ({}));
      await makeStart(filled, post)?.('ch_a/../b?x');
      expect(post.mock.calls[0]?.[0]).toBe('/api/chapters/ch_a%2F..%2Fb%3Fx/episode');
    });

    it('sends nothing for an invalid id: seg throws', async () => {
      const post = vi.fn(async () => ({}));
      await expect(makeStart(filled, post)?.('..')).rejects.toBeInstanceOf(ApiError);
      await expect(makeStart(filled, post)?.('')).rejects.toBeInstanceOf(ApiError);
      expect(post).not.toHaveBeenCalled();
    });

    it('lets a failing post reject, so the create flow can toast it', async () => {
      const post = vi.fn(async () => { throw new Error('boom'); });
      await expect(makeStart(filled, post)?.('ch_1')).rejects.toThrow('boom');
    });
  });
});
