import { afterEach, describe, expect, it } from 'vitest';
import { encodeSolidPng } from '../src/dev/png.js';
import { pngSize } from '../src/imaging/png-size.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { fakeOutputSize, startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { makeJpegHeader } from './helpers/png.js';

let fake: FakeComfy | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

describe('fakeOutputSize', () => {
  it('uses the latent node, else the loaded image scaled by upscalers', () => {
    const uploads = new Map([['manga-builder/a.png', encodeSolidPng(100, 80)]]);
    expect(fakeOutputSize({ '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1216, height: 832 } } }, uploads)).toEqual({ width: 1216, height: 832 });
    expect(fakeOutputSize({
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/a.png' } },
      '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0] } },
    }, uploads)).toEqual({ width: 100, height: 80 });
    expect(fakeOutputSize({
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/a.png' } },
      '2': { class_type: 'ImageUpscaleWithModel', inputs: { image: ['1', 0] } },
      '3': { class_type: 'ImageScaleBy', inputs: { image: ['2', 0], scale_by: 0.5 } },
    }, uploads)).toEqual({ width: 200, height: 160 });
  });
});

describe('fakeOutputSize with JPEG inputs (M8)', () => {
  it('sizes an uploaded JPEG like a PNG', () => {
    const uploads = new Map([['manga-builder/j.png', new Uint8Array(makeJpegHeader(120, 90))]]);
    expect(fakeOutputSize({
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/j.png' } },
      '2': { class_type: 'ImageUpscaleWithModel', inputs: { image: ['1', 0] } },
    }, uploads)).toEqual({ width: 480, height: 360 });
  });
});

describe('FakeComfy', () => {
  it('records a run that throws as an execution_error instead of crashing the fakes server (M8)', async () => {
    fake = await startFakeComfy();
    const form = new FormData();
    form.append('image', new Blob([new TextEncoder().encode('not an image')], { type: 'image/png' }), 'bad.png');
    form.append('subfolder', 'manga-builder');
    await fetch(`${fake.url}/upload/image`, { method: 'POST', body: form });
    const graph: ComfyGraph = {
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/bad.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 't' } },
    };
    await fetch(`${fake.url}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, prompt_id: 'bad-1' }) });
    type Entry = { status: { status_str: string; messages: Array<[string, Record<string, unknown>]> } };
    let history: Record<string, Entry> = {};
    for (let i = 0; i < 100 && !history['bad-1']; i++) {
      history = (await (await fetch(`${fake.url}/history/bad-1`)).json()) as typeof history;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(history['bad-1']!.status.status_str).toBe('error');
    const [type, error] = history['bad-1']!.status.messages[0]!;
    expect(type).toBe('execution_error');
    expect(String(error['exception_message'])).toContain('not a PNG or JPEG');
    expect((await fetch(`${fake.url}/system_stats`)).status).toBe(200);
  });

  it('runs a prompt to a PNG of the latent size and records the graph', async () => {
    fake = await startFakeComfy();
    const graph: ComfyGraph = {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 't' } },
    };
    const res = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, prompt_id: 'p-1' }),
    });
    expect(await res.json()).toMatchObject({ prompt_id: 'p-1', node_errors: {} });
    let history: Record<string, { outputs: Record<string, { images: Array<{ filename: string }> }> }> = {};
    for (let i = 0; i < 100 && !history['p-1']; i++) {
      history = (await (await fetch(`${fake.url}/history/p-1`)).json()) as typeof history;
      await new Promise((r) => setTimeout(r, 10));
    }
    const filename = history['p-1']!.outputs['2']!.images[0]!.filename;
    const png = new Uint8Array(await (await fetch(`${fake.url}/view?filename=${filename}&type=output`)).arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 64, height: 48 });
    expect(fake.graphs).toEqual([graph]);
    expect(fake.promptIds).toEqual(['p-1']);
  });

  it('stores multipart uploads under subfolder/name', async () => {
    fake = await startFakeComfy();
    const form = new FormData();
    form.append('image', new Blob([encodeSolidPng(4, 4)], { type: 'image/png' }), 'im_a.png');
    form.append('subfolder', 'manga-builder');
    form.append('overwrite', 'true');
    const res = await fetch(`${fake.url}/upload/image`, { method: 'POST', body: form });
    expect(await res.json()).toEqual({ name: 'im_a.png', subfolder: 'manga-builder', type: 'input' });
    expect(pngSize(fake.uploads.get('manga-builder/im_a.png')!)).toEqual({ width: 4, height: 4 });
  });

  it('answers 503 everywhere while down and closes twice safely', async () => {
    fake = await startFakeComfy();
    fake.up = false;
    expect((await fetch(`${fake.url}/system_stats`)).status).toBe(503);
    await fake.close();
    await fake.close();
  });

  it('streams WebSocket execution events in order for a sampler node', async () => {
    fake = await startFakeComfy();
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${fake.url.replace(/^http/, 'ws')}/ws?clientId=c1`);
    const messages: Array<{ type: string; data: unknown }> = [];
    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
      ws.on('message', (data) => { messages.push(JSON.parse(String(data))); });
    });

    const graph: ComfyGraph = {
      '1': { class_type: 'KSampler', inputs: { seed: 0, steps: 1, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['2', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0] } },
      '2': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 't' } },
    };
    const res = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'c1' }),
    });
    const { prompt_id } = (await res.json()) as { prompt_id: string };

    await new Promise<void>((resolve) => {
      const check = () => {
        const types = messages.filter((m) => m.type !== 'status').map((m) => m.type);
        if (types.includes('execution_success')) {
          expect(types.slice(0, -2)).toContain('execution_start');
          expect(types).toContain('progress'); // sampler produces progress
          expect(types.slice(-2)).toEqual(['executing', 'execution_success']);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    ws.close();
  });

  it('injects execution_error when failNext is set', async () => {
    fake = await startFakeComfy();
    fake.failNext = 'boom';
    const graph: ComfyGraph = {
      '1': { class_type: 'KSampler', inputs: { seed: 0 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 't' } },
    };
    const res = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }),
    });
    const { prompt_id } = (await res.json()) as { prompt_id: string };

    type HistoryEntry = {
      status: { status_str: string; messages: Array<[string, Record<string, unknown>]> };
    };
    let history: Record<string, HistoryEntry> = {};
    for (let i = 0; i < 100 && !history[prompt_id]; i++) {
      history = (await (await fetch(`${fake.url}/history/${prompt_id}`)).json()) as typeof history;
      await new Promise((r) => setTimeout(r, 10));
    }
    const entry = history[prompt_id];
    expect(entry?.status.status_str).toBe('error');
    expect(entry?.status.messages[0]?.[0]).toBe('execution_error');
    const error = entry?.status.messages[0]?.[1] as Record<string, unknown>;
    expect(error?.exception_message).toBe('boom');
    expect(error?.node_id).toBe('1');
  });

  it('reports an interrupted run, lists running prompts on GET /queue, and forgets a dropped one', async () => {
    fake = await startFakeComfy();
    const graph: ComfyGraph = { '1': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 't' } } };
    const post = async (id: string): Promise<void> => {
      await fetch(`${fake!.url}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, prompt_id: id }) });
    };
    fake.interruptNext = true;
    await post('interrupted-1');
    type Entry = { status: { status_str: string; messages: Array<[string, unknown]> } };
    let history: Record<string, Entry> = {};
    for (let i = 0; i < 100 && !history['interrupted-1']; i++) {
      history = (await (await fetch(`${fake.url}/history/interrupted-1`)).json()) as typeof history;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(history['interrupted-1']!.status.status_str).toBe('error');
    expect(history['interrupted-1']!.status.messages.map(([type]) => type)).toContain('execution_interrupted');

    fake.completionDelayMs = 1_000;
    await post('running-1');
    fake.dropNext = true;
    await post('dropped-1');
    const queue = (await (await fetch(`${fake.url}/queue`)).json()) as { queue_running: unknown[][]; queue_pending: unknown[][] };
    expect(queue.queue_running.map((item) => item[1])).toEqual(['running-1']);
    expect(queue.queue_pending).toEqual([]);
    expect(fake.promptIds).toEqual(['interrupted-1', 'running-1', 'dropped-1']);
    expect(await (await fetch(`${fake.url}/history/dropped-1`)).json()).toEqual({});
  });

  it('rejectNext is one-shot and next prompt succeeds', async () => {
    fake = await startFakeComfy();
    fake.rejectNext = { error: { type: 'test_error', message: 'nope' }, node_errors: { '1': 'failed' } };
    const graph: ComfyGraph = { '1': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 't' } } };

    const res1 = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }),
    });
    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as { error: { type: string } };
    expect(body1.error.type).toBe('test_error');

    const res2 = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { prompt_id: string };
    expect(body2.prompt_id).toBeDefined();
  });

  it('closes promptly even with large completionDelayMs', async () => {
    fake = await startFakeComfy();
    fake.completionDelayMs = 60_000;
    const graph: ComfyGraph = { '1': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 't' } } };
    const res = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }),
    });
    expect((await res.json()) as { prompt_id: string }).toHaveProperty('prompt_id');

    const start = Date.now();
    await fake.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // close should not wait for the 60s delay
  });
});
