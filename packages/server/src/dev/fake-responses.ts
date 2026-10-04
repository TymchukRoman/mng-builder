import type { JsonRequest } from '../engines/types.js';
import { AUTO_FAKE_RESPONSES } from './fake-auto.js';
import { EPISODE_FAKE_RESPONSES } from './fake-episode.js';

/** Canned answers for MANGA_FAKES=1 and tests, keyed by JsonRequest.name. The 'episode.*' entries live in fake-episode.ts. */
export const FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'panel-prompt': () => ({ scene: 'solo, standing, school rooftop, chain-link fence, sunset, wind' }),
  appearance: () => ({ appearanceTags: '1girl, silver hair, long hair, twintails, amber eyes, red scarf, school uniform, pleated skirt' }),
  review: () => ({ pass: true, issues: [] }),
  ...EPISODE_FAKE_RESPONSES,
  ...AUTO_FAKE_RESPONSES,
};
