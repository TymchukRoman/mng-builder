import { describe, expect, it } from 'vitest';
import { StartAutoMangaSchema, type AutoRun } from '@manga/shared';
import { EMPTY_AUTO_DRAFT, clampCount, parseChapters, parsePagesPerChapter, resizeChapterModels, toAutoInput } from '../src/mangas/autoManga';
import { directiveRows, directiveSummary, runStatusText, showsRun, stageSteps } from '../src/manga/autoRun';

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

describe('the details a run understood', () => {
  const d = (id: string, over: Record<string, unknown> = {}) => ({ id, text: `Detail ${id}.`, kind: 'plot', chapters: [], must: true, quote: '', sources: [], tags: '', ...over });
  const withPlan = (directives: unknown[]): AutoRun => run({ plan: { directives } as unknown as AutoRun['plan'] });

  it('has no rows before the plan, and one row per directive after it', () => {
    expect(directiveRows(run())).toEqual([]);
    const rows = directiveRows(withPlan([
      d('D1', { status: 'applied' }), d('D2', { status: 'unmet', note: 'No scarf', chapters: [2, 3], kind: 'character' }), d('D3', { must: false }), d('D4'),
    ]));
    expect(rows.map((r) => [r.id, r.state, r.where, r.note])).toEqual([
      ['D1', 'applied', 'all chapters', ''], ['D2', 'unmet', 'ch. 2, 3', 'No scarf'], ['D3', 'wish', 'all chapters', ''], ['D4', 'unchecked', 'all chapters', ''],
    ]);
    expect(rows[1]).toMatchObject({ kind: 'character', text: 'Detail D2.' });
  });

  it('summarises them, counting what is not fully applied', () => {
    expect(directiveSummary(directiveRows(withPlan([d('D1', { status: 'applied' })])))).toBe('1 detail understood');
    expect(directiveSummary(directiveRows(withPlan([d('D1', { status: 'unmet' }), d('D2', { status: 'partial' }), d('D3', { status: 'applied' })])))).toBe('3 details understood, 2 not fully applied');
  });
});
