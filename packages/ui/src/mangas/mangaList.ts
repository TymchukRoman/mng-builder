import { DEFAULT_PAGE_FORMAT, type ColorMode, type Manga, type StylePreset } from '@manga/shared';
import { pageSizePx } from '../page/geometry';

/** Cover thumbnail width in px; the "new manga" card takes the height of a cover of this width. */
export const COVER_W = 150;
export const COVER_H = pageSizePx(DEFAULT_PAGE_FORMAT, COVER_W).h;

/** The preset the Create Manga modal starts on (the server's first preset). */
export const DEFAULT_PRESET_ID = 'manga-bw';

export function sortMangas(list: readonly Manga[] | undefined): Manga[] {
  return [...(list ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

type PresetOption = Pick<StylePreset, 'id' | 'label' | 'colorMode'>;

/** The presets to offer: the loaded ones, or just the default while they load. */
export function presetOptions(presets: readonly StylePreset[] | undefined): readonly PresetOption[] {
  return presets ?? [{ id: DEFAULT_PRESET_ID, label: DEFAULT_PRESET_ID, colorMode: 'bw' }];
}

/** A preset's own colour mode, or null when the preset is unknown (or not loaded yet). */
export function presetColorMode(presets: readonly StylePreset[] | undefined, id: string): ColorMode | null {
  return presets?.find((p) => p.id === id)?.colorMode ?? null;
}
