import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { EpisodePanel } from '../src/chapter/EpisodePanel';
import { qk } from '../src/queryKeys';

type StepStatus = EpisodeRun['steps'][number]['status'];
function run(status: EpisodeRun['status'], currentStep: number, current: StepStatus, error: string | null = null): EpisodeRun {
  return {
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode: 'review', currentStep, status,
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < currentStep ? 'done' : i === currentStep ? current : 'pending',
      output: i < currentStep || (i === currentStep && current !== 'running' && current !== 'failed') ? { title: 'Night market', pages: 2 } : null,
      error: i === currentStep ? error : null, startedAt: null, finishedAt: null,
    })),
    createdAt: '', updatedAt: '',
  };
}

/** The panel's DOM hooks (used by the E2E specs), rendered from a cached run without a DOM or a server. */
function render(value: EpisodeRun | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.episode('ch_1'), value);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter><EpisodePanel chapterId="ch_1" /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const button = (html: string, label: string): string => {
  const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no button "${label}"`);
  return tag;
};
const enabled = (html: string, label: string): boolean => !button(html, label).includes('aria-disabled="true"');
/** The text of `[data-testid="episode-status"]` (a chip or a StatusLoader inside it). */
const statusText = (html: string): string =>
  (html.match(/data-testid="episode-status"[^>]*>([\s\S]*?)<\/div><span class="spacer"/)?.[1] ?? '').replace(/<[^>]+>/g, '');

describe('episode panel', () => {
  it('renders nothing while the chapter has no run', () => {
    expect(render(null)).toBe('');
  });

  it('a run waiting for review: status chip, seven step tabs and an editable output form', () => {
    const html = render(run('awaiting-review', 1, 'awaiting-review'));
    expect(html).toContain('data-testid="episode-panel"');
    expect(statusText(html)).toBe('Review: outline');
    expect(html).toMatch(/data-testid="episode-status"[^>]*><span class="status-chip status-chip--generating">/);
    expect(html.match(/role="tab"/g)).toHaveLength(7);
    expect(button(html, 'Outline: waiting for review')).toContain('aria-selected="true"');
    expect(html).toContain('data-tip="Premise: done"');
    for (const label of ['Continue', 'Run to end', 'Cancel episode', 'Re-run from here \\(later steps run again\\)', 'Edit as JSON']) {
      expect(enabled(html, label), label).toBe(true);
      expect(html).toContain(`data-tip="${label.replace(/\\/g, '')}"`);
    }
    expect(enabled(html, 'Save changes')).toBe(false); // nothing edited yet
    expect(html).toContain('aria-label="title"');
    expect(html).toContain('>Night market</textarea>');
    // A tablist owns its tabs directly, and the panel is labelled by the selected tab.
    expect(html).toMatch(/role="tablist"[^>]*><button/);
    const tab = button(html, 'Outline: waiting for review');
    const tabId = tab.match(/ id="([^"]+)"/)?.[1] ?? '';
    const panelId = tab.match(/aria-controls="([^"]+)"/)?.[1] ?? '';
    expect(html).toContain(`id="${panelId}" role="tabpanel" aria-labelledby="${tabId}"`);
    expect(html).not.toContain('readOnly');
  });

  it('a running run shows a status loader and no editing for the running step', () => {
    const html = render(run('running', 3, 'running'));
    expect(html).toMatch(/<div data-testid="episode-status"[^>]*><div role="status"/);
    expect(html).toContain('Writing the scripts');
    expect(enabled(html, 'Continue')).toBe(false);
    expect(enabled(html, 'Edit as JSON')).toBe(false);
  });

  it('a failed run shows the step error and offers a retry; the run actions are gone', () => {
    const html = render(run('failed', 5, 'failed', 'ComfyUI is not reachable'));
    expect(statusText(html)).toBe('Failed at images');
    expect(html).toContain('status-chip--failed');
    expect(html).toMatch(/data-testid="episode-step-error"[\s\S]*ComfyUI is not reachable/);
    expect(enabled(html, 'Retry this step')).toBe(true);
    expect(html).not.toContain('aria-label="Continue"');
  });

  it('a finished run shows the informational lettering output read-only', () => {
    const html = render(run('done', 6, 'done'));
    expect(statusText(html)).toBe('Chapter ready');
    expect(html).toContain('aria-label="title" readOnly=""');
    expect(enabled(html, 'Edit as JSON')).toBe(false);
  });
});
