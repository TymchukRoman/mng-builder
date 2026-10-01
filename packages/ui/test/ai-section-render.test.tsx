import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Character } from '@manga/shared';
import { EMPTY_AI_INPUT, type AiChapterInput } from '../src/chapter/aiSection';
import { AiSectionBody, CreateChapterAiSection } from '../src/chapter/CreateChapterAiSection';
import { qk } from '../src/queryKeys';

/** The open section's body (its open state is internal to CreateChapterAiSection), rendered from cached settings without a DOM. */
function renderOpen(patch: Partial<AiChapterInput> = {}, settings: typeof DEFAULT_SETTINGS | null = DEFAULT_SETTINGS): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (settings) qc.setQueryData(qk.settings(), settings);
  qc.setQueryData<Character[]>(qk.characters('mg_1'), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><AiSectionBody mangaId="mg_1" value={{ ...EMPTY_AI_INPUT, open: true, ...patch }} set={vi.fn()} /></QueryClientProvider>,
  );
}

describe('Generate with AI section', () => {
  it('starts collapsed as one icon toggle named "Generate with AI", with no visible text and no field', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}><CreateChapterAiSection mangaId="mg_1" onChange={vi.fn()} /></QueryClientProvider>,
    );
    const toggle = html.match(/<button[^>]*aria-label="Generate with AI"[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('data-tip="Generate with AI"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="ai-section"');
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
  });

  it('shows the preview toggle (on) and the chapter estimate (W1 Q2, C2)', () => {
    const html = renderOpen();
    const toggle = html.match(/<button[^>]*aria-label="Preview page 1 first"[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('aria-pressed="true"');
    expect(toggle).toContain('data-tip="Preview page 1 first"');
    expect(html).toContain('8 pages ≈ 36 panels ≈ 37 min');
    expect(html).toMatch(/data-testid="ai-estimate"[^>]*>8 pages/);
  });

  it('the preview toggle follows the input; the estimate follows the pages and waits for the settings', () => {
    expect(renderOpen({ previewFirst: false })).toMatch(/aria-label="Preview page 1 first"[^>]*aria-pressed="false"/);
    expect(renderOpen({ pages: 1 })).toContain('1 page ≈ ');
    expect(renderOpen({}, null)).not.toContain('data-testid="ai-estimate"');
  });
});
