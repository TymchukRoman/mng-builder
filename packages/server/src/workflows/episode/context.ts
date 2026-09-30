// packages/server/src/workflows/episode/context.ts
import {
  BreakdownOutputSchema, OutlineOutputSchema, PRESET_NAMES, PremiseOutputSchema, presetPanelCount,
  type BreakdownPage, type Character, type ColorMode, type EpisodeRun, type Language, type Manga, type OutlineScene, type Panel,
  type PremiseOutput, type PresetInfo, type Settings,
} from '@manga/shared';
import { orderRefs, refImages } from '../../handlers/context.js';
import { RECIPES } from '../../imaging/recipes/index.js';
import { promptStyleFor, routeRecipe, type PromptStyle } from '../../imaging/route.js';
import { cameraWording } from '../../prompts/camera.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';
import { requireOutput, type LlmStepName } from './steps.js';

export const LANGUAGE_NAME: Record<Language, string> = { en: 'English', uk: 'Ukrainian' };

export interface CharacterBrief { name: string; role: string; personality: string; speechStyle: string }
export interface PremiseContext {
  step: 'premise'; language: Language; manga: { title: string; synopsis: string };
  request: { prompt: string; tone: string; pages: number }; characters: CharacterBrief[];
}
export interface OutlineContext { step: 'outline'; language: Language; pages: number; premise: PremiseOutput; characters: CharacterBrief[] }
export interface BreakdownContext {
  step: 'breakdown'; pages: number; scenes: Array<{ idx: number; summary: string; purpose: string; location: string }>; presets: PresetInfo[];
}
/** `pages` are the pages to write: all of them, or one chunk (F18); `pageRange` says which part of the chapter they are. */
export interface ScriptsContext {
  step: 'scripts'; language: Language; premise: PremiseOutput; scenes: Array<OutlineScene & { idx: number }>;
  pages: Array<BreakdownPage & { page: number }>; pageRange: { first: number; last: number; total: number }; characters: CharacterBrief[];
}
/**
 * F2 (I2): no shot/angle enums, only the readable `camera` wording, because the code adds the framing itself.
 * F3: `style` follows the recipe the panel will route to; natural panels list their reference pictures.
 */
export interface PromptsPanelBrief {
  panelId: string; page: number; isCover: boolean; style: PromptStyle; pictures?: string[]; camera: string; action: string; background: string;
  characters: Array<{ name: string; pose: string; expression: string; position: string }>;
}
/** `panels` are the panels to write: the whole chapter, or one page of it (F18). */
export interface PromptsContext {
  step: 'prompts'; colorMode: ColorMode; premise: { title: string; setting: string; tone: string }; panels: PromptsPanelBrief[];
}
export type StepContext = PremiseContext | OutlineContext | BreakdownContext | ScriptsContext | PromptsContext;

/** Never includes appearanceTags: the story model must not rewrite a character's look (spec §6.3). */
const brief = (c: Character): CharacterBrief => ({ name: c.name, role: c.role, personality: c.personality, speechStyle: c.speechStyle });

/** Stands in for a portrait that is not rendered yet: ensurePortraits and the review gate provide one before render (F3). */
const ASSUMED_PORTRAIT = 'assumed-portrait';

/**
 * F3: the style of the recipe the panel will route to at render time. Every cast member (the panel's
 * refCharacterIds) is assumed to have a portrait by then, so routing already counts them as references.
 */
function panelStyle(store: Store, settings: Settings, manga: Manga, panel: Panel): Pick<PromptsPanelBrief, 'style' | 'pictures'> {
  const cast = panel.refCharacterIds
    .map((id) => store.characters.get(id))
    .filter((c): c is Character => c !== null && c.mangaId === manga.id);
  const { recipe } = routeRecipe({ settings, manga, panel, refCount: cast.length, charCount: panel.script.characters.length });
  const style = promptStyleFor(recipe);
  if (style === 'tags') return { style };
  const imagesOf = (c: Character): string[] => {
    const images = refImages(store, c);
    return images.length > 0 ? images : [ASSUMED_PORTRAIT];
  };
  const picked = orderRefs(RECIPES[recipe]!, cast, imagesOf); // routeRecipe has checked the recipe exists
  return { style, pictures: picked.map((ref, i) => `picture ${i + 1} shows ${ref.character.name}`) };
}

export function buildStepContext(store: Store, run: EpisodeRun, step: LlmStepName): StepContext {
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const all = store.characters.listByManga(manga.id);
  const chosen = run.input.characterIds.length > 0 ? all.filter((c) => run.input.characterIds.includes(c.id)) : all;
  switch (step) {
    case 'premise':
      return {
        step, language: manga.language, manga: { title: manga.title, synopsis: manga.synopsis },
        request: { prompt: run.input.prompt, tone: run.input.tone, pages: run.input.pages }, characters: chosen.map(brief),
      };
    case 'outline':
      return { step, language: manga.language, pages: run.input.pages, premise: requireOutput(run, 'premise', PremiseOutputSchema), characters: chosen.map(brief) };
    case 'breakdown': {
      const { scenes } = requireOutput(run, 'outline', OutlineOutputSchema);
      return {
        step, pages: run.input.pages,
        scenes: scenes.map((s, idx) => ({ idx, summary: s.summary, purpose: s.purpose, location: s.location })),
        presets: PRESET_NAMES.map((name) => ({ name, panelCount: presetPanelCount(name) })),
      };
    }
    case 'scripts': {
      const { scenes } = requireOutput(run, 'outline', OutlineOutputSchema);
      const { pages } = requireOutput(run, 'breakdown', BreakdownOutputSchema);
      return {
        step, language: manga.language, premise: requireOutput(run, 'premise', PremiseOutputSchema),
        scenes: scenes.map((s, idx) => ({ ...s, idx })), pages: pages.map((p, i) => ({ ...p, page: i + 1 })),
        pageRange: { first: 1, last: pages.length, total: pages.length },
        characters: all.map(brief), // outline approval may have added characters that are not in input.characterIds
      };
    }
    case 'prompts': {
      const premise = requireOutput(run, 'premise', PremiseOutputSchema);
      const settings = store.settings.get();
      const nameOf = (id: string): string => store.characters.get(id)?.name ?? 'someone';
      return {
        step, colorMode: manga.colorMode,
        premise: { title: premise.title, setting: premise.setting, tone: premise.tone },
        panels: chapterPanels(store, chapter.id, manga.readingDirection).map(({ panel, pageNumber, isCover }) => ({
          panelId: panel.id, page: pageNumber, isCover, ...panelStyle(store, settings, manga, panel),
          camera: cameraWording(panel.script.shot, panel.script.angle), action: panel.script.action, background: panel.script.background,
          characters: panel.script.characters.map((c) => ({ name: nameOf(c.characterId), pose: c.pose, expression: c.expression, position: c.position })),
        })),
      };
    }
  }
}

export function contextBlock(ctx: StepContext): string {
  return `<context>\n${JSON.stringify(ctx, null, 2)}\n</context>`;
}

export function extractContext<T extends StepContext>(prompt: string): T {
  const match = /<context>\s*([\s\S]*?)\s*<\/context>/.exec(prompt);
  if (!match?.[1]) throw new Error('prompt has no <context> block');
  return JSON.parse(match[1]) as T;
}

/** F26: black-and-white books get no colour words (live M2: "orange sky" in a B&W scene). */
const COLOR_RULE: Record<ColorMode, string> = {
  bw: '- The book is black and white: use no colour words at all (no "red", "golden", "orange sky"…); describe light and shadow instead.',
  color: '- The book is printed in colour: colours of the setting, light and props are welcome.',
};

export function templateVars(store: Store, run: EpisodeRun, ctx: StepContext): Record<string, string> {
  const manga = store.mangas.require(store.chapters.require(run.chapterId).mangaId);
  return {
    context: contextBlock(ctx),
    languageName: LANGUAGE_NAME[manga.language],
    pages: String(run.input.pages),
    maxScenes: String(Math.max(2, run.input.pages * 2)),
    prompt: run.input.prompt,
    tone: run.input.tone.trim() || 'any',
    colorRule: COLOR_RULE[manga.colorMode],
  };
}
