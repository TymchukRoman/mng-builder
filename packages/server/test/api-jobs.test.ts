import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON, type Job, type QueueLanes, type ServerEvent, type ServiceStatus } from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('jobs', () => {
  it('lists newest first, filters by status, applies the limit and validates the query', async () => {
    const q = t.deps.queue;
    const a = q.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { n: 1 } });
    const b = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: { n: 2 } });
    const c = q.enqueue({ kind: 'export.render', lane: 'cpu', payload: { n: 3 } });
    q.cancel(b.id);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs')).body.map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs?status=cancelled')).body.map((j) => j.id)).toEqual([b.id]);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs?status=queued&limit=1')).body.map((j) => j.id)).toEqual([c.id]);
    for (const url of ['/api/jobs?status=bogus', '/api/jobs?limit=0', '/api/jobs?limit=abc', '/api/jobs?limit=501']) {
      expect((await call(t.app, 'GET', url)).status, url).toBe(400);
    }
  });

  it('reads one job and 404s an unknown one', async () => {
    const job = t.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    expect((await call<Job>(t.app, 'GET', `/api/jobs/${job.id}`)).body).toEqual(job);
    expect((await call(t.app, 'GET', '/api/jobs/jb_missing000')).status).toBe(404);
    expect((await call(t.app, 'POST', '/api/jobs/jb_missing000/cancel')).status).toBe(404);
  });

  it('cancels a queued job, publishes the change, and is idempotent', async () => {
    const events: ServerEvent[] = [];
    t.deps.bus.on((e) => events.push(e));
    const job = t.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    expect((await call<Job>(t.app, 'POST', `/api/jobs/${job.id}/cancel`)).body).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(events.some((e) => e.type === 'job' && e.job.id === job.id && e.job.status === 'cancelled')).toBe(true);
    expect((await call<Job>(t.app, 'POST', `/api/jobs/${job.id}/cancel`)).body.status).toBe('cancelled');
  });
});

describe('queue lane routes (W1 R2)', () => {
  it('pause and resume the gpu lane; each change reaches the UI as a status event', async () => {
    await call<ServiceStatus>(t.app, 'GET', '/api/status'); // what the UI does on load
    const statuses: ServiceStatus[] = [];
    t.deps.bus.on((e) => { if (e.type === 'status') statuses.push(e.status); });
    const paused = await call<QueueLanes>(t.app, 'POST', '/api/queue/gpu/pause');
    expect(paused.body.pausedLanes).toEqual([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]);
    await vi.waitFor(() => expect(statuses.some((st) => st.queue.pausedLanes.some((p) => p.lane === 'gpu'))).toBe(true));
    const resumed = await call<QueueLanes>(t.app, 'POST', '/api/queue/gpu/resume');
    expect(resumed.body.pausedLanes).toEqual([]);
    await vi.waitFor(() => expect(statuses.at(-1)?.queue.pausedLanes).toEqual([]));
    expect((await call<ServiceStatus>(t.app, 'GET', '/api/status')).body.queue.pausedLanes).toEqual([]);
  });

  it('emits the lane state of the moment, in order, with the last probed service states (F11)', async () => {
    const status = (await call<ServiceStatus>(t.app, 'GET', '/api/status')).body; // the last probe
    const statuses: ServiceStatus[] = [];
    t.deps.bus.on((e) => { if (e.type === 'status') statuses.push(e.status); });
    t.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    t.deps.queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    t.deps.queue.resumeLane('gpu');
    t.deps.queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    // Emitted at once, without a new probe: a quick pause-resume-pause cannot arrive out of order.
    expect(statuses.map((st) => st.queue.pausedLanes.map((p) => p.reason))).toEqual([[GPU_BUSY_REASON], [], [GPU_MANUAL_PAUSE_REASON]]);
    expect(statuses[0]).toMatchObject({ claude: status.claude, ollama: status.ollama, comfy: status.comfy, queue: { queued: 1, running: 0 } });
  });

  it('a lane change before the first status probe emits nothing and probes nothing', async () => {
    const statuses: ServiceStatus[] = [];
    t.deps.bus.on((e) => { if (e.type === 'status') statuses.push(e.status); });
    let probes = 0;
    const comfy = t.deps.statusProviders.comfy;
    t.deps.statusProviders.comfy = async () => { probes++; return comfy(); };
    t.deps.queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses).toEqual([]);
    expect(probes).toBe(0);
    expect((await call<ServiceStatus>(t.app, 'GET', '/api/status')).body.queue.pausedLanes).toEqual([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]);
  });
});
