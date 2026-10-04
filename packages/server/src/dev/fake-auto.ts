// packages/server/src/dev/fake-auto.ts
import type { AuditAnswer, CheckAnswer, DirectiveDraft, DirectiveKind, ExtractAnswer, MangaPlanAnswer, PlanCoverage } from '@manga/shared';
import type { JsonRequest } from '../engines/types.js';
import type { ExtractContext } from '../workflows/brief/analyze.js';
import type { PlanContext } from '../workflows/auto/plan.js';
import { extractContext } from '../workflows/episode/context.js';

/** A guess at what kind of detail a sentence is, from its words (the real model reads the sentence; this only has to be stable). */
export function fakeKind(text: string): DirectiveKind {
  if (/\b(art|style|drawn|lineart|shading|simplistic|watercolou?r)\b|прост/i.test(text)) return 'visual';
  if (/\b(dialogue|talk|speak|say)\b/i.test(text)) return 'dialogue';
  if (/^\s*(no|never|avoid|without)\b/i.test(text)) return 'avoid';
  if (/^\s*keep\b/i.test(text)) return 'other';
  if (/\b(chapter|page|panel|ending|cliffhanger)\b/i.test(text)) return 'structure';
  if (/\b(has|wears|with)\b.*\b(eye|scarf|hair|coat)\b/i.test(text)) return 'character';
  return 'plot';
}

/** One directive per numbered sentence, its text the sentence itself; a look gets tags. */
export function fakeDrafts(segments: ReadonlyArray<{ n: number; text: string }>): DirectiveDraft[] {
  return segments.map((s) => {
    const kind = fakeKind(s.text);
    return {
      text: s.text, kind, chapters: [], must: true, quote: s.text, sources: [s.n],
      tags: kind === 'visual' ? (/simpl|прост/i.test(s.text) ? 'simple background, minimal shading' : 'clean lineart') : '',
    };
  });
}

/** Canned answers for MANGA_FAKES=1 and tests: the reading passes, the series plan and its check. Each reads the request's <context>. */
export const AUTO_FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'brief.extract': (req): ExtractAnswer => ({ directives: fakeDrafts(extractContext<ExtractContext>(req.prompt).segments) }),
  'brief.audit': (): AuditAnswer => ({ missing: [] }),
  'manga.plan-audit': (): CheckAnswer => ({ unmet: [] }),
  'episode.scripts-audit': (): CheckAnswer => ({ unmet: [] }),

  'manga.plan': (req): MangaPlanAnswer => {
    const c = extractContext<PlanContext>(req.prompt);
    const uk = c.language === 'uk';
    const coverage: PlanCoverage[] = c.directives.map((d) => (
      d.kind === 'character' ? { id: d.id, where: 'cast', chapters: [] }
        : d.kind === 'visual' ? { id: d.id, where: 'style', chapters: [] }
          : d.kind === 'plot' || d.kind === 'setting' || d.kind === 'structure' ? { id: d.id, where: 'chapters', chapters: d.chapters.length > 0 ? d.chapters : [1] }
            : { id: d.id, where: 'notes', chapters: [] }));
    return {
      title: c.manga.title !== '' ? c.manga.title : uk ? 'Портові історії' : 'Harbour Tales',
      synopsis: uk ? `Серія про двох друзів у портовому місті: ${c.request.brief}` : `A series about two friends in a harbour town: ${c.request.brief}`,
      tone: uk ? 'лагідний' : 'gentle',
      notes: uk ? 'Короткі репліки.' : 'Keep the dialogue short.',
      styleTags: '',
      negativeTags: '',
      characters: [
        { name: 'Aiko', role: 'main', personality: uk ? 'допитлива' : 'curious', speechStyle: uk ? 'жваво' : 'lively', appearanceTags: '1girl, short black hair, brown eyes, school uniform' },
        { name: 'Ren', role: 'main', personality: uk ? 'спокійний' : 'calm', speechStyle: uk ? 'коротко' : 'terse', appearanceTags: '1boy, short brown hair, green eyes, jacket' },
      ],
      chapters: Array.from({ length: c.request.chapters }, (_, i) => ({
        title: uk ? `Розділ ${i + 1}` : `Part ${i + 1}`,
        synopsis: uk ? `Що сталося в частині ${i + 1}.` : `What happens in part ${i + 1}.`,
        plot: uk ? `Айко та Рен переживають подію ${i + 1}.` : `Aiko and Ren live through event ${i + 1}.`,
      })),
      poster: { action: uk ? 'Айко і Рен стоять на причалі.' : 'Aiko and Ren stand on the pier.', background: uk ? 'причал на заході сонця' : 'pier at sunset' },
      coverage,
    };
  },
};
