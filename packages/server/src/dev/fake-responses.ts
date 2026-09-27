import type { JsonRequest } from '../engines/types.js';

/** Canned answers for MANGA_FAKES=1 and tests, keyed by JsonRequest.name. M4 adds 'episode.*' entries. */
export const FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'panel-prompt': () => ({ scene: 'solo, standing, school rooftop, chain-link fence, sunset, wind' }),
  appearance: () => ({ appearanceTags: '1girl, silver hair, long hair, twintails, amber eyes, red scarf, school uniform, pleated skirt' }),
  review: () => ({ pass: true, issues: [] }),
};
