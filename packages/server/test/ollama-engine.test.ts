import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MIN_NUM_CTX, OllamaEngine, numCtxFor } from '../src/engines/ollama.js';
import { EngineUnavailableError } from '../src/engines/errors.js';
import { GpuArbiter } from '../src/jobs/index.js';
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

  it('numCtxFor rounds up to a power of two so the model is not reloaded for every small size change', () => {
    expect(MIN_NUM_CTX).toBe(8192);
    expect(numCtxFor(0)).toBe(8192);
    expect(numCtxFor(10_000)).toBe(8192);
    expect(numCtxFor(12_000)).toBe(16384);
    expect(numCtxFor(100_000)).toBe(65536);
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
