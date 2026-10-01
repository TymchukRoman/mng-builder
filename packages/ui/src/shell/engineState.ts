import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON, type EngineName, type Lane, type ServiceStatus } from '@manga/shared';

export type EngineTone = 'ok' | 'down' | 'paused' | 'unknown';

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ENGINE_LANE: Record<EngineName, Lane> = { claude: 'claude', local: 'gpu' };
const ENGINE_NAME: Record<EngineName, string> = { claude: 'Claude', local: 'Local (ollama)' };
const GPU_CHIP_REASONS: ReadonlySet<string> = new Set([GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON]);
const LANE_NAME: Record<Lane, string> = { claude: 'Claude', gpu: 'GPU', cpu: 'Export' };

export function engineIndicator(mode: EngineName, status: ServiceStatus | undefined): { tone: EngineTone; tip: string } {
  if (!status) return { tone: 'unknown', tip: 'Checking engine status' };
  const name = ENGINE_NAME[mode];
  // W1 F9: the GPU busy and manual pauses of the gpu lane show as the top bar chip, so the local engine does not repeat them.
  const paused = status.queue.pausedLanes.find((p) => p.lane === ENGINE_LANE[mode] && !GPU_CHIP_REASONS.has(p.reason));
  if (paused) return { tone: 'paused', tip: `${name} paused${paused.until ? ` until ${formatClock(paused.until)}` : ''}: ${paused.reason}` };
  const svc = mode === 'claude' ? status.claude : status.ollama;
  return svc.ok
    ? { tone: 'ok', tip: `${name} ready${svc.detail ? `: ${svc.detail}` : ''}` }
    : { tone: 'down', tip: `${name} unavailable: ${svc.detail}` };
}

/** One line per paused lane (spec §7: "the UI shows a banner" when the Claude quota pauses its lane). */
export function pausedBanner(status: ServiceStatus | undefined): string | null {
  // The gpu lane is the top bar chip's (W1 R2), not the banner's.
  const lanes = (status?.queue.pausedLanes ?? []).filter((p) => p.lane !== 'gpu');
  if (lanes.length === 0) return null;
  return lanes
    .map((p) => `${LANE_NAME[p.lane]} jobs paused${p.until ? ` until ${formatClock(p.until)}` : ''}: ${p.reason}`)
    .join('. ');
}

/** W1 R2: the gpu lane's pause, if any. The lane holds images and the local AI engine (F9). */
export function gpuPause(status: ServiceStatus | undefined): { reason: string } | null {
  const p = status?.queue.pausedLanes.find((l) => l.lane === 'gpu');
  return p ? { reason: p.reason } : null;
}

export function gpuPauseLabel(p: { reason: string }): string {
  return p.reason === GPU_BUSY_REASON ? 'GPU queue paused — GPU busy' : 'GPU queue paused';
}
