import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON, type ServiceStatus } from '@manga/shared';
import { qk } from '../src/queryKeys';
import { GpuPausedChip, GpuQueueControl } from '../src/shell/GpuQueueControl';

function html(pausedLanes: ServiceStatus['queue']['pausedLanes'], node: 'control' | 'chip'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.status(), {
    claude: { ok: true, detail: '' }, ollama: { ok: true, detail: '' }, comfy: { ok: true, detail: '' }, queue: { queued: 0, running: 0, pausedLanes },
  } satisfies ServiceStatus);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node === 'control' ? <GpuQueueControl /> : <GpuPausedChip />}</QueryClientProvider>);
}

describe('GPU queue controls (W1 R2, F9)', () => {
  it('running: a Pause button and no chip', () => {
    const control = html([], 'control');
    expect(control).toContain('aria-label="Pause GPU queue (images and local AI)"');
    expect(control).toContain('data-tip="Pause GPU queue (images and local AI)"');
    expect(html([], 'chip')).toBe('');
  });

  it('busy: the chip says why (tooltip: the reason) and the button resumes', () => {
    const paused = [{ lane: 'gpu' as const, until: null, reason: GPU_BUSY_REASON }];
    const control = html(paused, 'control');
    expect(control).toContain('aria-label="Resume GPU queue"');
    expect(control).toContain('>GPU queue paused — GPU busy<');
    expect(html(paused, 'chip')).toMatch(/role="status"[^>]*data-tip="GPU busy: another app is using GPU memory"[^>]*>GPU queue paused — GPU busy</);
  });

  it('manual: the chip reads GPU queue paused', () => {
    const paused = [{ lane: 'gpu' as const, until: null, reason: GPU_MANUAL_PAUSE_REASON }];
    expect(html(paused, 'chip')).toContain('>GPU queue paused<');
  });
});
