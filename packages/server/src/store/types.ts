import type {
  AutoRun, Chapter, Character, EpisodeRun, Image, Job, JobKind, JobStatus, Lane, Manga, Page, Panel, Settings, SettingsPatch, TextFrame,
} from '@manga/shared';

/** The entity minus id/timestamps. The repo assigns a fresh id unless one is supplied (panel ids come from layout leaves; image ids name their file). */
type NewEntity<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
/** `imageModel` defaults to null (the routing of Settings), so creators that predate it need not pass it. */
export type NewManga = Omit<NewEntity<Manga>, 'imageModel'> & { imageModel?: string | null };
export type NewCharacter = NewEntity<Character>;
/** `summary` defaults to '' (W1 Q1), so creators that predate it need not pass it. */
export type NewChapter = Omit<NewEntity<Chapter>, 'summary' | 'imageModel'> & { summary?: string; imageModel?: string | null };
export type NewPage = NewEntity<Page>;
export type NewPanel = NewEntity<Panel>;
export type NewFrame = NewEntity<TextFrame>;
export type NewImage = NewEntity<Image>;
export type NewEpisodeRun = NewEntity<EpisodeRun>;
export type NewAutoRun = NewEntity<AutoRun>;

export type MangaPatch = Partial<Omit<Manga, 'id' | 'createdAt'>>;
export type CharacterPatch = Partial<Omit<Character, 'id' | 'mangaId' | 'createdAt'>>;
export type ChapterPatch = Partial<Omit<Chapter, 'id' | 'mangaId' | 'createdAt'>>;
export type PagePatch = Partial<Omit<Page, 'id' | 'mangaId' | 'createdAt'>>;
export type PanelPatch = Partial<Omit<Panel, 'id' | 'pageId' | 'createdAt'>>;
export type FramePatch = Partial<Omit<TextFrame, 'id' | 'pageId' | 'createdAt'>>;
/** `ownerId` is patchable so a merge can move variants to the kept panel. */
export type ImagePatch = Partial<Pick<Image, 'review' | 'ownerId'>>;
/** Gallery filters: every field optional, all combined with AND. */
export interface ImageFilter { mangaId?: string; ownerType?: Image['ownerType']; source?: Image['source'] }
/** A keyset position in the newest-first order (`created_at DESC, rowid DESC`): rows strictly after it are returned. */
export interface ImageCursor { createdAt: string; rowid: number }
export interface ImagePageQuery extends ImageFilter { limit: number; before?: ImageCursor }
/** An image with its table rowid (the tiebreak of the newest-first order, needed to build the next cursor). */
export interface ImageRow { image: Image; rowid: number }
export type EpisodePatch = Partial<Omit<EpisodeRun, 'id' | 'chapterId' | 'createdAt'>>;
export type AutoRunPatch = Partial<Omit<AutoRun, 'id' | 'mangaId' | 'createdAt'>>;
export type JobInsert = Omit<Job, 'id' | 'createdAt' | 'startedAt' | 'finishedAt' | 'result' | 'error' | 'attempts' | 'progress' | 'status'>;
export type JobPatch = Partial<Omit<Job, 'id' | 'createdAt'>>;

export interface Repo<T, C, U> { get(id: string): T | null; require(id: string): T /* throws NotFoundError */; create(input: C): T; update(id: string, patch: U): T; delete(id: string): void }

export interface JobRepo {
  get(id: string): Job | null; require(id: string): Job;
  insert(input: JobInsert): Job;
  update(id: string, patch: JobPatch): Job;
  list(filter: { status?: JobStatus; limit: number }): Job[];
  /** Queued jobs of these kinds, oldest first (engine switch re-lane, I1). */
  listQueued(kinds: readonly JobKind[]): Job[];
  /** Every job of one episode run, oldest first, whatever its status (F11: the render driver adopts them after a restart). */
  listByEpisodeRun(runId: string): Job[];
  /** Queued and running jobs of these kinds in `lane`, oldest first; no limit, read through the lane/status index (W1 Task 5 M3). */
  listUnfinished(lane: Lane, kinds: readonly JobKind[]): Job[];
  /** Atomically marks the highest-priority, oldest due queued job in `lane` as running (attempts + 1); null if none. */
  claimNext(lane: Lane, nowIso: string): Job | null;
  /** On boot: running → queued. Returns count. */
  resetRunning(): number;
  counts(): { queued: number; running: number };
}

export interface SettingsRepo { get(): Settings; patch(p: SettingsPatch): Settings }

export interface LibraryFiles {
  root: string;
  imageRel(mangaId: string, imageId: string): string;   // 'mangas/<mangaId>/images/<imageId>.png'
  abs(rel: string): string;
  writeImage(mangaId: string, imageId: string, data: Uint8Array): string; // returns rel
  remove(rel: string): void;                            // ignores missing
  removeMangaDir(mangaId: string): void;
  tmpDir(): string; claudeCwd(): string; exportsDir(): string;
}

export interface Store {
  mangas: Repo<Manga, NewManga, MangaPatch> & { list(): Manga[] };
  characters: Repo<Character, NewCharacter, CharacterPatch> & { listByManga(mangaId: string): Character[] };
  chapters: Repo<Chapter, NewChapter, ChapterPatch> & { listByManga(mangaId: string): Chapter[] };
  pages: Repo<Page, NewPage, PagePatch> & { listByChapter(chapterId: string): Page[]; listByManga(mangaId: string): Page[] };
  panels: Repo<Panel, NewPanel, PanelPatch> & { listByPage(pageId: string): Panel[] };
  frames: Repo<TextFrame, NewFrame, FramePatch> & { listByPage(pageId: string): TextFrame[] };
  images: Repo<Image, NewImage, ImagePatch> & { listByOwner(ownerType: Image['ownerType'], ownerId: string): Image[]; listByManga(mangaId: string): Image[]; listPage(query: ImagePageQuery): ImageRow[]; count(filter: ImageFilter): number };
  jobs: JobRepo;
  episodes: Repo<EpisodeRun, NewEpisodeRun, EpisodePatch> & { latestByChapter(chapterId: string): EpisodeRun | null; listByChapter(chapterId: string): EpisodeRun[] };
  autoRuns: Repo<AutoRun, NewAutoRun, AutoRunPatch> & { latestByManga(mangaId: string): AutoRun | null; listByStatus(status: AutoRun['status']): AutoRun[] };
  settings: SettingsRepo;
  files: LibraryFiles;
  tx<T>(fn: () => T): T;
  close(): void;
}
