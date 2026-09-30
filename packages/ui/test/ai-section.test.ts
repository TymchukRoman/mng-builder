import { describe, expect, it } from 'vitest';
import { StartEpisodeSchema } from '@manga/shared';
import { EMPTY_AI_INPUT, clampPages, parsePages, toStartEpisode, toggleId } from '../src/chapter/aiSection';

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
      input: { prompt: 'x', pages: 8, tone: '', characterIds: [] }, mode: 'review',
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
});
