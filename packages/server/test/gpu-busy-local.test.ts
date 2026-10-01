import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON, type ImageReviewPayload } from '@manga/shared';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { EventBus } from '../src/events/bus.js';
import { OllamaEngine } from '../src/engines/ollama.js';
import { Engines } from '../src/engines/resolve.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { panelPromptStep } from '../src/handlers/panel-prompt.js';
import { reviewImage } from '../src/handlers/review.js';
import type { HandlerServices } from '../src/handlers/types.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { GpuMonitor } from '../src/imaging/gpu-monitor.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { llmStepJobHandler, registerLlmStep } from '../src/jobs/llm-step.js';
import { JobQueue } from '../src/jobs/queue.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { startFakeOllama, type FakeOllama } from './fakes/fake-ollama.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedImage, seedManga } from './helpers/seed.js';

/**
 * W1 final I1: the local engine's jobs share the gpu lane with ComfyUI. While a game holds the GPU memory they pause the
 * lane like an image job does, and the GPU monitor resumes it once there is room again.
 */
let lib: TestLibrary;
let comfyFake: FakeComfy;
let ollamaFake: FakeOllama;
let queue: JobQueue | undefined;
let monitor: GpuMonitor | undefined;
beforeEach(async () => {
  lib = openTestLibrary();
  comfyFake = await startFakeComfy();
  ollamaFake = await startFakeOllama();
});
afterEach(async () => {
  monitor?.stop();
  await queue?.stop();
  queue = undefined;
  monitor = undefined;
  await ollamaFake.close();
  await comfyFake.close();
  lib.close();
});

function localGpuLane(): { queue: JobQueue; services: HandlerServices } {
  const comfy = new ComfyClient({ url: comfyFake.url, launcher: null, pollMs: 10 });
  const gpu = new GpuArbiter();
  gpu.setReleaser('comfy', (signal) => comfy.release(signal));
  const local = new OllamaEngine({
    url: ollamaFake.url, gpu, probe: comfy, vramWaitMs: 50, vramPollMs: 10,
    models: () => ({ textModel: 'qwen3:14b', visionModel: 'qwen3-vl:8b' }),
  });
  const claude = new ScriptedEngine('claude', FAKE_RESPONSES);
  const services: HandlerServices = {
    engines: new Engines({ settings: () => lib.store.settings.get(), claude, local }), requireComfy: () => comfy,
  };
  const q = new JobQueue({ store: lib.store, bus: new EventBus(), gpu, pollMs: 5 });
  queue = q;
  monitor = new GpuMonitor({ queue: q, probe: comfy, intervalMs: 20 });
  monitor.start();
  return { queue: q, services };
}

describe('local engine jobs on the gpu lane while a game holds the GPU memory (W1 final I1)', () => {
  it('an llm.step waits queued with the lane paused as busy, and succeeds once 12 GB are free', async () => {
    const { queue: q, services } = localGpuLane();
    registerLlmStep('panel-prompt', panelPromptStep(services));
    q.register('llm.step', llmStepJobHandler());
    const { panels } = seedManga(lib.store);
    comfyFake.vramFree = 1e9; // a game holds the rest
    ollamaFake.replies.push('{"scene":"solo, standing, rooftop"}');
    const job = q.enqueue({ kind: 'llm.step', lane: 'gpu', payload: { type: 'panel-prompt', panelId: panels[0]!.id } });
    q.start();

    await vi.waitFor(() => expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    await vi.waitFor(() => expect(lib.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0, error: null }));
    expect(ollamaFake.requests.some((r) => r.path === '/api/chat')).toBe(false); // nothing was asked on the busy GPU

    comfyFake.vramFree = 12e9; // the game quit: the monitor resumes the lane
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(q.pauseOf('gpu')).toBeNull();
    expect(lib.store.panels.require(panels[0]!.id).prompt.scene).toContain('rooftop');
  });

  it('a local vision review (image.review) waits the same way instead of failing or passing unreviewed', async () => {
    const { queue: q, services } = localGpuLane();
    q.register('image.review', (ctx) => reviewImage(ctx, services, ctx.job.payload as ImageReviewPayload));
    const { manga, panels } = seedManga(lib.store);
    const image = seedImage(lib.store, manga.id, { type: 'panel', id: panels[0]!.id }, null);
    comfyFake.vramFree = 1e9;
    ollamaFake.replies.push('{"pass":false,"issues":[{"kind":"anatomy","note":"Six fingers on the left hand."}]}');
    const job = q.enqueue({ kind: 'image.review', lane: 'gpu', payload: { imageId: image.id, panelId: panels[0]!.id } });
    q.start();

    await vi.waitFor(() => expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    expect(lib.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(lib.store.images.require(image.id).review).toBeNull();

    comfyFake.vramFree = 12e9;
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(lib.store.images.require(image.id).review).toMatchObject({ engine: 'local', pass: false });
    const chat = ollamaFake.requests.find((r) => r.path === '/api/chat')!;
    expect(chat.body!['model']).toBe('qwen3-vl:8b');
  });
});
