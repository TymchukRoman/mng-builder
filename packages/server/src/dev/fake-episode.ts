// packages/server/src/dev/fake-episode.ts
import {
  sameName,
  type BreakdownOutput, type DialogueKind, type OutlineOutput, type PanelScriptDraft, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import type { JsonRequest } from '../engines/types.js';
import {
  extractContext, type BreakdownContext, type OutlineContext, type PremiseContext, type PromptsContext, type ScriptsContext,
} from '../workflows/episode/context.js';

/** The one new character every fake outline introduces, unless the manga already has her. */
export const FAKE_NEW_CHARACTER = 'Mika';

const line = (speaker: string | null, kind: DialogueKind, text: string): PanelScriptDraft['dialogue'][number] => ({ speaker, kind, text });

function fakePanel(page: number, index: number, speaker: string | null, uk: boolean): PanelScriptDraft {
  return {
    action: uk ? 'Міка махає рукою' : 'Mika waves',
    shot: index === 0 ? 'wide' : 'medium',
    angle: 'eye',
    characters: speaker ? [{ name: speaker, pose: 'waving', expression: 'smiling', position: index % 2 === 0 ? 'left' : 'right' }] : [],
    background: uk ? 'вулиця біля порту' : 'harbour street',
    dialogue: [
      ...(page === 1 && index === 0 ? [line(null, 'narration', uk ? 'Осінь.' : 'Autumn.')] : []),
      ...(speaker ? [line(speaker, 'speech', uk ? `Привіт! (${page}.${index + 1})` : `Hello! (${page}.${index + 1})`)] : []),
    ],
  };
}

/**
 * Canned answers for MANGA_FAKES=1 and tests; each one reads the request's <context> block so it always fits.
 * scripts and prompts answer one CHUNK (F18): only the pages/panels the request offers, with absolute page numbers.
 */
export const EPISODE_FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'episode.premise': (req): PremiseOutput => {
    const c = extractContext<PremiseContext>(req.prompt);
    return c.language === 'uk'
      ? { title: 'Кіт під дощем', synopsis: `Коротка історія: ${c.request.prompt}`, tone: c.request.tone || 'лагідний', setting: 'Портове містечко восени, вечір' }
      : { title: 'The Cat in the Rain', synopsis: `A short story: ${c.request.prompt}`, tone: c.request.tone || 'gentle', setting: 'A harbour town in autumn, evening' };
  },

  'episode.outline': (req): OutlineOutput => {
    const c = extractContext<OutlineContext>(req.prompt);
    const existing = c.characters.find((ch) => sameName(ch.name, FAKE_NEW_CHARACTER));
    const lead = c.characters.find((ch) => !sameName(ch.name, FAKE_NEW_CHARACTER));
    const cast = [...(lead ? [lead.name] : []), existing?.name ?? FAKE_NEW_CHARACTER];
    return {
      scenes: [
        { summary: 'They meet in the rain.', purpose: 'setup', location: 'harbour street', characterNames: cast },
        { summary: 'They part as friends.', purpose: 'resolution', location: 'pier', characterNames: cast },
      ],
      newCharacters: existing ? [] : [{
        name: FAKE_NEW_CHARACTER, role: 'supporting', personality: 'cheerful', speechStyle: 'short sentences',
        appearanceTags: '1girl, long brown hair, green eyes, yellow raincoat',
      }],
    };
  },

  'episode.breakdown': (req): BreakdownOutput => {
    const c = extractContext<BreakdownContext>(req.prompt);
    const preset = c.presets.find((p) => p.panelCount === 2) ?? c.presets[0]!;
    return {
      pages: Array.from({ length: c.pages }, (_, i) => ({
        sceneIdx: [Math.min(i, c.scenes.length - 1)], panelCount: preset.panelCount, pacing: 'steady', layoutPreset: preset.name,
      })),
    };
  },

  'episode.scripts': (req): ScriptsOutput => {
    const c = extractContext<ScriptsContext>(req.prompt);
    const speaker = c.characters.find((ch) => sameName(ch.name, FAKE_NEW_CHARACTER))?.name ?? c.characters[0]?.name ?? null;
    const uk = c.language === 'uk';
    return { pages: c.pages.map((p) => ({ panels: Array.from({ length: p.panelCount }, (_, j) => fakePanel(p.page, j, speaker, uk)) })) };
  },

  'episode.prompts': (req): PromptsOutput => {
    const c = extractContext<PromptsContext>(req.prompt);
    return {
      panels: c.panels.map((p) => ({
        panelId: p.panelId,
        negative: undefined,
        scene: p.isCover
          ? '1girl, looking at viewer, smile, upper body, harbour, evening, cloudy sky'
          : `${p.characters.length > 0 ? '1girl' : 'no humans'}, upper body, waving, harbour street, evening`,
      })),
    };
  },
};
