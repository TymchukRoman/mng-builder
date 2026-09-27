import { openStore, type Store } from '../../src/store/index.js';
import { tempDir } from './tmp.js';

export interface TestLibrary { dir: string; store: Store; close(): void }

export function openTestLibrary(): TestLibrary {
  const temp = tempDir('manga-m2-');
  const store = openStore(temp.path);
  return {
    dir: temp.path,
    store,
    close(): void {
      store.close();
      temp.cleanup();
    },
  };
}
