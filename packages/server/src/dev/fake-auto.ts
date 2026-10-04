// packages/server/src/dev/fake-auto.ts
import type { MangaPlan } from '@manga/shared';
import type { JsonRequest } from '../engines/types.js';
import { extractContext } from '../workflows/episode/context.js';
import type { PlanContext } from '../workflows/auto/plan.js';

/** Canned series plan for MANGA_FAKES=1 and tests: reads the request's <context>, so the chapter count always fits. */
export const AUTO_FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'manga.plan': (req): MangaPlan => {
    const c = extractContext<PlanContext>(req.prompt);
    const uk = c.language === 'uk';
    const simple = /simpl|прост/i.test(c.request.brief);
    return {
      title: c.manga.title !== '' ? c.manga.title : uk ? 'Портові історії' : 'Harbour Tales',
      synopsis: uk ? `Серія про двох друзів у портовому місті: ${c.request.brief}` : `A series about two friends in a harbour town: ${c.request.brief}`,
      tone: uk ? 'лагідний' : 'gentle',
      notes: uk ? 'Короткі репліки.' : 'Keep the dialogue short.',
      styleTags: simple ? 'simple background, minimal shading' : '',
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
    };
  },
};
