import { useSyncExternalStore } from 'react';
import { createStore, useStore } from './lib/store';

export type ThemeName = 'light' | 'dark';
export const THEME_KEY = 'manga-builder.theme';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
/** A getter, because merely touching `window.localStorage` can throw when site data is blocked. */
export type StorageGetter = () => StorageLike | undefined;

export function readStoredTheme(storage: StorageGetter): ThemeName | null {
  try {
    const v = storage()?.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function storeTheme(storage: StorageGetter, theme: ThemeName): void {
  try {
    storage()?.setItem(THEME_KEY, theme);
  } catch {
    // Storage is a convenience: without it the theme simply follows the system next time.
  }
}

export function effectiveTheme(stored: ThemeName | null, systemDark: boolean): ThemeName {
  return stored ?? (systemDark ? 'dark' : 'light');
}

export function toggled(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

/** `data-theme` is set only when the user has chosen; its absence means "follow the system". */
export function applyTheme(root: { dataset: Record<string, string | undefined> }, stored: ThemeName | null): void {
  if (stored) root.dataset.theme = stored;
  else delete root.dataset.theme;
}

const browserStorage: StorageGetter = () => window.localStorage;
const themeStore = createStore<ThemeName | null>(null);
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function initTheme(): void {
  const stored = readStoredTheme(browserStorage);
  themeStore.set(stored);
  applyTheme(document.documentElement, stored);
}

function subscribeSystem(fn: () => void): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}

function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

export function useTheme(): { theme: ThemeName; toggle(): void } {
  const stored = useStore(themeStore);
  const dark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  const theme = effectiveTheme(stored, dark);
  return {
    theme,
    toggle() {
      const next = toggled(theme);
      storeTheme(browserStorage, next);
      themeStore.set(next);
      applyTheme(document.documentElement, next);
    },
  };
}
