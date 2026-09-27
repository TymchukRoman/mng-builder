import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, ServerEvent } from '@manga/shared';
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
