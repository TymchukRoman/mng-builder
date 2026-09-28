import { describe, expect, it } from 'vitest';
import type { ServiceStatus } from '@manga/shared';
import { engineIndicator, formatClock, pausedBanner } from '../src/shell/engineState';

function status(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    claude: { ok: true, detail: 'logged in' }, ollama: { ok: false, detail: 'ollama not reachable at http://127.0.0.1:11434' },
    comfy: { ok: true, detail: '' }, queue: { queued: 0, running: 0, pausedLanes: [] }, ...over,
  };
}

describe('engine indicator', () => {
  it('is unknown until status loads', () => {
    expect(engineIndicator('claude', undefined).tone).toBe('unknown');
  });
  it('reports the selected engine health', () => {
    expect(engineIndicator('claude', status())).toEqual({ tone: 'ok', tip: 'Claude ready: logged in' });
    expect(engineIndicator('local', status())).toEqual({ tone: 'down', tip: 'Local (ollama) unavailable: ollama not reachable at http://127.0.0.1:11434' });
  });
  it('shows a paused lane with its reset time', () => {
    const until = new Date(2026, 8, 27, 14, 5).toISOString();
    const s = status({ queue: { queued: 2, running: 0, pausedLanes: [{ lane: 'claude', until, reason: 'quota exhausted' }] } });
    expect(engineIndicator('claude', s)).toEqual({ tone: 'paused', tip: 'Claude paused until 14:05: quota exhausted' });
    expect(pausedBanner(s)).toBe('Claude jobs paused until 14:05: quota exhausted');
  });
  it('has no banner when nothing is paused', () => {
    expect(pausedBanner(status())).toBeNull();
    expect(pausedBanner(undefined)).toBeNull();
  });
  it('formats local clock time', () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 7).toISOString())).toBe('09:07');
  });
});
