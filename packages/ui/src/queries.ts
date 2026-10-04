import { useQuery } from '@tanstack/react-query';
import type {
  AppConfig, AutoRun, Chapter, Character, EpisodeRun, Image, Job, Manga, MissingPanels, Page, PageDetail, PresetInfo, RecipeInfo, ServiceStatus, Settings, StylePreset,
} from '@manga/shared';
import { api, seg } from './api';
import { fetchableId, qk } from './queryKeys';

export const useMangas = () => useQuery({ queryKey: qk.mangas(), queryFn: () => api.get<Manga[]>('/api/mangas') });
export const useManga = (id: string | undefined) =>
  useQuery({ queryKey: qk.manga(id ?? ''), queryFn: () => api.get<Manga>(`/api/mangas/${seg(id)}`), enabled: !!id });
export const useCharacters = (mangaId: string | undefined) =>
  useQuery({ queryKey: qk.characters(mangaId ?? ''), queryFn: () => api.get<Character[]>(`/api/mangas/${seg(mangaId)}/characters`), enabled: !!mangaId });
export const useCharacter = (id: string | null) =>
  useQuery({ queryKey: qk.character(id ?? ''), queryFn: () => api.get<Character>(`/api/characters/${seg(id)}`), enabled: !!id });
export const useCharacterImages = (id: string | null) =>
  useQuery({ queryKey: qk.characterImages(id ?? ''), queryFn: () => api.get<Image[]>(`/api/characters/${seg(id)}/images`), enabled: !!id });
export const useChapters = (mangaId: string | undefined) =>
  useQuery({ queryKey: qk.chapters(mangaId ?? ''), queryFn: () => api.get<Chapter[]>(`/api/mangas/${seg(mangaId)}/chapters`), enabled: !!mangaId });
export const useChapter = (id: string | undefined) =>
  useQuery({ queryKey: qk.chapter(id ?? ''), queryFn: () => api.get<Chapter>(`/api/chapters/${seg(id)}`), enabled: !!id });
export const usePages = (chapterId: string | undefined) =>
  useQuery({ queryKey: qk.pages(chapterId ?? ''), queryFn: () => api.get<Page[]>(`/api/chapters/${seg(chapterId)}/pages`), enabled: !!chapterId });
export const usePageDetail = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.page(id ?? ''), queryFn: () => api.get<PageDetail>(`/api/pages/${seg(id)}`), enabled: fetchableId(id) });
export const usePanelImages = (panelId: string | null) =>
  useQuery({ queryKey: qk.panelImages(panelId ?? ''), queryFn: () => api.get<Image[]>(`/api/panels/${seg(panelId)}/images`), enabled: fetchableId(panelId) });
/** The chapter's latest episode run, or null. No polling: every `episodeRun` event invalidates `['episode']` (events.ts). */
export const useEpisode = (chapterId: string | undefined) =>
  useQuery({ queryKey: qk.episode(chapterId ?? ''), queryFn: () => api.get<EpisodeRun | null>(`/api/chapters/${seg(chapterId)}/episode`), enabled: !!chapterId });
/** W1 R1: the chapter's panels without an image. Every `panel` and `page` event invalidates `['missingPanels']`. */
export const useMissingPanels = (chapterId: string | undefined) =>
  useQuery({
    queryKey: qk.missingPanels(chapterId ?? ''),
    queryFn: () => api.get<MissingPanels>(`/api/chapters/${seg(chapterId)}/render-missing`),
    enabled: !!chapterId,
  });
/** The manga's latest auto run (made with "from a prompt"), or null. No polling: every `autoRun` event invalidates `['autoRun']`. */
export const useAutoRun = (mangaId: string | undefined) =>
  useQuery({ queryKey: qk.autoRun(mangaId ?? ''), queryFn: () => api.get<AutoRun | null>(`/api/mangas/${seg(mangaId)}/auto-run`), enabled: !!mangaId });
export const useJobs = () =>
  useQuery({ queryKey: qk.jobs(), queryFn: () => api.get<Job[]>('/api/jobs?limit=50'), refetchInterval: 30_000 });
export const useSettings = () => useQuery({ queryKey: qk.settings(), queryFn: () => api.get<Settings>('/api/settings') });
// F10: the server emits a `status` event when a lane pauses or resumes (W1 R2, api/system.ts), and events.ts applies it.
// Service state changes (ComfyUI/Ollama/Claude up or down) have no event, so this 30 s poll is the fallback that keeps
// the status dot and the banners current; they can lag reality by up to 30 s.
export const useStatus = () =>
  useQuery({ queryKey: qk.status(), queryFn: () => api.get<ServiceStatus>('/api/status'), refetchInterval: 30_000 });
export const useLayouts = () =>
  useQuery({ queryKey: qk.layouts(), queryFn: () => api.get<PresetInfo[]>('/api/layouts'), staleTime: Infinity });
export const useStylePresets = () =>
  useQuery({ queryKey: qk.stylePresets(), queryFn: () => api.get<StylePreset[]>('/api/style-presets'), staleTime: Infinity });
export const useRecipes = () =>
  useQuery({ queryKey: qk.recipes(), queryFn: () => api.get<RecipeInfo[]>('/api/recipes'), staleTime: 60_000 });

/**
 * Read-only app config. Deviation from the brief (G1): `GET /api/config` already exists
 * (packages/server/src/api/system.ts) and returns `AppConfig` from @manga/shared, not the "proposed
 * contract change C1" the brief assumed — that comment was stale, so this uses the real type instead
 * of a hand-rolled `PublicConfig` interface. On error, callers should render nothing (`retry: false`).
 */
export const useConfig = () =>
  useQuery({ queryKey: qk.config(), queryFn: () => api.get<AppConfig>('/api/config'), retry: false, staleTime: Infinity });
