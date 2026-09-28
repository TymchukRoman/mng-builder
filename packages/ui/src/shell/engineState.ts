import type { EngineName, Lane, ServiceStatus } from '@manga/shared';

export type EngineTone = 'ok' | 'down' | 'paused' | 'unknown';

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ENGINE_LANE: Record<EngineName, Lane> = { claude: 'claude', local: 'gpu' };
const ENGINE_NAME: Record<EngineName, string> = { claude: 'Claude', local: 'Local (ollama)' };
const LANE_NAME: Record<Lane, string> = { claude: 'Claude', gpu: 'GPU', cpu: 'Export' };

export function engineIndicator(mode: EngineName, status: ServiceStatus | undefined): { tone: EngineTone; tip: string } {
  if (!status) return { tone: 'unknown', tip: 'Checking engine status' };
  const name = ENGINE_NAME[mode];
  const paused = status.queue.pausedLanes.find((p) => p.lane === ENGINE_LANE[mode]);
  if (paused) return { tone: 'paused', tip: `${name} paused${paused.until ? ` until ${formatClock(paused.until)}` : ''}: ${paused.reason}` };
  const svc = mode === 'claude' ? status.claude : status.ollama;
  return svc.ok
    ? { tone: 'ok', tip: `${name} ready${svc.detail ? `: ${svc.detail}` : ''}` }
    : { tone: 'down', tip: `${name} unavailable: ${svc.detail}` };
}

/** One line per paused lane (spec §7: "the UI shows a banner" when the Claude quota pauses its lane). */
export function pausedBanner(status: ServiceStatus | undefined): string | null {
  const lanes = status?.queue.pausedLanes ?? [];
  if (lanes.length === 0) return null;
  return lanes
    .map((p) => `${LANE_NAME[p.lane]} jobs paused${p.until ? ` until ${formatClock(p.until)}` : ''}: ${p.reason}`)
    .join('. ');
}
