import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateChapterAiSection } from '../src/chapter/CreateChapterAiSection';

describe('Generate with AI section', () => {
  it('starts collapsed and takes no focus: only the toggle renders, with no autofocus hook', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}><CreateChapterAiSection mangaId="mg_1" onChange={vi.fn()} /></QueryClientProvider>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Generate with AI');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('data-autofocus');
  });
});
