import type { Chapter, LoraRef, Manga, PageFormat } from '@manga/shared';

export function sortChapters(list: readonly Chapter[] | undefined): Chapter[] {
  return [...(list ?? [])].sort((a, b) => a.order - b.order || a.number - b.number);
}

export function validLoras(draft: readonly LoraRef[]): LoraRef[] {
  return draft.map((l) => ({ name: l.name.trim(), strength: l.strength })).filter((l) => l.name.length > 0);
}

export function mangaBadges(m: Manga): Array<{ text: string; tip: string }> {
  return [
    m.language === 'uk' ? { text: 'UK', tip: 'Ukrainian' } : { text: 'EN', tip: 'English' },
    m.colorMode === 'color' ? { text: 'Colour', tip: 'Colour pages' } : { text: 'B&W', tip: 'Black and white with screentone' },
    m.readingDirection === 'ltr' ? { text: 'LTR', tip: 'Reads left to right' } : { text: 'RTL', tip: 'Reads right to left' },
  ];
}

/** Page size and resolution are fixed (spec §2: B5 at 300 dpi), so the settings drawer only shows them. */
export function pageSizeLabel(pf: PageFormat): string {
  return `${pf.widthMm} × ${pf.heightMm} mm · ${pf.dpi} dpi`;
}
