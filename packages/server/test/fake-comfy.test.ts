import { afterEach, describe, expect, it } from 'vitest';
import { encodeSolidPng } from '../src/dev/png.js';
import { pngSize } from '../src/imaging/png-size.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { fakeOutputSize, startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';

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

describe('FakeComfy', () => {
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
});
