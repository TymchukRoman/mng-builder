import { DEFAULT_PAGE_FORMAT, DEFAULT_TRANSFORM, EMPTY_SCRIPT, type Image, type Job, type Manga, type PageDetail, type Panel, type TextFrame } from '@manga/shared';

const T = '2026-09-27T00:00:00.000Z';

export function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'jb_1', kind: 'image.generate', lane: 'gpu', status: 'queued', priority: 0, payload: { target: 'panel', panelId: 'pn_1' },
    result: null, error: null, attempts: 0, maxAttempts: 3, nextRunAt: T, progress: null, episodeRunId: null,
    createdAt: T, startedAt: null, finishedAt: null, ...over,
  };
}

export function makeManga(over: Partial<Manga> = {}): Manga {
  return {
    id: 'mg_1', title: 'Test', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: { recipe: 'anime', stylePrompt: '', negativePrompt: '', loras: [] },
    imageModel: null, coverPageId: null, createdAt: T, updatedAt: T, ...over,
  };
}

export function makePanel(id: string, pageId = 'pg_1', over: Partial<Panel> = {}): Panel {
  return {
    id, pageId, script: EMPTY_SCRIPT, prompt: { scene: '', negative: '' }, recipe: null, seedLock: false, seed: 1,
    refCharacterIds: [], activeImageId: null, imageTransform: DEFAULT_TRANSFORM, createdAt: T, updatedAt: T, ...over,
  };
}

export function makeFrame(id: string, pageId = 'pg_1', over: Partial<TextFrame> = {}): TextFrame {
  return {
    id, pageId, panelId: null, kind: 'speech', text: 'Hi', speakerId: null, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 },
    tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
    createdAt: T, updatedAt: T, ...over,
  };
}

export function makeImage(id: string, over: Partial<Image> = {}): Image {
  return {
    id, mangaId: 'mg_1', ownerType: 'panel', ownerId: 'pn_1', role: null, path: `mangas/mg_1/images/${id}.png`,
    width: 832, height: 1216, source: 'generated', parentImageId: null, gen: null, review: null, createdAt: T, ...over,
  };
}

/** A page with a vertical split of pn_a | pn_b, plus any frames given. */
export function makeDetail(pageId = 'pg_1', frames: TextFrame[] = []): PageDetail {
  return {
    page: {
      id: pageId, mangaId: 'mg_1', chapterId: 'ch_1', kind: 'page', order: 0,
      layout: { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } },
      createdAt: T, updatedAt: T,
    },
    panels: [makePanel('pn_a', pageId), makePanel('pn_b', pageId)],
    frames,
    images: {},
  };
}
