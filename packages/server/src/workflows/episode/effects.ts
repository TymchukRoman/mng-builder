// packages/server/src/workflows/episode/effects.ts
import {
  CreateCharacterSchema, EMPTY_SCRIPT, panelIds, readingOrder, sameName,
  type BreakdownOutput, type Chapter, type Character, type Manga, type NewCharacterDraft, type PanelScript,
  type PanelScriptDraft, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import { createCharacter } from '../../domain/characters.js';
import { createCoverPage, createPage } from '../../domain/pages.js';
import { InvalidOutputError } from '../../engines/errors.js';
import { ConflictError, ValidationError } from '../../errors.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import { stripColourWords } from '../../prompts/sanitize.js';
import { finishScene } from '../../prompts/scene.js';
import type { Store } from '../../store/index.js';
import { chapterPanels, storyPages } from './chapter.js';
import { panelStyle } from './context.js';

export interface EffectDeps { store: Store; bus: EventBus }
type Position = PanelScript['characters'][number]['position'];

/** Step 1 → the chapter (spec §8: "written to the chapter"). */
export function applyPremise({ store, bus }: EffectDeps, chapterId: string, premise: PremiseOutput): void {
  const chapter = store.chapters.update(chapterId, { title: premise.title, synopsis: premise.synopsis });
  emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
}

/** Outline acceptance: new characters (random seed via M1's createCharacter). Names that already exist are skipped. */
export function createOutlineCharacters({ store, bus }: EffectDeps, mangaId: string, drafts: NewCharacterDraft[]): Character[] {
  const existing = store.characters.listByManga(mangaId);
  const created: Character[] = [];
  for (const d of drafts) {
    if ([...existing, ...created].some((c) => sameName(c.name, d.name))) continue;
    const character = createCharacter(store, mangaId, CreateCharacterSchema.parse({
      name: d.name.trim(), role: d.role, personality: d.personality, speechStyle: d.speechStyle, appearanceTags: d.appearanceTags,
    }));
    emitEntity(bus, 'character', character.id, 'created', mangaId);
    created.push(character);
  }
  return created;
}

function byName(characters: Character[], name: string): Character {
  const found = characters.find((c) => sameName(c.name, name));
  if (!found) throw new ValidationError(`unknown character "${name}"`);
  return found;
}

export function draftToScript(draft: PanelScriptDraft, characters: Character[]): { script: PanelScript; refCharacterIds: string[] } {
  const cast = draft.characters.map((c) => ({ characterId: byName(characters, c.name).id, pose: c.pose, expression: c.expression, position: c.position }));
  const dialogue = draft.dialogue.map((d) => ({ speakerId: d.speaker === null ? null : byName(characters, d.speaker).id, kind: d.kind, text: d.text }));
  return {
    script: { action: draft.action, shot: draft.shot, angle: draft.angle, characters: cast, background: draft.background, dialogue },
    refCharacterIds: [...new Set(cast.map((c) => c.characterId))],
  };
}

/** The two characters on stage most often (ties: first appearance), who lead the cover. */
function leadingCharacters(scripts: ScriptsOutput, characters: Character[]): string[] {
  const counts = new Map<string, number>();
  for (const page of scripts.pages) {
    for (const p of page.panels) {
      for (const id of new Set(p.characters.map((c) => byName(characters, c.name).id))) counts.set(id, (counts.get(id) ?? 0) + 1);
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

/** Step 4 (spec §8): "Materializes Pages and Panels" — all or nothing. */
export function materializeScripts(
  { store, bus }: EffectDeps, chapterId: string, input: { breakdown: BreakdownOutput; scripts: ScriptsOutput; premise: PremiseOutput },
): { pageIds: string[]; coverPageId: string } {
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
  const result = store.tx(() => {
    const pageIds = input.breakdown.pages.map((bp, i) => {
      const detail = createPage(store, chapterId, bp.layoutPreset);
      const slots = readingOrder(detail.page.layout, manga.readingDirection);
      const drafts = input.scripts.pages[i]?.panels ?? [];
      if (slots.length !== drafts.length) {
        throw new ValidationError(`page ${i + 1}: layout "${bp.layoutPreset}" has ${slots.length} panels but the script has ${drafts.length}`);
      }
      slots.forEach((panelId, j) => { store.panels.update(panelId, draftToScript(drafts[j]!, characters)); });
      return detail.page.id;
    });
    return { pageIds, cover: prepareCover(store, chapter, manga, input.premise, input.scripts, characters) };
  });
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
  return { pageIds: result.pageIds, coverPageId: result.cover.pageId };
}

/** A user edit of the scripts output after materialization: rewrite the panel scripts in place. */
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
      slots.forEach((id, j) => { store.panels.update(id, draftToScript(drafts[j]!, characters)); });
    });
  });
  for (const page of pages) for (const id of panelIds(page.layout)) emitEntity(bus, 'panel', id, 'updated', manga.id);
}

/**
 * Where a prompts output comes from (required, review M3, so every caller decides). `llm` (the step's own answer) is finished like M2's panel-prompt (F2): sanitised,
 * the model's framing replaced by the script's camera wording, chromatic colours dropped for a B&W book, and an
 * unusable scene fails naming the panel. `user` (an edit of the output) is stored verbatim.
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
  store.tx(() => {
    for (const p of prompts.panels) {
      const panel = panels.get(p.panelId);
      if (!panel) throw new ValidationError(`panel ${p.panelId} is not part of this chapter`);
      let scene = p.scene;
      if (source === 'llm') {
        const { style } = panelStyle(store, settings, manga, panel);
        const raw = manga.colorMode === 'bw' ? stripColourWords(p.scene, names) : p.scene;
        const finished = finishScene(style, panel.script.shot, panel.script.angle, raw);
        if (finished === null) throw new InvalidOutputError(`prompts: the AI wrote no usable scene for panel ${p.panelId}`, p.scene);
        scene = finished;
      }
      store.panels.update(p.panelId, { prompt: { scene, negative: p.negative ?? '' } });
    }
  });
  for (const id of new Set(prompts.panels.map((p) => p.panelId))) emitEntity(bus, 'panel', id, 'updated', manga.id);
}
