import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun, type EpisodeStepName } from '@manga/shared';
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
function render(value: EpisodeRun | null, opts: { missing?: string[]; initialStep?: EpisodeStepName } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.episode('ch_1'), value);
  if (opts.missing) qc.setQueryData(qk.missingPanels('ch_1'), { panelIds: opts.missing });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter><EpisodePanel chapterId="ch_1" {...(opts.initialStep ? { initialStep: opts.initialStep } : {})} /></MemoryRouter>
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
    // M4 final M11: a toggle with a constant name; its state is aria-pressed, never a flipped label.
    expect(button(html, 'Edit as JSON')).toContain('aria-pressed="false"');
    expect(html).not.toContain('Edit as form');
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

  it('a re-running premise shows the working state, not its previous output (residual N5)', () => {
    const r = run('running', 0, 'running');
    r.steps[0] = { ...r.steps[0]!, output: { title: 'Old premise title', synopsis: 's', tone: '', setting: '' } };
    const html = render(r);
    expect(html).toContain('Working…');
    expect(html).not.toContain('Old premise title');
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

  it('a rendering run shows Pause; a paused one shows Resume instead of Continue (W1 C1)', () => {
    const rendering = render(run('running', 5, 'running'));
    expect(enabled(rendering, 'Pause rendering')).toBe(true);
    expect(rendering).toContain('data-tip="Pause rendering"');
    expect(enabled(rendering, 'Continue')).toBe(false);
    expect(rendering).not.toContain('aria-label="Resume rendering"');
    expect(render(run('running', 4, 'running'))).not.toContain('aria-label="Pause rendering"');
    const html = render(run('paused', 5, 'paused'));
    expect(enabled(html, 'Resume rendering')).toBe(true);
    expect(html).toContain('data-tip="Resume rendering"');
    expect(html).not.toContain('aria-label="Continue"');
    expect(html).not.toContain('aria-label="Pause rendering"');
    expect(statusText(html)).toBe('Rendering paused');
    // F24: only Resume and Cancel move a paused run.
    expect(enabled(html, 'Run to end')).toBe(false);
    expect(enabled(html, 'Cancel episode')).toBe(true);
    expect(enabled(html, 'Re-run from here \\(later steps run again\\)')).toBe(false);
  });

  it('a render waiting at its preview stop asks the question and offers Continue (W1 Q2, F20)', () => {
    const r = run('awaiting-review', 5, 'awaiting-review');
    r.steps[5] = { ...r.steps[5]!, output: { jobs: [], reviewed: 0, flagged: 0, rounds: 0, failedPanelIds: [], preview: true, remainingPanels: 34, estimateSeconds: 1800 } };
    const html = render(r, { missing: ['pn_a', 'pn_b'] });
    expect(statusText(html)).toBe('Page 1 is ready — continue with 34 panels (~30 min)?');
    expect(enabled(html, 'Continue')).toBe(true);
    // F7: the panels without an image were never attempted; Continue renders them.
    expect(html).not.toContain('Re-render failed panels');
  });

  it('the render step offers "Re-render failed panels (N)" for its failed panels still without an image (W1 R1, F7)', () => {
    const r = run('failed', 6, 'failed', 'x');
    const done = {
      ...r,
      steps: r.steps.map((s) => (s.name === 'render'
        ? { ...s, status: 'done' as const, output: { jobs: [], reviewed: 0, flagged: 0, rounds: 0, failedPanelIds: ['pn_a', 'pn_b', 'pn_c'] } }
        : s)),
    };
    const html = render(done, { missing: ['pn_a', 'pn_b'], initialStep: 'render' });
    expect(enabled(html, 'Re-render failed panels \\(2\\)')).toBe(true);
    expect(html).toContain('data-tip="Re-render failed panels (2)"');
    expect(html).toMatch(/aria-label="Re-render failed panels \(2\)"[\s\S]*?class="icon-btn__badge">2</);
    // Only on the render step's tab, and gone once every failed panel has an image.
    expect(render(done, { missing: ['pn_a', 'pn_b'], initialStep: 'lettering' })).not.toContain('Re-render failed panels');
    expect(render(done, { missing: ['pn_z'], initialStep: 'render' })).not.toContain('Re-render failed panels');
  });
});
