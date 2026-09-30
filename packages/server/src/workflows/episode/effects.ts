// packages/server/src/workflows/episode/effects.ts
import {
  CHAPTER_TITLE_FROM_PREMISE, CreateCharacterSchema, EMPTY_SCRIPT, panelIds, readingOrder, sameName,
  type BreakdownOutput, type Chapter, type Character, type Manga, type NewCharacterDraft, type PanelScript,
  type PanelScriptDraft, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import { createCharacter } from '../../domain/characters.js';
import { createCoverPage, createPage } from '../../domain/pages.js';
import { panelCharacters } from '../../handlers/context.js';
import { ConflictError, ValidationError } from '../../errors.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import { stripColourWords } from '../../prompts/sanitize.js';
import { fallbackScene, usableScene } from '../../prompts/scene.js';
import type { Store } from '../../store/index.js';
import { chapterPanels, storyPages } from './chapter.js';
import { panelStyle } from './context.js';
import { MAX_PRESET_PANELS, fitPreset, foldPanels } from './fit.js';

export interface EffectDeps { store: Store; bus: EventBus }
type Position = PanelScript['characters'][number]['position'];

/**
 * Step 1 → the chapter (spec §8: "written to the chapter"). The synopsis always follows the premise. The title follows
 * it only while it is not the user's own (M4 final M6): the placeholder `CHAPTER_TITLE_FROM_PREMISE`, or a title a
 * premise of this chapter wrote (`premiseTitles`: every run's stored premise title, the output being edited or re-run
 * included; residual N3, so a later run renames what an earlier run's premise wrote). A title the user typed stays.
 * When the title changes, the cover's title frames that still show the old title follow it (M4 final M3).
 */
export function applyPremise(fx: EffectDeps, chapterId: string, premise: PremiseOutput, premiseTitles: readonly string[]): void {
  const { store, bus } = fx;
  const before = store.chapters.require(chapterId);
  const owned = before.title === CHAPTER_TITLE_FROM_PREMISE || premiseTitles.includes(before.title);
  const title = owned ? premise.title : before.title;
  const chapter = store.chapters.update(chapterId, { title, synopsis: premise.synopsis });
  emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
  if (title !== before.title) retitleCover(fx, chapter, before.title);
}

/** The chapter cover's `title` frames whose text is still `oldTitle` get the chapter's new title (M4 final M3). */
function retitleCover({ store, bus }: EffectDeps, chapter: Chapter, oldTitle: string): void {
  if (chapter.coverPageId === null || store.pages.get(chapter.coverPageId) === null) return;
  const stale = store.frames.listByPage(chapter.coverPageId).filter((f) => f.kind === 'title' && f.text === oldTitle);
  store.tx(() => { for (const f of stale) store.frames.update(f.id, { text: chapter.title }); });
  for (const f of stale) emitEntity(bus, 'textFrame', f.id, 'updated', chapter.mangaId);
}

/**
 * M4 final S6: a black-and-white book's outline-drafted characters get no chromatic colour tags ("orange tabby fur,
 * green eyes" reached every generation prompt, and the reviewer flagged fur colour the greyscale export hides).
 * Character names are kept (masked); black, white, grey and silver stay.
 */
function bwAppearance(tags: string, names: readonly string[]): string {
  return stripColourWords(tags, names).split(',').map((t) => t.trim().replace(/\s+/g, ' ')).filter((t) => t.length > 0).join(', ');
}

/**
 * Outline acceptance: new characters (random seed via M1's createCharacter). Names that already exist are skipped,
 * so an existing (possibly user-edited) character is never touched.
 */
export function createOutlineCharacters({ store, bus }: EffectDeps, mangaId: string, drafts: NewCharacterDraft[]): Character[] {
  const existing = store.characters.listByManga(mangaId);
  const bw = store.mangas.require(mangaId).colorMode === 'bw';
  const names = [...existing.map((c) => c.name), ...drafts.map((d) => d.name)];
  const created: Character[] = [];
  for (const d of drafts) {
    if ([...existing, ...created].some((c) => sameName(c.name, d.name))) continue;
    const appearanceTags = bw ? bwAppearance(d.appearanceTags, names) : d.appearanceTags;
    const character = createCharacter(store, mangaId, CreateCharacterSchema.parse({
      name: d.name.trim(), role: d.role, personality: d.personality, speechStyle: d.speechStyle, appearanceTags,
    }));
    emitEntity(bus, 'character', character.id, 'created', mangaId);
    created.push(character);
  }
  return created;
}

function findByName(characters: Character[], name: string): Character | undefined {
  return characters.find((c) => sameName(c.name, name));
}

/**
 * A panel draft → its script and refs. A name no character of the manga carries (an LLM answer may use one: an
 * adaptation's cast the outline did not add) is dropped from the cast and refs, and its lines keep their kind and
 * text with no speaker, so the bubble has no tail target; the action text still describes them. `dropped` lists them.
 */
export function draftToScript(
  draft: PanelScriptDraft, characters: Character[],
): { script: PanelScript; refCharacterIds: string[]; dropped: string[] } {
  const dropped: string[] = [];
  const idOf = (name: string): string | null => {
    const found = findByName(characters, name);
    if (!found) dropped.push(name.trim());
    return found?.id ?? null;
  };
  const cast = draft.characters.flatMap((c) => {
    const characterId = idOf(c.name);
    return characterId === null ? [] : [{ characterId, pose: c.pose, expression: c.expression, position: c.position }];
  });
  const dialogue = draft.dialogue.map((d) => ({ speakerId: d.speaker === null ? null : idOf(d.speaker), kind: d.kind, text: d.text }));
  return {
    script: { action: draft.action, shot: draft.shot, angle: draft.angle, characters: cast, background: draft.background, dialogue },
    refCharacterIds: [...new Set(cast.map((c) => c.characterId))],
    dropped,
  };
}

/** The distinct names, first spelling kept, in order of appearance. */
function distinctNames(names: string[]): string[] {
  return names.filter((n, i) => names.findIndex((m) => sameName(m, n)) === i);
}

/** The two characters on stage most often (ties: first appearance), who lead the cover. Unknown names are skipped. */
function leadingCharacters(scripts: ScriptsOutput, characters: Character[]): string[] {
  const counts = new Map<string, number>();
  for (const page of scripts.pages) {
    for (const p of page.panels) {
      const ids = p.characters.flatMap((c) => findByName(characters, c.name)?.id ?? []);
      for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
}

/**
 * The chapter cover (M1's createCoverPage reuses an existing one). Task 4 review M1: the leads are both the script
 * cast and the refCharacterIds, so the prompts step and image generation know who is on it and get their refs.
 */
function prepareCover(
  store: Store, chapter: Chapter, manga: Manga, premise: PremiseOutput, scripts: ScriptsOutput, characters: Character[],
): { pageId: string; panelId: string | null } {
  const detail = createCoverPage(store, manga.id, chapter.id);
  const panel = detail.panels[0];
  if (!panel) return { pageId: detail.page.id, panelId: null };
  const leads = leadingCharacters(scripts, characters);
  const positions: Position[] = leads.length === 1 ? ['center'] : ['left', 'right'];
  store.panels.update(panel.id, {
    script: {
      ...EMPTY_SCRIPT, action: `Chapter cover: ${premise.title}. ${premise.synopsis}`, shot: 'medium', angle: 'low', background: premise.setting,
      characters: leads.map((characterId, i) => ({ characterId, pose: 'facing the reader', expression: 'determined', position: positions[i] ?? 'center' })),
      dialogue: [],
    },
    refCharacterIds: leads,
  });
  return { pageId: detail.page.id, panelId: panel.id };
}

/**
 * Step 4 (spec §8): "Materializes Pages and Panels" — all or nothing. An LLM answer is fitted, never refused, for
 * details the model may get wrong (one server-log warning each per step):
 * - names the manga lacks are dropped (see draftToScript);
 * - a page whose script has another panel count than the breakdown gets a layout with that many panels (fitPreset),
 *   after panels beyond the largest layout are folded into its last one (foldPanels). The stored breakdown is unchanged.
 * Returns the scripts as materialized (folded), which the step stores, so a later edit of them fits the pages.
 */
export function materializeScripts(
  { store, bus }: EffectDeps, chapterId: string, input: { breakdown: BreakdownOutput; scripts: ScriptsOutput; premise: PremiseOutput },
): { pageIds: string[]; coverPageId: string; scripts: ScriptsOutput } {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  if (storyPages(store, chapterId).length > 0) {
    throw new ConflictError('the chapter already has pages; re-run the scripts step with confirm to replace them');
  }
  // Review M4: Task 4's scriptsSchemaFor already checks this for the step's answer; materialization checks it again
  // itself, because it would otherwise ignore extra script pages silently.
  if (input.scripts.pages.length !== input.breakdown.pages.length) {
    throw new ValidationError(`the breakdown has ${input.breakdown.pages.length} pages but the scripts have ${input.scripts.pages.length}`);
  }
  const hadCover = chapter.coverPageId !== null && store.pages.get(chapter.coverPageId) !== null;
  const characters = store.characters.listByManga(manga.id);
  const fitted = input.breakdown.pages.map((bp, i) => {
    const panels = foldPanels(input.scripts.pages[i]!.panels, MAX_PRESET_PANELS);
    return { planned: bp.layoutPreset, preset: fitPreset(bp.layoutPreset, panels.length), panels };
  });
  const scripts: ScriptsOutput = { pages: fitted.map((f) => ({ panels: f.panels })) };
  const dropped: string[] = [];
  const result = store.tx(() => {
    const pageIds = fitted.map(({ preset, panels: drafts }, i) => {
      const detail = createPage(store, chapterId, preset);
      const slots = readingOrder(detail.page.layout, manga.readingDirection);
      if (slots.length !== drafts.length) {
        throw new ValidationError(`page ${i + 1}: layout "${preset}" has ${slots.length} panels but the script has ${drafts.length}`);
      }
      slots.forEach((panelId, j) => {
        const { script, refCharacterIds, dropped: names } = draftToScript(drafts[j]!, characters);
        store.panels.update(panelId, { script, refCharacterIds });
        dropped.push(...names);
      });
      return detail.page.id;
    });
    return { pageIds, cover: prepareCover(store, chapter, manga, input.premise, scripts, characters) };
  });
  const relaid = fitted.flatMap((f, i) => (f.preset === f.planned ? [] : [`page ${i + 1} ("${f.planned}" -> "${f.preset}", ${f.panels.length} panels)`]));
  if (relaid.length > 0) {
    console.warn(`[manga] episode scripts: chapter ${chapterId}: the script's panel count differs from the breakdown, so the layout changed on ${relaid.join(', ')}`);
  }
  if (dropped.length > 0) {
    console.warn(`[manga] episode scripts: chapter ${chapterId} names characters the manga does not have; they stay unattributed extras (no cast, refs or bubble tail): ${distinctNames(dropped).join(', ')}`);
  }
  // A new page's `created` covers its fresh panels (M1: POST /api/chapters/:id/pages emits only the page).
  for (const id of result.pageIds) emitEntity(bus, 'page', id, 'created', manga.id);
  // F30: a new cover is created and set on the chapter, as POST /api/chapters/:id/cover does. An existing cover's page
  // row is untouched; only its panel's script and refs change, so that panel is the one updated (G5, review I1).
  if (!hadCover) {
    emitEntity(bus, 'page', result.cover.pageId, 'created', manga.id);
    emitEntity(bus, 'chapter', chapter.id, 'updated', manga.id);
  } else if (result.cover.panelId !== null) {
    emitEntity(bus, 'panel', result.cover.panelId, 'updated', manga.id);
  }
  return { pageIds: result.pageIds, coverPageId: result.cover.pageId, scripts };
}

/** A user edit of the scripts output after materialization: rewrite the panel scripts in place (every name must be known). */
export function applyScripts({ store, bus }: EffectDeps, chapterId: string, scripts: ScriptsOutput): void {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const pages = storyPages(store, chapterId);
  if (pages.length === 0) return;
  if (pages.length !== scripts.pages.length) {
    throw new ValidationError(`the chapter has ${pages.length} pages but the scripts have ${scripts.pages.length}; re-run the scripts step instead`);
  }
  const characters = store.characters.listByManga(manga.id);
  store.tx(() => {
    pages.forEach((page, i) => {
      const slots = readingOrder(page.layout, manga.readingDirection);
      const drafts = scripts.pages[i]!.panels;
      if (slots.length !== drafts.length) {
        throw new ValidationError(`page ${i + 1} has ${slots.length} panels but its script has ${drafts.length}; re-run the scripts step instead`);
      }
      slots.forEach((id, j) => {
        const { script, refCharacterIds, dropped } = draftToScript(drafts[j]!, characters);
        // The user's own edit: its schema already refuses a name the manga lacks (a typo); this keeps that true here too.
        if (dropped.length > 0) throw new ValidationError(`unknown character "${dropped[0]}"`);
        store.panels.update(id, { script, refCharacterIds });
      });
    });
  });
  for (const page of pages) for (const id of panelIds(page.layout)) emitEntity(bus, 'panel', id, 'updated', manga.id);
}

/**
 * Where a prompts output comes from (required, review M3, so every caller decides). `llm` (the step's own answer) is finished like M2's panel-prompt (F2): sanitised,
 * the model's framing replaced by the script's camera wording, chromatic colours dropped for a B&W book, only its
 * English part kept, and a scene with nothing usable left written from the panel's cast (fallbackScene, one warning
 * per step) instead of failing the run. `user` (an edit of the output) is stored verbatim.
 */
export interface ApplyPromptsOptions { source: 'llm' | 'user' }

/** Step 5 → panel.prompt (and user edits of it). */
export function applyPrompts(
  { store, bus }: EffectDeps, chapterId: string, prompts: PromptsOutput, { source }: ApplyPromptsOptions,
): void {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const settings = store.settings.get();
  const names = store.characters.listByManga(manga.id).map((c) => c.name); // never strip "Amber" or "Violet" (review M1)
  const panels = new Map(chapterPanels(store, chapterId, manga.readingDirection).map((e) => [e.panel.id, e.panel]));
  const fallbacks: string[] = [];
  store.tx(() => {
    for (const p of prompts.panels) {
      const panel = panels.get(p.panelId);
      if (!panel) throw new ValidationError(`panel ${p.panelId} is not part of this chapter`);
      let scene = p.scene;
      if (source === 'llm') {
        const { style } = panelStyle(store, settings, manga, panel);
        const prepare = (raw: string): string => (manga.colorMode === 'bw' ? stripColourWords(raw, names) : raw);
        const { shot, angle } = panel.script;
        const finished = usableScene(style, shot, angle, prepare(p.scene));
        if (finished !== null) {
          scene = finished;
        } else {
          // No usable English scene (Roman's Ukrainian run, or only camera/forbidden words): written from the cast.
          scene = fallbackScene(style, shot, angle, panelCharacters(store, panel, manga.id), panel.script.background, prepare);
          fallbacks.push(p.panelId);
        }
      }
      store.panels.update(p.panelId, { prompt: { scene, negative: p.negative ?? '' } });
    }
  });
  if (fallbacks.length > 0) {
    console.warn(`[manga] episode prompts: chapter ${chapterId}: no usable English scene for ${fallbacks.length} panel(s), so it is written from the cast: ${fallbacks.join(', ')}`);
  }
  for (const id of new Set(prompts.panels.map((p) => p.panelId))) emitEntity(bus, 'panel', id, 'updated', manga.id);
}
