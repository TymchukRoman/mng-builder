import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { PageDetail, ServerEvent } from '@manga/shared';

export const qk = {
  mangas: () => ['mangas'] as const,
  manga: (id: string) => ['manga', id] as const,
  characters: (mangaId: string) => ['characters', mangaId] as const,
  character: (id: string) => ['character', id] as const,
  characterImages: (id: string) => ['characterImages', id] as const,
  chapters: (mangaId: string) => ['chapters', mangaId] as const,
  chapter: (id: string) => ['chapter', id] as const,
  pages: (chapterId: string) => ['pages', chapterId] as const,
  page: (id: string) => ['page', id] as const,
  panelImages: (panelId: string) => ['panelImages', panelId] as const,
  jobs: () => ['jobs'] as const,
  settings: () => ['settings'] as const,
  status: () => ['status'] as const,
  layouts: () => ['layouts'] as const,
  stylePresets: () => ['stylePresets'] as const,
  recipes: () => ['recipes'] as const,
  config: () => ['config'] as const,
  episode: (chapterId: string) => ['episode', chapterId] as const,
  /** W1 R1: the chapter's panels without an image; any page or panel change may change it. */
  missingPanels: (chapterId: string) => ['missingPanels', chapterId] as const,
};

export type EntityEvent = Extract<ServerEvent, { type: 'entity' }>;

/**
 * M4 final residual N2: pages and panels the server reported deleted in this session (events.ts records them before it
 * drops their queries). A cascade emits `panel deleted` before its `page deleted`, so an inspector still showing the
 * panel, or an editor rendered with a stale page list, re-renders in between; without this guard it re-created the
 * dropped query and fetched a 404. Ids are never reused, so a deleted id stays unfetchable.
 */
export const deletedIds = new Set<string>();

/** Whether an entity's query may fetch: there is an id, and the server has not deleted it. */
export function fetchableId(id: string | null | undefined, deleted: ReadonlySet<string> = deletedIds): boolean {
  return !!id && !deleted.has(id);
}

export interface OwnerLookup {
  pageOfPanel(panelId: string): string | null;
  pageOfFrame(frameId: string): string | null;
}

/**
 * Maps an `entity` event to the query keys it should invalidate.
 *
 * MVP note (preflight F5a): when a panel or textFrame event's owning page isn't in the cache
 * (e.g. the page was never opened this session), we fall back to invalidating the whole `['page']`
 * prefix rather than doing nothing. This is broader than necessary (every mounted page detail
 * refetches), but it is correct and simple; a real fix would need the server to carry pageId on
 * these events.
 */
export function keysForEntity(e: EntityEvent, lookup: OwnerLookup): QueryKey[] {
  switch (e.entity) {
    case 'manga':
      return [['mangas'], qk.manga(e.id)];
    case 'character':
      return [e.mangaId ? qk.characters(e.mangaId) : ['characters'], qk.character(e.id), qk.characterImages(e.id)];
    case 'chapter':
      return [e.mangaId ? qk.chapters(e.mangaId) : ['chapters'], qk.chapter(e.id), qk.pages(e.id)];
    case 'page':
      return [qk.page(e.id), ['pages'], ['missingPanels']];
    case 'panel': {
      const pageId = lookup.pageOfPanel(e.id);
      return [pageId ? qk.page(pageId) : ['page'], qk.panelImages(e.id), ['missingPanels']];
    }
    case 'textFrame': {
      const pageId = lookup.pageOfFrame(e.id);
      return [pageId ? qk.page(pageId) : ['page']];
    }
    case 'image':
      return [['panelImages'], ['characterImages']];
    case 'episodeRun':
      return [['episode']];
    case 'settings':
      return [qk.settings(), qk.status()];
  }
}

export function cacheLookup(qc: QueryClient): OwnerLookup {
  const details = (): PageDetail[] =>
    qc.getQueriesData<PageDetail>({ queryKey: ['page'] })
      .map(([, d]) => d)
      .filter((d): d is PageDetail => d !== undefined);
  return {
    pageOfPanel: (id) => details().find((d) => d.panels.some((p) => p.id === id))?.page.id ?? null,
    pageOfFrame: (id) => details().find((d) => d.frames.some((f) => f.id === id))?.page.id ?? null,
  };
}
