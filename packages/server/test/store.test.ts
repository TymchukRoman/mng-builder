import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, STYLE_PRESETS, type Manga } from '@manga/shared';
import { NotFoundError, StoreCorruptError } from '../src/errors.js';
import { openDatabase, schemaVersion, type Db } from '../src/store/db.js';
import { createEntityRepos, type EntityRepos } from '../src/store/entities.js';
import { createLibraryFiles } from '../src/store/files.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

let dir: TempDir;
let db: Db;
let repos: EntityRepos;

beforeEach(() => {
  dir = tempDir();
  db = openDatabase(join(dir.path, 'library.sqlite'));
  repos = createEntityRepos(db, () => new Date().toISOString());
});
afterEach(() => {
  db.close();
  dir.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function seedManga(title = 'Oni'): Manga {
  return repos.mangas.create({
    title, synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']!.styleGuide, coverPageId: null,
  });
}

function seedPage(mangaId: string, chapterId: string | null, panelId = 'pn_aaaaaaaaaa') {
  const page = repos.pages.create({ mangaId, chapterId, kind: 'page', order: 0, layout: { type: 'panel', id: panelId } });
  const panel = repos.panels.create({
    id: panelId, pageId: page.id, script: EMPTY_SCRIPT, prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: 7, refCharacterIds: [], activeImageId: null, imageTransform: { x: 0, y: 0, scale: 1 },
  });
  return { page, panel };
}

function seedCharacter(mangaId: string) {
  return repos.characters.create({ mangaId, name: 'Aiko', role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl', seed: 1, recipe: null, refs: {} });
}

function seedImage(mangaId: string, ownerId: string) {
  return repos.images.create({
    mangaId, ownerType: 'panel', ownerId, role: null, path: `mangas/${mangaId}/images/x.png`,
    width: 10, height: 10, source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}

describe('database', () => {
  it('runs in WAL mode with foreign keys on, at the latest schema version', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(schemaVersion(db)).toBe(2);
  });

  it('migrates idempotently when reopened', () => {
    db.close();
    db = openDatabase(join(dir.path, 'library.sqlite'));
    expect(schemaVersion(db)).toBe(2);
  });
});

describe('entity repos', () => {
  it('assigns prefixed ids and timestamps and round-trips JSON columns', () => {
    const m = seedManga();
    expect(m.id).toMatch(/^mg_[a-z2-7]{10}$/);
    expect(m.createdAt).toBe(m.updatedAt);
    expect(repos.mangas.get(m.id)).toEqual(m);
    expect(repos.mangas.list()).toEqual([m]);
  });

  it('uses a caller-supplied id (panels are keyed by their layout leaf)', () => {
    const m = seedManga();
    expect(seedPage(m.id, null, 'pn_leafleaf1').panel.id).toBe('pn_leafleaf1');
  });

  it('updates only the given fields and bumps updatedAt', async () => {
    const m = seedManga();
    await sleep(5);
    const u = repos.mangas.update(m.id, { title: 'Renamed' });
    expect(u).toMatchObject({ title: 'Renamed', synopsis: m.synopsis, createdAt: m.createdAt });
    expect(u.updatedAt > m.updatedAt).toBe(true);
    expect(repos.mangas.require(m.id)).toEqual(u);
  });

  it('validates on write', () => {
    const m = seedManga();
    expect(() => repos.mangas.update(m.id, { title: '' })).toThrow();
    expect(repos.mangas.require(m.id).title).toBe('Oni');
  });

  it('throws NotFoundError from require, update and delete of a missing id', () => {
    expect(repos.mangas.get('mg_missing000')).toBeNull();
    expect(() => repos.mangas.require('mg_missing000')).toThrow(NotFoundError);
    expect(() => repos.mangas.update('mg_missing000', { title: 'x' })).toThrow(NotFoundError);
    expect(() => repos.mangas.delete('mg_missing000')).toThrow(NotFoundError);
  });

  it('validates JSON columns with zod on read', () => {
    const m = seedManga();
    const { page } = seedPage(m.id, null);
    const raw = new Database(join(dir.path, 'library.sqlite'));
    raw.prepare('UPDATE pages SET layout = ? WHERE id = ?').run('{"type":"bogus"}', page.id);
    raw.prepare('UPDATE mangas SET style_guide = ? WHERE id = ?').run('not json', m.id);
    raw.close();
    expect(() => repos.pages.get(page.id)).toThrow(StoreCorruptError);
    expect(() => repos.mangas.get(m.id)).toThrow(StoreCorruptError);
  });

  it('lists children in order', () => {
    const m = seedManga();
    const two = repos.chapters.create({ mangaId: m.id, number: 2, title: 'Two', synopsis: '', coverPageId: null, status: 'draft', order: 1 });
    const one = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    expect(repos.chapters.listByManga(m.id).map((c) => c.id)).toEqual([one.id, two.id]);
  });

  it('stores booleans and nullable JSON', () => {
    const m = seedManga();
    const { page, panel } = seedPage(m.id, null);
    expect(repos.panels.update(panel.id, { seedLock: true }).seedLock).toBe(true);
    expect(repos.panels.require(panel.id).seedLock).toBe(true);
    const f = repos.frames.create({
      pageId: page.id, panelId: panel.id, kind: 'speech', text: 'hi', speakerId: null,
      box: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 }, tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
    });
    expect(repos.frames.get(f.id)).toEqual(f);
    expect(repos.frames.update(f.id, { tail: { x: 0.5, y: 0.6 } }).tail).toEqual({ x: 0.5, y: 0.6 });
  });

  it('finds images by owner and by manga, and the latest episode run of a chapter', () => {
    const m = seedManga();
    const { panel } = seedPage(m.id, null);
    const image = seedImage(m.id, panel.id);
    expect(repos.images.listByOwner('panel', panel.id)).toEqual([image]);
    expect(repos.images.listByManga(m.id)).toEqual([image]);
    expect(repos.images.update(image.id, { ownerId: 'pn_other00000' }).ownerId).toBe('pn_other00000');
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    const input = { prompt: 'a heist', characterIds: [], pages: 8, tone: '' };
    repos.episodes.create({ chapterId: ch.id, input, mode: 'review', steps: [], currentStep: 0, status: 'running' });
    const second = repos.episodes.create({ chapterId: ch.id, input, mode: 'autopilot', steps: [], currentStep: 0, status: 'running' });
    expect(repos.episodes.latestByChapter(ch.id)?.id).toBe(second.id);
    expect(repos.pages.listByManga(m.id)).toHaveLength(1);
  });
});

describe('foreign keys', () => {
  it('cascade a manga delete to everything under it', () => {
    const m = seedManga();
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    const { page, panel } = seedPage(m.id, ch.id);
    const cr = seedCharacter(m.id);
    const image = seedImage(m.id, panel.id);
    repos.mangas.delete(m.id);
    expect([
      repos.chapters.get(ch.id), repos.pages.get(page.id), repos.panels.get(panel.id), repos.characters.get(cr.id), repos.images.get(image.id),
    ]).toEqual([null, null, null, null, null]);
  });

  it('clear pointers instead of failing: active image, speaker, frame anchor, cover page', () => {
    const m = seedManga();
    const { page, panel } = seedPage(m.id, null);
    const cr = seedCharacter(m.id);
    const image = seedImage(m.id, panel.id);
    repos.panels.update(panel.id, { activeImageId: image.id });
    repos.mangas.update(m.id, { coverPageId: page.id });
    const f = repos.frames.create({
      pageId: page.id, panelId: panel.id, kind: 'speech', text: 'hi', speakerId: cr.id,
      box: { x: 0, y: 0, w: 0.3, h: 0.1 }, tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
    });
    repos.images.delete(image.id);
    expect(repos.panels.require(panel.id).activeImageId).toBeNull();
    repos.characters.delete(cr.id);
    expect(repos.frames.require(f.id).speakerId).toBeNull();
    repos.panels.delete(panel.id);
    expect(repos.frames.require(f.id).panelId).toBeNull();
    repos.pages.delete(page.id);
    expect(repos.mangas.require(m.id).coverPageId).toBeNull();
    expect(repos.frames.get(f.id)).toBeNull();
  });
});

describe('library files', () => {
  it('writes images under mangas/<mangaId>/images and removes them', () => {
    const files = createLibraryFiles(dir.path);
    const rel = files.writeImage('mg_a', 'im_b', new Uint8Array([1, 2, 3]));
    expect(rel).toBe('mangas/mg_a/images/im_b.png');
    expect(files.imageRel('mg_a', 'im_b')).toBe(rel);
    expect(readFileSync(files.abs(rel))).toEqual(Buffer.from([1, 2, 3]));
    files.remove(rel);
    files.remove(rel); // missing is fine
    expect(existsSync(files.abs(rel))).toBe(false);
    files.writeImage('mg_a', 'im_c', new Uint8Array([1]));
    files.removeMangaDir('mg_a');
    expect(existsSync(join(dir.path, 'mangas', 'mg_a'))).toBe(false);
  });

  it('creates tmp, .claude-cwd and exports on demand and refuses paths outside the library', () => {
    const files = createLibraryFiles(dir.path);
    expect(existsSync(files.tmpDir())).toBe(true);
    expect(files.claudeCwd()).toBe(join(dir.path, '.claude-cwd'));
    expect(existsSync(files.claudeCwd())).toBe(true);
    expect(existsSync(files.exportsDir())).toBe(true);
    expect(() => files.abs('../outside.png')).toThrow(/outside the library/);
    expect(() => files.abs('')).toThrow(/outside the library/);
  });
});

describe('migration 2 (W1 Q1: chapters.summary)', () => {
  it('adds an empty summary to chapters written before it', () => {
    db.close();
    const file = join(dir.path, 'old.sqlite');
    const old = new Database(file);
    old.exec(MIGRATIONS[0]!.sql);
    old.pragma('user_version = 1');
    old.prepare(`INSERT INTO mangas VALUES ('mg_aaaaaaaaaa','M','','en','bw','rtl','{}','{}',NULL,'t','t')`).run();
    old.prepare(`INSERT INTO chapters VALUES ('ch_aaaaaaaaaa','mg_aaaaaaaaaa',1,'One','',NULL,'draft',0,'t','t')`).run();
    old.close();
    db = openDatabase(file);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare(`SELECT summary FROM chapters WHERE id = 'ch_aaaaaaaaaa'`).get()).toEqual({ summary: '' });
  });

  it('round-trips a summary; a chapter created without one has ""', () => {
    const m = seedManga();
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    expect(ch.summary).toBe('');
    expect(repos.chapters.update(ch.id, { summary: 'Aiko found the cat.' }).summary).toBe('Aiko found the cat.');
    expect(repos.chapters.require(ch.id).summary).toBe('Aiko found the cat.');
  });
});
