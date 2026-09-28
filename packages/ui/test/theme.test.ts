import { describe, expect, it } from 'vitest';
import { THEME_KEY, applyTheme, effectiveTheme, readStoredTheme, storeTheme, toggled, type StorageLike } from '../src/theme';

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

const throwing: StorageLike = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

describe('theme', () => {
  it('reads only valid stored values', () => {
    expect(readStoredTheme(() => memory({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readStoredTheme(() => memory({ [THEME_KEY]: 'purple' }))).toBeNull();
    expect(readStoredTheme(() => memory())).toBeNull();
  });

  it('survives a throwing storage', () => {
    expect(readStoredTheme(() => throwing)).toBeNull();
    expect(() => storeTheme(() => throwing, 'dark')).not.toThrow();
    expect(readStoredTheme(() => { throw new Error('no localStorage'); })).toBeNull();
    expect(() => storeTheme(() => undefined, 'light')).not.toThrow();
  });

  it('stores under the documented key', () => {
    const m = memory();
    storeTheme(() => m, 'light');
    expect(m.data[THEME_KEY]).toBe('light');
  });

  it('follows the system until the user picks', () => {
    expect(effectiveTheme(null, true)).toBe('dark');
    expect(effectiveTheme(null, false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
  });

  it('toggles and applies', () => {
    expect(toggled('light')).toBe('dark');
    expect(toggled('dark')).toBe('light');
    const root = { dataset: {} as Record<string, string | undefined> };
    applyTheme(root, 'dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme(root, null);
    expect(root.dataset.theme).toBeUndefined();
  });
});
