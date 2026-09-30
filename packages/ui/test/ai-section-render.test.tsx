import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateChapterAiSection } from '../src/chapter/CreateChapterAiSection';

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
});
