import { describe, expect, it } from 'vitest';
import { StartAutoMangaSchema, type AutoRun } from '@manga/shared';
import { EMPTY_AUTO_DRAFT, clampCount, parseChapters, parsePagesPerChapter, resizeChapterModels, toAutoInput } from '../src/mangas/autoManga';
import { runStatusText, showsRun, stageSteps } from '../src/manga/autoRun';

const shared = { title: ' ', language: 'uk', colorMode: 'bw', direction: 'rtl', preset: 'manga-bw' } as const;
const run = (over: Partial<AutoRun> = {}): AutoRun => ({
  id: 'ar_1', mangaId: 'mg_1', input: {} as AutoRun['input'], status: 'running', stage: 'plan', plan: null, chapterIds: [], currentChapter: 0,
  error: null, createdAt: '', updatedAt: '', ...over,
});

describe('auto manga form model', () => {
  it('builds nothing without a brief, and a body the server accepts with one', () => {
    expect(toAutoInput(EMPTY_AUTO_DRAFT, shared)).toBeNull();
    expect(toAutoInput({ ...EMPTY_AUTO_DRAFT, brief: '   ' }, shared)).toBeNull();
    const body = toAutoInput({ ...EMPTY_AUTO_DRAFT, brief: ' A cat. Simple art. ', chapters: 2, pages: 5, imageModel: 'flux2', chapterModels: [null, 'anima', 'qwen'] }, shared);
    expect(body).toEqual({
      input: {
        brief: 'A cat. Simple art.', chapters: 2, pagesPerChapter: 5, title: '', language: 'uk', colorMode: 'bw', readingDirection: 'rtl',
        stylePreset: 'manga-bw', imageModel: 'flux2', chapterModels: [null, 'anima'], poster: true,
      },
    });
    expect(StartAutoMangaSchema.parse(body).input.chapterModels).toEqual([null, 'anima']);
  });

  it('keeps chapter models when the count changes', () => {
    expect(resizeChapterModels(['flux2', null], 4)).toEqual(['flux2', null, null, null]);
    expect(resizeChapterModels(['flux2', 'anima', 'qwen'], 2)).toEqual(['flux2', 'anima']);
  });

  it('reads half-typed counts', () => {
    expect([parseChapters(''), parseChapters('0'), parseChapters('99'), parseChapters('4')]).toEqual([3, 1, 20, 4]);
    expect([parsePagesPerChapter('abc'), parsePagesPerChapter('45'), parsePagesPerChapter('6,4')]).toEqual([8, 30, 6]);
    expect(clampCount('2.6', 5, 1)).toBe(3);
  });
});

describe('auto run view', () => {
  it('says what the run is doing', () => {
    expect(runStatusText(run())).toBe('Planning the series…');
    expect(runStatusText(run({ stage: 'portraits' }))).toBe('Drawing character portraits…');
    expect(runStatusText(run({ stage: 'chapters', currentChapter: 1, chapterIds: ['a', 'b', 'c'], plan: { chapters: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] } as AutoRun['plan'] })))
      .toBe('Writing chapter 2 of 3: B…');
    expect(runStatusText(run({ status: 'failed', error: 'boom' }))).toBe('Stopped: boom');
    expect(runStatusText(run({ status: 'cancelled' }))).toBe('Stopped');
    expect(runStatusText(run({ status: 'done', error: 'No poster: x' }))).toBe('Made, with a note: No poster: x');
  });

  it('marks the stages', () => {
    expect(stageSteps(run({ stage: 'poster' })).map((s) => s.state)).toEqual(['done', 'done', 'now', 'later']);
    expect(stageSteps(run({ stage: 'chapters', status: 'failed' })).map((s) => s.state)).toEqual(['done', 'done', 'done', 'stopped']);
    expect(stageSteps(run({ stage: 'done', status: 'done' })).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('shows a run until it finished cleanly', () => {
    expect([showsRun(null), showsRun(run()), showsRun(run({ status: 'failed' })), showsRun(run({ status: 'done' })), showsRun(run({ status: 'done', error: 'n' }))])
      .toEqual([false, true, true, false, true]);
  });
});
