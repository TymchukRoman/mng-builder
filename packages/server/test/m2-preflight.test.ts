import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, STYLE_PRESETS } from '@manga/shared';
import { startServer } from '../src/app.js';
import { openStore } from '../src/store/index.js';
import { GpuArbiter, JobQueue, PermanentError, TransientError } from '../src/jobs/index.js';
import { EventBus } from '../src/events/bus.js';
import { createPage } from '../src/domain/pages.js';

const dirs: string[] = [];
function tempLibrary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manga-pre-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function seedManga(store: ReturnType<typeof openStore>) {
  const preset = STYLE_PRESETS['manga-bw']!;
  return store.mangas.create({
    title: 'Preflight', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
}

describe('M1 behaviours M2 relies on', () => {
  it('images.create keeps an explicit id', () => {
    const store = openStore(tempLibrary());
    try {
      const manga = seedManga(store);
      const rel = store.files.writeImage(manga.id, 'im_preflight01', new Uint8Array([1, 2, 3]));
      const image = store.images.create({
        id: 'im_preflight01', mangaId: manga.id, ownerType: 'character', ownerId: 'cr_preflight1', role: null,
        path: rel, width: 1, height: 1, source: 'uploaded', parentImageId: null, gen: null, review: null,
      } as Parameters<typeof store.images.create>[0]);
      expect(image.id).toBe('im_preflight01');
      expect(image.path).toBe(store.files.imageRel(manga.id, 'im_preflight01'));
    } finally {
      store.close();
    }
  });

  it('createPage creates a Panel row for every layout leaf', () => {
    const store = openStore(tempLibrary());
    try {
      const manga = seedManga(store);
      const chapter = store.chapters.create({
        mangaId: manga.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0,
      });
      const detail = createPage(store, chapter.id, '2x2');
      expect(detail.panels).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('startServer honours port 0 and lets a module factory replace status providers', async () => {
    const server = await startServer({
      config: { libraryPath: tempLibrary(), port: 0 },
      modules: (deps) => {
        deps.statusProviders.comfy = async () => ({ ok: true, detail: 'preflight' });
        return [];
      },
    });
    try {
      expect(new URL(server.url).port).not.toBe('0');
      const status = (await (await fetch(`${server.url}/api/status`)).json()) as { comfy: unknown };
      expect(status.comfy).toEqual({ ok: true, detail: 'preflight' });
    } finally {
      await server.stop();
    }
  });

  it('lets a module own GET /api/recipes (M1 only adds a [] fallback when nobody did)', async () => {
    const recipesModule = {
      name: 'preflight-recipes',
      register(app: import('fastify').FastifyInstance) {
        app.get('/api/recipes', async () => [{ id: 'anime' }]);
      },
    };
    const server = await startServer({ config: { libraryPath: tempLibrary(), port: 0 }, modules: () => [recipesModule] });
    try {
      const res = await fetch(`${server.url}/api/recipes`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: 'anime' }]);
    } finally {
      await server.stop();
    }
  });

  it('exposes the job primitives with the contract shapes', () => {
    const store = openStore(tempLibrary());
    try {
      expect(new TransientError('x')).toBeInstanceOf(Error);
      expect(new PermanentError('x')).toBeInstanceOf(Error);
      const queue = new JobQueue({ store, bus: new EventBus(), gpu: new GpuArbiter() });
      queue.pauseLane('claude', new Date('2100-01-01T00:00:00.000Z'), 'preflight');
      expect(queue.pausedLanes()).toEqual([{ lane: 'claude', until: '2100-01-01T00:00:00.000Z', reason: 'preflight' }]);
    } finally {
      store.close();
    }
  });
});
