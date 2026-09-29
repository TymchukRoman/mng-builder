import { useQuery } from '@tanstack/react-query';
import type {
  AppConfig, Chapter, Character, Image, Job, Manga, Page, PageDetail, PresetInfo, RecipeInfo, ServiceStatus, Settings, StylePreset,
} from '@manga/shared';
import { api, seg } from './api';
import { qk } from './queryKeys';

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
  useQuery({ queryKey: qk.page(id ?? ''), queryFn: () => api.get<PageDetail>(`/api/pages/${seg(id)}`), enabled: !!id });
export const usePanelImages = (panelId: string | null) =>
  useQuery({ queryKey: qk.panelImages(panelId ?? ''), queryFn: () => api.get<Image[]>(`/api/panels/${seg(panelId)}/images`), enabled: !!panelId });
export const useJobs = () =>
  useQuery({ queryKey: qk.jobs(), queryFn: () => api.get<Job[]>('/api/jobs?limit=50'), refetchInterval: 30_000 });
export const useSettings = () => useQuery({ queryKey: qk.settings(), queryFn: () => api.get<Settings>('/api/settings') });
// F10: the server never emits `status` events (see events.ts), so this poll is the only thing that
// keeps the quota banner and status dot current. Its 30 s interval means the banner can lag reality
// by up to 30 s after ComfyUI/Ollama/Claude flips state; the `status` socket event is applied too,
// ready for when the server starts sending it.
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
