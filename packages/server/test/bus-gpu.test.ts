import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { PermanentError, TransientError } from '../src/jobs/errors.js';
import { GpuArbiter } from '../src/jobs/gpu.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('EventBus', () => {
  it('delivers to every listener, survives a throwing one, and unsubscribes', () => {
    const bus = new EventBus();
    const seen: ServerEvent['type'][] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on(() => {
      throw new Error('bad listener');
    });
    const off = bus.on((e) => seen.push(e.type));
    bus.emit({ type: 'hello', serverTime: 'now' });
    off();
    bus.emit({ type: 'hello', serverTime: 'later' });
    expect(seen).toEqual(['hello']);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe('job errors', () => {
  it('are distinguishable and keep their message', () => {
    const t = new TransientError('comfy restarting');
    const p = new PermanentError('graph rejected');
    expect(t).toBeInstanceOf(Error);
    expect(t).not.toBeInstanceOf(PermanentError);
    expect([t.name, t.message, p.name, p.message]).toEqual(['TransientError', 'comfy restarting', 'PermanentError', 'graph rejected']);
  });
});

describe('GpuArbiter', () => {
  it('starts empty and does not release when the same owner re-acquires', async () => {
    const gpu = new GpuArbiter();
    const released: string[] = [];
    gpu.setReleaser('comfy', async () => {
      released.push('comfy');
    });
    expect(gpu.current).toBeNull();
    await gpu.acquire('comfy');
    await gpu.acquire('comfy');
    expect(gpu.current).toBe('comfy');
    expect(released).toEqual([]);
  });

  it('releases the other owner before switching', async () => {
    const gpu = new GpuArbiter();
    const released: string[] = [];
    gpu.setReleaser('comfy', async () => {
      released.push('comfy');
    });
    gpu.setReleaser('ollama', async () => {
      released.push('ollama');
    });
    await gpu.acquire('comfy');
    await gpu.acquire('ollama');
    expect([gpu.current, ...released]).toEqual(['ollama', 'ollama', 'comfy']);
    await gpu.acquire('comfy');
    expect([gpu.current, ...released]).toEqual(['comfy', 'ollama', 'comfy', 'ollama']);
  });

  it('frees the other side on the first acquire, since ComfyUI and ollama outlive a server restart (M1)', async () => {
    for (const first of ['comfy', 'ollama'] as const) {
      const gpu = new GpuArbiter();
      const released: string[] = [];
      gpu.setReleaser('comfy', async () => { released.push('comfy'); });
      gpu.setReleaser('ollama', async () => { released.push('ollama'); });
      await gpu.acquire(first);
      await gpu.acquire(first);
      expect(released).toEqual([first === 'comfy' ? 'ollama' : 'comfy']);
    }
  });

  it("passes the acquiring job's signal to the releaser (M5)", async () => {
    const gpu = new GpuArbiter();
    const seen: Array<AbortSignal | undefined> = [];
    gpu.setReleaser('comfy', async (signal) => { seen.push(signal); });
    const controller = new AbortController();
    await gpu.acquire('ollama', controller.signal);
    expect(seen).toEqual([controller.signal]);
  });

  it('serialises concurrent acquisitions', async () => {
    const gpu = new GpuArbiter();
    const log: string[] = [];
    gpu.setReleaser('comfy', async () => {
      log.push('release comfy start');
      await sleep(20);
      log.push('release comfy end');
    });
    gpu.setReleaser('ollama', async () => {
      log.push(`release ollama (current=${gpu.current})`);
    });
    await gpu.acquire('comfy');
    await Promise.all([gpu.acquire('ollama'), gpu.acquire('comfy')]);
    expect(log).toEqual(['release ollama (current=null)', 'release comfy start', 'release comfy end', 'release ollama (current=ollama)']);
    expect(gpu.current).toBe('comfy');
  });

  it('keeps the old owner when its releaser fails, and recovers for the next caller', async () => {
    const gpu = new GpuArbiter();
    gpu.setReleaser('comfy', async () => {
      throw new Error('free failed');
    });
    await gpu.acquire('comfy');
    await expect(gpu.acquire('ollama')).rejects.toThrow('free failed');
    expect(gpu.current).toBe('comfy');
    await gpu.acquire('comfy');
    expect(gpu.current).toBe('comfy');
  });
});
