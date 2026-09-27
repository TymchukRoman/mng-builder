import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { LibraryFiles } from './types.js';

/** Files under the library folder. Relative paths always use '/' so they are portable in the database. */
export function createLibraryFiles(root: string): LibraryFiles {
  const base = resolve(root);
  const ensureDir = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const abs = (rel: string): string => {
    const full = resolve(base, ...rel.split('/'));
    const back = relative(base, full);
    if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error(`path "${rel}" is outside the library`);
    return full;
  };
  const imageRel = (mangaId: string, imageId: string): string => `mangas/${mangaId}/images/${imageId}.png`;

  return {
    root: base,
    imageRel,
    abs,
    writeImage(mangaId, imageId, data) {
      const rel = imageRel(mangaId, imageId);
      const file = abs(rel);
      ensureDir(dirname(file));
      writeFileSync(file, data);
      return rel;
    },
    remove(rel) {
      rmSync(abs(rel), { force: true });
    },
    removeMangaDir(mangaId) {
      rmSync(abs(`mangas/${mangaId}`), { recursive: true, force: true });
    },
    tmpDir: () => ensureDir(join(base, 'tmp')),
    claudeCwd: () => ensureDir(join(base, '.claude-cwd')),
    exportsDir: () => ensureDir(join(base, 'exports')),
  };
}
