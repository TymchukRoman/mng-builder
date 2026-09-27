import {
  ChapterSchema, CharacterSchema, EpisodeRunSchema, ImageSchema, MangaSchema, PageSchema, PanelSchema, TextFrameSchema,
  type Chapter, type Character, type EpisodeRun, type Image, type Manga, type Page, type Panel, type TextFrame,
} from '@manga/shared';
import type { Db } from './db.js';
import { TableRepo } from './table.js';
import type {
  ChapterPatch, CharacterPatch, EpisodePatch, FramePatch, ImagePatch, MangaPatch, NewChapter, NewCharacter,
  NewEpisodeRun, NewFrame, NewImage, NewManga, NewPage, NewPanel, PagePatch, PanelPatch,
} from './types.js';

const TIMESTAMPS = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;

export class MangaRepo extends TableRepo<Manga, NewManga, MangaPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'mangas', entity: 'manga', prefix: 'mg', schema: MangaSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', title: 'title', synopsis: 'synopsis', language: 'language', colorMode: 'color_mode',
        readingDirection: 'reading_direction', pageFormat: ['page_format', 'json'], styleGuide: ['style_guide', 'json'],
        coverPageId: 'cover_page_id', ...TIMESTAMPS,
      },
    }, now);
  }

  list(): Manga[] {
    return this.listWhere('1 = 1');
  }
}

export class CharacterRepo extends TableRepo<Character, NewCharacter, CharacterPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'characters', entity: 'character', prefix: 'cr', schema: CharacterSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', name: 'name', role: 'role', personality: 'personality', speechStyle: 'speech_style',
        appearanceTags: 'appearance_tags', seed: 'seed', recipe: 'recipe', refs: ['refs', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  listByManga(mangaId: string): Character[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class ChapterRepo extends TableRepo<Chapter, NewChapter, ChapterPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'chapters', entity: 'chapter', prefix: 'ch', schema: ChapterSchema, hasUpdatedAt: true, orderBy: 'ord, number, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', number: 'number', title: 'title', synopsis: 'synopsis',
        coverPageId: 'cover_page_id', status: 'status', order: 'ord', ...TIMESTAMPS,
      },
    }, now);
  }

  listByManga(mangaId: string): Chapter[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class PageRepo extends TableRepo<Page, NewPage, PagePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'pages', entity: 'page', prefix: 'pg', schema: PageSchema, hasUpdatedAt: true, orderBy: 'ord, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', chapterId: 'chapter_id', kind: 'kind', order: 'ord', layout: ['layout', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  /** Every page of the chapter, including its cover, by order. */
  listByChapter(chapterId: string): Page[] {
    return this.listWhere('chapter_id = ?', chapterId);
  }

  listByManga(mangaId: string): Page[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class PanelRepo extends TableRepo<Panel, NewPanel, PanelPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'panels', entity: 'panel', prefix: 'pn', schema: PanelSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', pageId: 'page_id', script: ['script', 'json'], prompt: ['prompt', 'json'], recipe: 'recipe',
        seedLock: ['seed_lock', 'bool'], seed: 'seed', refCharacterIds: ['ref_character_ids', 'json'],
        activeImageId: 'active_image_id', imageTransform: ['image_transform', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  listByPage(pageId: string): Panel[] {
    return this.listWhere('page_id = ?', pageId);
  }
}

export class FrameRepo extends TableRepo<TextFrame, NewFrame, FramePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'text_frames', entity: 'text frame', prefix: 'tf', schema: TextFrameSchema, hasUpdatedAt: true, orderBy: 'ord, rowid',
      columns: {
        id: 'id', pageId: 'page_id', panelId: 'panel_id', kind: 'kind', text: 'text', speakerId: 'speaker_id',
        box: ['box', 'json'], tail: ['tail', 'json'], rotation: 'rotation', font: 'font', fontSize: 'font_size',
        autoFit: ['auto_fit', 'bool'], align: 'align', order: 'ord', ...TIMESTAMPS,
      },
    }, now);
  }

  listByPage(pageId: string): TextFrame[] {
    return this.listWhere('page_id = ?', pageId);
  }
}

export class ImageRepo extends TableRepo<Image, NewImage, ImagePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'images', entity: 'image', prefix: 'im', schema: ImageSchema, hasUpdatedAt: false, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', ownerType: 'owner_type', ownerId: 'owner_id', role: 'role', path: 'path',
        width: 'width', height: 'height', source: 'source', parentImageId: 'parent_image_id',
        gen: ['gen', 'json'], review: ['review', 'json'], createdAt: 'created_at',
      },
    }, now);
  }

  listByOwner(ownerType: Image['ownerType'], ownerId: string): Image[] {
    return this.listWhere('owner_type = ? AND owner_id = ?', ownerType, ownerId);
  }

  listByManga(mangaId: string): Image[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class EpisodeRepo extends TableRepo<EpisodeRun, NewEpisodeRun, EpisodePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'episode_runs', entity: 'episode run', prefix: 'er', schema: EpisodeRunSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', chapterId: 'chapter_id', input: ['input', 'json'], mode: 'mode', steps: ['steps', 'json'],
        currentStep: 'current_step', status: 'status', ...TIMESTAMPS,
      },
    }, now);
  }

  latestByChapter(chapterId: string): EpisodeRun | null {
    return this.firstWhere('chapter_id = ?', 'created_at DESC, rowid DESC', chapterId);
  }
}

export interface EntityRepos {
  mangas: MangaRepo;
  characters: CharacterRepo;
  chapters: ChapterRepo;
  pages: PageRepo;
  panels: PanelRepo;
  frames: FrameRepo;
  images: ImageRepo;
  episodes: EpisodeRepo;
}

export function createEntityRepos(db: Db, now: () => string): EntityRepos {
  return {
    mangas: new MangaRepo(db, now),
    characters: new CharacterRepo(db, now),
    chapters: new ChapterRepo(db, now),
    pages: new PageRepo(db, now),
    panels: new PanelRepo(db, now),
    frames: new FrameRepo(db, now),
    images: new ImageRepo(db, now),
    episodes: new EpisodeRepo(db, now),
  };
}
