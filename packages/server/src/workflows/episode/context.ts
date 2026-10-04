// packages/server/src/workflows/episode/context.ts
import {
  BreakdownOutputSchema, MAX_NEW_CHARACTERS, OutlineOutputSchema, PRESET_NAMES, PremiseOutputSchema, directivesFor, presetPanelCount, stepIndex,
  type BreakdownPage, type Chapter, type Character, type ColorMode, type Directive, type DirectiveReader, type EpisodeRun, type Language, type Manga, type OutlineScene, type Panel,
  type PremiseOutput, type PresetInfo, type ScriptsOutput, type Settings,
} from '@manga/shared';
import { orderRefs, panelCharacters, panelImageModel, refImages } from '../../handlers/context.js';
import { RECIPES } from '../../imaging/recipes/index.js';
import { promptStyleFor, routeRecipe, type PromptStyle } from '../../imaging/route.js';
import { cameraWording } from '../../prompts/camera.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';
import { requireOutput, type LlmStepName } from './steps.js';

export const LANGUAGE_NAME: Record<Language, string> = { en: 'English', uk: 'Ukrainian' };

/** W1 Q1: the story memory is kept small, for the local engine's context window. */
export const STORY_SO_FAR_LIMIT = 3000;
export const PREVIOUS_PAGE_LIMIT = 800;
export const PREVIOUS_CHAPTERS_LIMIT = 10;
/** Review I1: each earlier chapter's summary or synopsis, at most (ten of them stay small for the local engine). */
export const PREVIOUS_CHAPTER_TEXT_LIMIT = 600;

/** A directive as a step reads it: what it asks, how strictly, and what kind of detail it is. */
export interface DirectiveBrief { id: string; text: string; kind: Directive['kind']; must: boolean }
export const directiveBrief = (d: Directive): DirectiveBrief => ({ id: d.id, text: d.text, kind: d.kind, must: d.must });

/**
 * The ledger of the run's brief: the directives its premise holds (read in two passes, or handed in by the plan), else the input's
 * own, else none (runs stored before directives existed).
 */
export function ledgerOf(run: EpisodeRun): Directive[] {
  const premise = PremiseOutputSchema.safeParse(run.steps[stepIndex('premise')]?.output);
  return premise.success && premise.data.directives.length > 0 ? premise.data.directives : run.input.directives ?? [];
}

/** What `reader` is handed: the ledger's directives of its kinds for this chapter, compact. */
export function directivesOf(run: EpisodeRun, reader: DirectiveReader, chapterNumber: number): DirectiveBrief[] {
  return directivesFor(reader, ledgerOf(run), chapterNumber).map(directiveBrief);
}

export interface CharacterBrief { name: string; role: string; personality: string; speechStyle: string }
/** W1 Q1: an earlier chapter as the next chapter's premise and outline see it; `synopsis` is its summary when it has one. */
export interface ChapterBrief { number: number; title: string; synopsis: string }
export interface PremiseContext {
  step: 'premise'; language: Language; manga: { title: string; synopsis: string };
  /** `notes`: the caller's own production notes (input.notes); the prompt may carry more, which the premise separates. */
  request: { prompt: string; notes: string; tone: string; pages: number }; characters: CharacterBrief[]; previousChapters: ChapterBrief[];
  /** The details of the request, one by one: handed in, or read from `request` by the two passes before this call. */
  directives: DirectiveBrief[];
}
/**
 * `otherCharacterNames`: the manga's characters outside this run's cast, so no new character takes one of their names (Task 5 M1).
 * `request` is the user's own wording, so the outline can tell an adaptation of a known story and bring its cast along.
 */
export interface OutlineContext {
  step: 'outline'; language: Language; pages: number; request: { prompt: string; tone: string }; premise: PremiseOutput;
  characters: CharacterBrief[]; otherCharacterNames: string[]; previousChapters: ChapterBrief[]; directives: DirectiveBrief[];
}
/** `request` is the user's own wording, so an explicit panel count or layout in it reaches the step that picks them. */
export interface BreakdownContext {
  step: 'breakdown'; pages: number; request: { prompt: string; tone: string }; notes: string; directives: DirectiveBrief[];
  scenes: Array<{ idx: number; summary: string; purpose: string; location: string }>; presets: PresetInfo[];
}
/** `pages` are the pages to write: all of them, or one chunk (F18); `pageRange` says which part of the chapter they are. */
export interface ScriptsContext {
  step: 'scripts'; language: Language; premise: PremiseOutput; scenes: Array<OutlineScene & { idx: number }>;
  pages: Array<BreakdownPage & { page: number }>; pageRange: { first: number; last: number; total: number }; characters: CharacterBrief[];
  directives: DirectiveBrief[];
  /** A second try: what an audit of the first answer found missing; each page's writer applies the ones that belong to its pages. */
  revisions?: Revision[];
  /** W1 Q1: the pages earlier chunks wrote (storyDigest); absent in the first chunk. */
  storySoFar?: string;
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
  step: 'prompts'; colorMode: ColorMode; directives: DirectiveBrief[]; premise: { title: string; setting: string; tone: string; notes: string }; panels: PromptsPanelBrief[];
  /** W1 Q1: the previous page's actions (pageActions), for visual continuity; absent on page 1 and the cover. */
  previousPage?: string;
}
/** A requirement an audit found unmet, as the second try is told: the directive, and what is wrong with the first answer. */
export interface Revision { id: string; text: string; problem: string; page?: number }
/** The context of the check of a chapter's scripts against its directives (llm.ts). */
export interface ScriptsAuditContext { step: 'scripts-audit'; language: Language; directives: DirectiveBrief[]; story: string }
/** W1 Q1: the context of the chapter summary call (summary.ts). */
export interface SummaryContext {
  step: 'summary'; language: Language; chapter: { number: number; title: string; synopsis: string }; story: string;
}
export type StepContext = PremiseContext | OutlineContext | BreakdownContext | ScriptsContext | PromptsContext | SummaryContext;

/** Never includes appearanceTags: the story model must not rewrite a character's look (spec §6.3). */
const brief = (c: Character): CharacterBrief => ({ name: c.name, role: c.role, personality: c.personality, speechStyle: c.speechStyle });

/** `text` cut to at most `limit` characters, ending in "…" when it was cut. */
export const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);

/** The last blocks that fit `limit` joined by "\n", oldest first; a last block alone longer than `limit` is clipped. */
function latestBlocks(blocks: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0 && limit > 0; i--) {
    const block = blocks[i]!;
    const cost = block.length + (kept.length > 0 ? 1 : 0);
    if (size + cost > limit) {
      if (kept.length === 0) kept.push(clip(block, limit));
      break;
    }
    kept.unshift(block);
    size += cost;
  }
  return kept;
}

/** Marks the pages a `keepFirst` digest leaves out between the first page and the most recent ones. */
export const STORY_GAP = '…';

/**
 * W1 Q1: pages already written, compact. Per page, its panels' actions (one line each) with each panel's dialogue under it as
 * "speaker: text" (narration and sfx name their kind). Whole pages are kept from the most recent back while they fit `limit`;
 * a single page longer than `limit` is clipped. `keepFirst` (the chapter summary, review M5): the first page (at most half
 * the limit) is always kept, so a long chapter keeps its opening, and a STORY_GAP line marks the pages left out after it.
 */
export function storyDigest(
  pages: ScriptsOutput['pages'], firstPage: number, limit = STORY_SO_FAR_LIMIT, opts: { keepFirst?: boolean } = {},
): string {
  const blocks = pages.map((page, i) => [
    `Page ${firstPage + i}:`,
    ...page.panels.flatMap((p) => [`- ${p.action}`, ...p.dialogue.map((d) => `  ${d.speaker ?? d.kind}: ${d.text}`)]),
  ].join('\n'));
  if (opts.keepFirst !== true || blocks.length < 2) return latestBlocks(blocks, limit).join('\n');
  const head = clip(blocks[0]!, Math.floor(limit / 2));
  const rest = blocks.slice(1);
  const tail = latestBlocks(rest, limit - head.length - STORY_GAP.length - 2); // room for "\n…\n"
  return [head, ...(tail.length < rest.length ? [STORY_GAP] : []), ...tail].join('\n');
}

/** W1 Q1: a page's panel actions on one line, capped (the prompts step's `previousPage`). */
export function pageActions(panels: ReadonlyArray<{ action: string }>, limit = PREVIOUS_PAGE_LIMIT): string {
  return clip(panels.map((p) => p.action.trim()).filter((a) => a !== '').join(' / '), limit);
}

/**
 * W1 Q1: the manga's chapters numbered before `chapter`, oldest first, the last PREVIOUS_CHAPTERS_LIMIT of those that say
 * something (a chapter with neither a summary nor a synopsis is left out, review M9). Each one's text is its summary, else
 * its synopsis, clipped to PREVIOUS_CHAPTER_TEXT_LIMIT (review I1: user-written text has no length limit).
 */
export function previousChapters(store: Store, chapter: Chapter): ChapterBrief[] {
  return store.chapters.listByManga(chapter.mangaId)
    .map((c) => ({ c, text: c.summary.trim() !== '' ? c.summary.trim() : c.synopsis.trim() }))
    .filter(({ c, text }) => c.number < chapter.number && text !== '')
    .sort((a, b) => a.c.number - b.c.number)
    .slice(-PREVIOUS_CHAPTERS_LIMIT)
    .map(({ c, text }) => ({ number: c.number, title: c.title, synopsis: clip(text, PREVIOUS_CHAPTER_TEXT_LIMIT) }));
}

/** Stands in for a portrait that is not rendered yet: ensurePortraits and the review gate provide one before render (F3). */
const ASSUMED_PORTRAIT = 'assumed-portrait';

/**
 * F3: the style of the recipe the panel will route to at render time. Every cast member (the panel's
 * refCharacterIds) is assumed to have a portrait by then, so routing already counts them as references.
 * The prompts context and the prompts effect (finishScene, F2) both use it, so the two always agree.
 */
export function panelStyle(store: Store, settings: Settings, manga: Manga, panel: Panel): Pick<PromptsPanelBrief, 'style' | 'pictures'> {
  const characters = panelCharacters(store, panel, manga.id); // exactly what panelContext counts at render time (I1)
  const cast = panel.refCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => c !== undefined);
  const { recipe } = routeRecipe({ settings, manga, panel, refCount: cast.length, charCount: characters.length, imageModel: panelImageModel(store, manga, panel) });
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
        request: { prompt: run.input.prompt, notes: run.input.notes ?? '', tone: run.input.tone, pages: run.input.pages }, characters: chosen.map(brief),
        previousChapters: previousChapters(store, chapter), directives: (run.input.directives ?? []).map(directiveBrief),
      };
    case 'outline':
      return {
        step, language: manga.language, pages: run.input.pages, request: { prompt: run.input.prompt, tone: run.input.tone },
        premise: requireOutput(run, 'premise', PremiseOutputSchema), characters: chosen.map(brief),
        otherCharacterNames: all.filter((c) => !chosen.includes(c)).map((c) => c.name),
        previousChapters: previousChapters(store, chapter), directives: directivesOf(run, 'outline', chapter.number),
      };
    case 'breakdown': {
      const { scenes } = requireOutput(run, 'outline', OutlineOutputSchema);
      return {
        step, pages: run.input.pages, request: { prompt: run.input.prompt, tone: run.input.tone },
        notes: requireOutput(run, 'premise', PremiseOutputSchema).notes, directives: directivesOf(run, 'breakdown', chapter.number),
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
        directives: directivesOf(run, 'scripts', chapter.number),
        characters: all.map(brief), // outline approval may have added characters that are not in input.characterIds
      };
    }
    case 'prompts': {
      const premise = requireOutput(run, 'premise', PremiseOutputSchema);
      const settings = store.settings.get();
      const nameOf = (id: string): string => store.characters.get(id)?.name ?? 'someone';
      return {
        step, colorMode: manga.colorMode, directives: directivesOf(run, 'prompts', chapter.number),
        premise: { title: premise.title, setting: premise.setting, tone: premise.tone, notes: premise.notes },
        panels: chapterPanels(store, chapter.id, manga.readingDirection).map(({ panel, pageNumber, isCover }) => ({
          panelId: panel.id, page: pageNumber, isCover, ...panelStyle(store, settings, manga, panel),
          camera: cameraWording(panel.script.shot, panel.script.angle), action: panel.script.action, background: panel.script.background,
          characters: panel.script.characters.map((c) => ({ name: nameOf(c.characterId), pose: c.pose, expression: c.expression, position: c.position })),
        })),
      };
    }
  }
}

const OPEN = '<context>';
const CLOSE = '</context>';

/** The JSON escapes every "<" (as \u003c), so a request containing "</context>" cannot end the block early (M4). */
export function contextBlock(ctx: { step: string }): string {
  return `${OPEN}\n${JSON.stringify(ctx, null, 2).replace(/</g, '\\u003c')}\n${CLOSE}`;
}

/** Reads the last <context> block: the context always ends the prompt, and user text before it may contain the tags. */
export function extractContext<T extends { step: string }>(prompt: string): T {
  const start = prompt.lastIndexOf(OPEN);
  const end = start < 0 ? -1 : prompt.indexOf(CLOSE, start);
  if (end < 0) throw new Error('prompt has no <context> block');
  return JSON.parse(prompt.slice(start + OPEN.length, end)) as T;
}

/** F26: black-and-white books get no colour words (live M2: "orange sky" in a B&W scene). */
const COLOR_RULE: Record<ColorMode, string> = {
  bw: '- The book is black and white: use no colour words at all (no "red", "golden", "orange sky"…); describe light and shadow instead.',
  color: '- The book is printed in colour: colours of the setting, light and props are welcome.',
};

/** M4 final S6: the outline's new characters of a black-and-white book are drafted without colours. */
export const APPEARANCE_COLOR_RULE: Record<ColorMode, string> = {
  bw: '  - The book is black and white: no colours in "appearanceTags" (no "red hair", "blue eyes", "orange fur"); describe hair, eyes and fur by length, style and shade (dark, light, black, white, grey) instead.',
  color: '  - Colours of hair, eyes and outfit are welcome in "appearanceTags".',
};

export function templateVars(store: Store, run: EpisodeRun, ctx: StepContext): Record<string, string> {
  const manga = store.mangas.require(store.chapters.require(run.chapterId).mangaId);
  return {
    context: contextBlock(ctx),
    languageName: LANGUAGE_NAME[manga.language],
    pages: String(run.input.pages),
    maxScenes: String(Math.max(2, run.input.pages * 2)),
    maxNewCharacters: String(MAX_NEW_CHARACTERS),
    prompt: run.input.prompt,
    notes: (run.input.notes ?? '').trim() || 'none',
    tone: run.input.tone.trim() || 'any',
    colorRule: COLOR_RULE[manga.colorMode],
    appearanceColorRule: APPEARANCE_COLOR_RULE[manga.colorMode],
  };
}
