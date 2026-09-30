import { describe, expect, it } from 'vitest';
import type { Job } from '@manga/shared';
import { defaultScope, exportFiles, exportProblem, exportRequest, fileName } from '../src/editor/exportView';

const chapter = { type: 'chapter' as const, id: 'ch_1' };
const cover = { type: 'page' as const, id: 'pg_cover' };

describe('export view', () => {
  it('defaults to the whole chapter in the chapter editor and to the page in the cover editor', () => {
    expect(defaultScope(chapter)).toBe('chapter');
    expect(defaultScope(cover)).toBe('page');
    expect(defaultScope(null)).toBe('page');
  });

  it('builds the POST /api/export body for the chosen scope', () => {
    expect(exportRequest({ scope: 'chapter', format: 'pdf' }, chapter, 'pg_3')).toEqual({ target: chapter, format: 'pdf' });
    expect(exportRequest({ scope: 'page', format: 'png' }, chapter, 'pg_3')).toEqual({ target: { type: 'page', id: 'pg_3' }, format: 'png' });
    expect(exportRequest({ scope: 'page', format: 'pdf' }, cover, null)).toEqual({ target: cover, format: 'pdf' });
    expect(exportRequest({ scope: 'page', format: 'pdf' }, chapter, null)).toBeNull();
    expect(exportRequest({ scope: 'chapter', format: 'pdf' }, cover, 'pg_cover')).toBeNull();
  });

  it('lists the files of a finished export', () => {
    const win = 'C:\\lib\\exports\\a\\01-x\\page-01.pdf';
    const job = { status: 'succeeded', result: { files: [win, '/tmp/x/chapter.pdf'] } } as unknown as Job;
    expect(exportFiles(job)).toEqual([win, '/tmp/x/chapter.pdf']);
    expect(exportFiles({ ...job, status: 'failed' })).toEqual([]);
    expect(exportFiles(undefined)).toEqual([]);
    expect(exportFiles(null)).toEqual([]);
    expect(exportFiles({ ...job, result: null })).toEqual([]);
    expect(exportFiles(job).map(fileName)).toEqual(['page-01.pdf', 'chapter.pdf']);
  });

  it('says why a finished export produced nothing', () => {
    const job = (status: string, error: string | null = null): Job => ({ status, error, result: null }) as unknown as Job;
    expect(exportProblem(job('failed', 'The UI is not built'))).toBe('The UI is not built');
    expect(exportProblem(job('failed'))).toBe('Export failed');
    expect(exportProblem(job('cancelled'))).toBe('Export cancelled');
    expect(exportProblem(job('succeeded'))).toBeNull();
    expect(exportProblem(null)).toBeNull();
  });
});
