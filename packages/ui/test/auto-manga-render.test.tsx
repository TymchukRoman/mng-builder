import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AutoRun } from '@manga/shared';
import { AutoRunPanel } from '../src/manga/AutoRunPanel';
import { EMPTY_AUTO_DRAFT } from '../src/mangas/autoManga';
import { AutoBrief, AutoMangaFields } from '../src/mangas/AutoMangaFields';
import { qk } from '../src/queryKeys';
import { ImageModelSelect } from '../src/ui/ImageModelSelect';
import { makeManga } from './fixtures';

const client = (): QueryClient => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
const wrap = (qc: QueryClient, node: JSX.Element): string => renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);

describe('ImageModelSelect', () => {
  it('lists the presets after the inherit choice and explains the chosen one', () => {
    const html = renderToStaticMarkup(<ImageModelSelect label="Image model" value="anima" inheritLabel="Same as the manga" onChange={vi.fn()} />);
    expect(html).toContain('aria-label="Image model"');
    expect(html).toContain('<option value="">Same as the manga</option>');
    for (const id of ['sdxl', 'flux2', 'qwen', 'anima', 'anima-turbo']) expect(html).toContain(`value="${id}"`);
    expect(html).toMatch(/<option value="anima" selected/);
    expect(html).toContain('field__hint');
    expect(renderToStaticMarkup(<ImageModelSelect label="m" value={null} inheritLabel="x" onChange={vi.fn()} />)).not.toContain('field__hint');
  });
});

describe('auto manga fields', () => {
  it('shows the brief box labelled as plot and notes', () => {
    const html = renderToStaticMarkup(<AutoBrief value={EMPTY_AUTO_DRAFT} set={vi.fn()} />);
    expect(html).toContain('aria-label="Plot and notes"');
    expect(html).toContain('simplistic art style');
  });

  it('shows the size, the models, the poster toggle and the estimate for the whole manga', () => {
    const qc = client();
    qc.setQueryData(qk.settings(), DEFAULT_SETTINGS);
    const html = wrap(qc, <AutoMangaFields value={{ ...EMPTY_AUTO_DRAFT, chapters: 2, pages: 1, chapterModels: [null, 'anima'] }} set={vi.fn()} colorMode="bw" />);
    expect(html).toContain('aria-label="Image model of chapter 2"');
    expect(html).toMatch(/aria-label="Draw a poster for the manga"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-testid="auto-estimate"[^>]*>2 chapters × 1 page ≈ \d+ panels/);
  });

  it('has no per-chapter models for a single chapter and no estimate before the settings load', () => {
    const html = wrap(client(), <AutoMangaFields value={{ ...EMPTY_AUTO_DRAFT, chapters: 1, chapterModels: [null] }} set={vi.fn()} colorMode="bw" />);
    expect(html).not.toContain('Image model per chapter');
    expect(html).not.toContain('auto-estimate');
  });
});

describe('AutoRunPanel', () => {
  const manga = makeManga({ id: 'mg_1' });
  const run: AutoRun = {
    id: 'ar_1', mangaId: 'mg_1', input: {} as AutoRun['input'], status: 'running', stage: 'chapters', plan: null, chapterIds: ['ch_a', 'ch_b'],
    currentChapter: 1, error: null, createdAt: '', updatedAt: '',
  };
  const render = (value: AutoRun | null): string => {
    const qc = client();
    qc.setQueryData(qk.autoRun('mg_1'), value);
    return wrap(qc, <AutoRunPanel manga={manga} />);
  };

  it('shows the current chapter, a link to it and Cancel while running', () => {
    const html = render(run);
    expect(html).toContain('Writing chapter 2 of 2…');
    expect(html).toContain('href="/m/mg_1/c/ch_b"');
    expect(html).toContain('aria-label="Cancel auto creation"');
    expect(html).toMatch(/auto-run__step--now[^>]*aria-current="step"[^>]*>Chapters/);
  });

  it('offers Continue after a failure and shows the reason', () => {
    const html = render({ ...run, status: 'failed', error: 'Chapter 2 failed' });
    expect(html).toContain('Stopped: Chapter 2 failed');
    expect(html).toContain('aria-label="Continue auto creation"');
    expect(html).not.toContain('Cancel auto creation');
  });

  it('lists what was understood, with what is unmet and why', () => {
    const d = (id: string, over: Record<string, unknown>) => ({ id, text: `Detail ${id}.`, kind: 'plot', chapters: [], must: true, quote: '', sources: [], tags: '', ...over });
    const html = render({ ...run, plan: { chapters: [], directives: [d('D1', { status: 'applied' }), d('D2', { status: 'unmet', note: 'The scarf is missing', kind: 'character', chapters: [2] })] } as unknown as AutoRun['plan'] });
    expect(html).toContain('2 details understood, 1 not fully applied');
    expect(html).toContain('auto-run__directive--applied');
    expect(html).toContain('auto-run__directive--unmet');
    expect(html).toContain('The scarf is missing');
    expect(html).toContain('character · ch. 2');
    expect(render(run)).not.toContain('understood');
  });

  it('renders nothing without a run or after a clean finish', () => {
    expect(render(null)).toBe('');
    expect(render({ ...run, status: 'done', stage: 'done' })).toBe('');
  });
});
