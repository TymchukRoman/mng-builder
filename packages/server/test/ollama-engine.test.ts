import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MAX_NUM_CTX, MIN_NUM_CTX, OllamaEngine, numCtxFor } from '../src/engines/ollama.js';
import { EngineUnavailableError } from '../src/engines/errors.js';
import { GpuArbiter, GpuBusyError, TransientError, type GpuProbe } from '../src/jobs/index.js';
import { startFakeOllama, type FakeOllama } from './fakes/fake-ollama.js';

let fo: FakeOllama;
beforeEach(async () => { fo = await startFakeOllama(); });
afterEach(async () => { await fo.close(); });

const models = (): { textModel: string; visionModel: string } => ({ textModel: 'qwen3:14b', visionModel: 'qwen3-vl:8b' });
const Scene = z.object({ scene: z.string() });
const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'SYS', prompt: 'Привіт', schema: Scene };
const engine = (over: Partial<ConstructorParameters<typeof OllamaEngine>[0]> = {}): OllamaEngine =>
  new OllamaEngine({ url: fo.url, models, gpu: null, ...over });

describe('OllamaEngine', () => {
  it('posts a native /api/chat request with a JSON-schema format and thinking off', async () => {
    fo.replies.push('{"scene":"solo"}');
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'solo' });
    const chat = fo.requests.find((r) => r.path === '/api/chat')!;
    expect(chat.body).toMatchObject({ model: 'qwen3:14b', stream: false, think: false, keep_alive: '10m' });
    expect((chat.body!['format'] as { properties: unknown }).properties).toEqual({ scene: { type: 'string' } });
    const messages = chat.body!['messages'] as Array<{ role: string; content: string; images?: string[] }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('SYS');
    expect(messages[1]).toEqual({ role: 'user', content: 'Привіт' });
  });

  it('sizes options.num_ctx from the prompt length, never below 8192 (F18: the default context truncates episode prompts)', async () => {
    fo.replies.push('{"scene":"short"}', '{"scene":"long"}');
    await engine().completeJson(req);
    await engine().completeJson({ ...req, prompt: 'x'.repeat(60_000) });
    const sizes = fo.requests.filter((r) => r.path === '/api/chat').map((r) => (r.body!['options'] as { num_ctx: number }).num_ctx);
    expect(sizes).toEqual([8192, 32768]);
  });

  it('numCtxFor rounds up to a power of two (no reload for every small size change), between 8192 and 32768', () => {
    expect(MIN_NUM_CTX).toBe(8192);
    expect(MAX_NUM_CTX).toBe(32768);
    expect(numCtxFor(0)).toBe(8192);
    expect(numCtxFor(10_000)).toBe(8192);
    expect(numCtxFor(12_000)).toBe(16384);
    expect(numCtxFor(60_000)).toBe(32768);
    expect(numCtxFor(100_000)).toBe(32768); // capped (M2): a larger KV cache would spill a 14B model to the CPU
    expect(numCtxFor(1_000_000)).toBe(32768);
  });

  it('sends images as base64 to the vision model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ollama-img-'));
    try {
      const image = join(dir, 'a.png');
      writeFileSync(image, Buffer.from([1, 2, 3]));
      fo.replies.push('{"scene":"x"}');
      await engine().completeJson({ ...req, images: [image] });
      const chat = fo.requests.find((r) => r.path === '/api/chat')!;
      expect(chat.body!['model']).toBe('qwen3-vl:8b');
      expect((chat.body!['messages'] as Array<{ images?: string[] }>)[1]!.images).toEqual(['AQID']);
      expect(chat.body!['options']).toEqual({ num_ctx: 8192 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to message.thinking when content is empty (live: qwen3-vl:8b with think:false + format answers there)', async () => {
    fo.replies.push({ content: '', thinking: '{"scene":"from-thinking"}' });
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'from-thinking' });
  });

  it('prefers content over thinking when content is present', async () => {
    fo.replies.push({ content: '{"scene":"from-content"}', thinking: '{"scene":"from-thinking"}' });
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'from-content' });
  });

  it('runs one correction round through the same endpoint', async () => {
    fo.replies.push('nothing useful', '{"scene":"ok"}');
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'ok' });
    expect(fo.requests.filter((r) => r.path === '/api/chat')).toHaveLength(2);
  });

  it('takes the GPU before asking', async () => {
    const gpu = new GpuArbiter();
    const freed: string[] = [];
    gpu.setReleaser('comfy', async () => { freed.push('comfy'); });
    await gpu.acquire('comfy');
    fo.replies.push('{"scene":"x"}');
    await engine({ gpu }).completeJson(req);
    expect(freed).toEqual(['comfy']);
    expect(gpu.current).toBe('ollama');
  });

  describe('GPU busy on the gpu lane (W1 final I1)', () => {
    const probe = (vram: { free: number | null }): GpuProbe => ({ availableVram: async () => vram.free });
    const quick = { vramWaitMs: 60, vramPollMs: 20 };

    it('refuses with a GpuBusyError (not stalled) while another app holds the GPU memory; nothing is asked', async () => {
      const labels: string[] = [];
      const err = await engine({ probe: probe({ free: 1e9 }), ...quick })
        .completeJson({ ...req, onProgress: (l) => labels.push(l) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GpuBusyError);
      expect((err as GpuBusyError).stalled).toBe(false);
      expect((err as Error).message).toBe('GPU busy: only 1.0 GB of GPU memory free (GPU memory is probably full; close games or other GPU apps)');
      expect(labels).toEqual([(err as Error).message]);
      expect(fo.requests.some((r) => r.path === '/api/chat')).toBe(false);
    });

    it('counts the VRAM of its own loaded model as available', async () => {
      fo.loaded.add('qwen3:14b');
      fo.sizeVram = 10e9; // ollama itself holds 10 GB; 1 GB is free beside it
      fo.replies.push('{"scene":"x"}');
      await expect(engine({ probe: probe({ free: 1e9 }), ...quick }).completeJson(req)).resolves.toEqual({ scene: 'x' });
    });

    it('asks as usual when the VRAM cannot be read (ComfyUI not running yet)', async () => {
      fo.replies.push('{"scene":"x"}');
      await expect(engine({ probe: probe({ free: null }), ...quick }).completeJson(req)).resolves.toEqual({ scene: 'x' });
    });

    it('a timeout while another app holds the memory is a stalled GpuBusyError, and the model is unloaded', async () => {
      const vram = { free: 5e9 }; // enough to start (3 GB or more), not enough to count as free (below 8 GB)
      fo.chatDelayMs = 2_000;
      const err = await engine({ probe: probe(vram), ...quick, timeoutMs: 50 }).completeJson(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GpuBusyError);
      expect((err as GpuBusyError).stalled).toBe(true);
      expect((err as Error).message).toBe('ollama did not answer within 0 s (GPU memory is probably full; close games or other GPU apps)');
      expect(fo.requests.filter((r) => r.path === '/api/generate').map((r) => r.body)).toEqual([{ model: 'qwen3:14b', keep_alive: 0 }]);
    });

    it('a timeout with the memory free, or unreadable, stays a plain TransientError', async () => {
      fo.chatDelayMs = 2_000;
      for (const free of [15e9, null]) {
        const err = await engine({ probe: probe({ free }), ...quick, timeoutMs: 50 }).completeJson(req).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TransientError);
        expect(err).not.toBeInstanceOf(GpuBusyError);
        expect((err as Error).message).toBe('ollama did not answer within 0 s');
      }
      expect(fo.requests.some((r) => r.path === '/api/generate')).toBe(false);
    });
  });

  it('names a model that is not pulled', async () => {
    const err = await engine({ models: () => ({ textModel: 'qwen9:1b', visionModel: 'qwen3-vl:8b' }) }).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe('model qwen9:1b not pulled (run: ollama pull qwen9:1b)');
  });

  it('says where it looked when ollama is down', async () => {
    const err = await engine({ url: 'http://127.0.0.1:9' }).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe('ollama not reachable at http://127.0.0.1:9');
  });

  it('aborts the in-flight fetch when req.signal aborts', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const hangingFetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('fake fetch aborted'));
        });
      });
    }) as typeof fetch;
    setTimeout(() => controller.abort(), 20);
    const err = await engine({ fetchImpl: hangingFetch })
      .completeJson({ ...req, signal: controller.signal })
      .catch((e: unknown) => e);
    expect(sawAbort).toBe(true);
    expect((err as Error).message).toMatch(/aborted|cancelled/i);
    expect(fo.requests).toHaveLength(0);
  });

  it('unloads only the models that are loaded', async () => {
    fo.loaded.add('qwen3:14b');
    await engine().unload();
    expect(fo.requests.filter((r) => r.path === '/api/generate').map((r) => r.body)).toEqual([{ model: 'qwen3:14b', keep_alive: 0 }]);
    expect(fo.loaded.size).toBe(0);
  });

  it('treats ollama being unreachable as already released: logs, never throws (G2)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(engine({ url: 'http://127.0.0.1:9' }).unload()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toContain('not reachable');
    logged.mockRestore();
  });

  it('health lists the configured models or what is missing', async () => {
    await expect(engine().health()).resolves.toEqual({ ok: true, detail: 'qwen3:14b, qwen3-vl:8b' });
    fo.models.splice(1);
    await expect(engine().health()).resolves.toEqual({ ok: false, detail: 'model qwen3-vl:8b not pulled (run: ollama pull qwen3-vl:8b)' });
    await expect(engine({ url: 'http://127.0.0.1:9' }).health()).resolves.toEqual({ ok: false, detail: 'ollama not reachable at http://127.0.0.1:9' });
  });
});
