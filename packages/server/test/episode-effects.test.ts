// packages/server/test/episode-effects.test.ts
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateFrameSchema, readingOrder, type ScriptsOutput, type ServerEvent } from '@manga/shared';
import { createFrame } from '../src/domain/frames.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { storyPages } from '../src/workflows/episode/chapter.js';
import { applyPremise, applyPrompts, applyScripts, createOutlineCharacters, materializeScripts } from '../src/workflows/episode/effects.js';
import { PREMISE, TWO_PANEL_PRESET, breakdown, scripts, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
});
afterEach(() => { lib.close(); });

const entityEvents = () => events.flatMap((e) => (e.type === 'entity' ? [`${e.entity}:${e.op}`] : []));

function world() {
  const w = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, w.manga.id, 'Aiko');
  return { ...w, aiko };
}

describe('premise and outline effects', () => {
  it('applyPremise writes the title and synopsis to a chapter left to the premise', () => {
    const { chapter } = world();
    applyPremise({ store: lib.store, bus }, chapter.id, PREMISE, null);
    expect(lib.store.chapters.require(chapter.id)).toMatchObject({ title: PREMISE.title, synopsis: PREMISE.synopsis });
    expect(entityEvents()).toEqual(['chapter:updated']);
  });

  it('applyPremise never overwrites a title the user typed; the synopsis still follows (M4 final M6)', () => {
    const w = seedEpisodeWorld(lib.store, { chapterTitle: 'Rain' });
    applyPremise({ store: lib.store, bus }, w.chapter.id, PREMISE, null);
    expect(lib.store.chapters.require(w.chapter.id)).toMatchObject({ title: 'Rain', synopsis: PREMISE.synopsis });
    applyPremise({ store: lib.store, bus }, w.chapter.id, { ...PREMISE, title: 'Other' }, PREMISE); // 'Rain' was not the premise's
    expect(lib.store.chapters.require(w.chapter.id).title).toBe('Rain');
  });

  it('a changed premise title renames the chapter and the cover title frames that showed the old title (M4 final M3)', () => {
    const { chapter, manga } = world();
    applyPremise({ store: lib.store, bus }, chapter.id, PREMISE, null);
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const title = createFrame(lib.store, cover.page.id, CreateFrameSchema.parse({ kind: 'title', text: PREMISE.title, box: { x: 0, y: 0, w: 10, h: 5 } }));
    const custom = createFrame(lib.store, cover.page.id, CreateFrameSchema.parse({ kind: 'title', text: 'Vol. 1', box: { x: 0, y: 6, w: 10, h: 5 } }));
    events.length = 0;
    applyPremise({ store: lib.store, bus }, chapter.id, { ...PREMISE, title: 'Renamed' }, PREMISE);
    expect(lib.store.chapters.require(chapter.id).title).toBe('Renamed');
    expect(lib.store.frames.require(title.id).text).toBe('Renamed');
    expect(lib.store.frames.require(custom.id).text).toBe('Vol. 1');
    expect(entityEvents()).toEqual(['chapter:updated', 'textFrame:updated']);
  });

  it('createOutlineCharacters drops chromatic colours from drafted tags in a B&W manga, keeping names and existing characters (M4 final S6)', () => {
    const { manga } = world(); // a bw manga
    const aiko = lib.store.characters.listByManga(manga.id).find((c) => c.name === 'Aiko')!;
    lib.store.characters.update(aiko.id, { appearanceTags: '1girl, red scarf' }); // the user's own edit
    const draft = { role: 'minor' as const, personality: '', speechStyle: '' };
    const created = createOutlineCharacters({ store: lib.store, bus }, manga.id, [
      { name: 'Kitten', ...draft, appearanceTags: 'no humans, kitten, orange tabby fur, green eyes, grey paws' },
      { name: 'Amber', ...draft, appearanceTags: '1girl, blue-eyed, Amber brooch, black hair' },
      { name: 'Aiko', ...draft, appearanceTags: '1girl, blue hair' }, // exists: skipped, untouched
    ]);
    expect(created.map((c) => [c.name, c.appearanceTags])).toEqual([
      ['Kitten', 'no humans, kitten, tabby fur, eyes, grey paws'],
      ['Amber', '1girl, Amber brooch, black hair'],
    ]);
    expect(lib.store.characters.require(aiko.id).appearanceTags).toBe('1girl, red scarf');
  });

  it('createOutlineCharacters keeps colours in a colour manga', () => {
    const { manga } = world();
    lib.store.mangas.update(manga.id, { colorMode: 'color' });
    const [kitten] = createOutlineCharacters({ store: lib.store, bus }, manga.id, [
      { name: 'Kitten', role: 'minor', personality: '', speechStyle: '', appearanceTags: 'no humans, kitten, orange tabby fur' },
    ]);
    expect(kitten!.appearanceTags).toBe('no humans, kitten, orange tabby fur');
  });

  it('createOutlineCharacters creates each new name once, skipping existing ones', () => {
    const { manga } = world();
    lib.store.mangas.update(manga.id, { colorMode: 'color' }); // colours kept (see the S6 test for B&W)
    const draft = { role: 'supporting' as const, personality: 'cheerful', speechStyle: 'short', appearanceTags: '1girl, yellow raincoat' };
    const created = createOutlineCharacters({ store: lib.store, bus }, manga.id, [
      { name: 'Mika', ...draft }, { name: ' mika ', ...draft }, { name: 'AIKO', ...draft },
    ]);
    expect(created.map((c) => c.name)).toEqual(['Mika']);
    expect(created[0]).toMatchObject({ role: 'supporting', appearanceTags: '1girl, yellow raincoat', refs: {} });
    expect(lib.store.characters.listByManga(manga.id).map((c) => c.name).sort()).toEqual(['Aiko', 'Mika']);
    expect(entityEvents()).toEqual(['character:created']);
  });
});

describe('materializeScripts', () => {
  it('creates the pages of the breakdown and fills their panels in reading order', () => {
    const { chapter, manga, aiko } = world();
    const bd = breakdown(2);
    const { pageIds } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    const pages = storyPages(lib.store, chapter.id);
    expect(pages.map((p) => p.id)).toEqual(pageIds);
    pages.forEach((page, i) => {
      readingOrder(page.layout, manga.readingDirection).forEach((panelId, j) => {
        const panel = lib.store.panels.require(panelId);
        expect(panel.script.action).toBe(`Page ${i + 1} panel ${j + 1}`);
        expect(panel.script.characters).toEqual([{ characterId: aiko.id, pose: 'standing', expression: 'calm', position: 'left' }]);
        expect(panel.script.dialogue).toEqual([{ speakerId: aiko.id, kind: 'speech', text: `Line ${i + 1}.${j + 1}` }]);
        expect(panel.refCharacterIds).toEqual([aiko.id]);
      });
    });
    // F30: the cover is new, so it is created like POST /api/chapters/:id/cover does (page created + chapter updated).
    expect(entityEvents()).toEqual(['page:created', 'page:created', 'page:created', 'chapter:updated']);
  });

  it('materialize maps names case-insensitively', () => {
    const { chapter, aiko } = world();
    const bd = breakdown(1);
    materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, '  AIKO '), premise: PREMISE });
    const page = storyPages(lib.store, chapter.id)[0]!;
    const panel = lib.store.panels.listByPage(page.id)[0]!;
    expect(panel.script.dialogue[0]!.speakerId).toBe(aiko.id);
  });

  it('prepares the chapter cover with the leading characters', () => {
    const { chapter, aiko } = world();
    const bd = breakdown(1);
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBe(coverPageId);
    const cover = lib.store.panels.listByPage(coverPageId)[0]!;
    expect(cover.refCharacterIds).toEqual([aiko.id]);
    expect(cover.script).toMatchObject({ background: PREMISE.setting, dialogue: [], characters: [{ characterId: aiko.id, position: 'center' }] });
  });

  it('casts the two most frequent characters on the cover, script and refs alike (Task 4 review M1)', () => {
    const { chapter, manga, aiko } = world();
    const mika = seedCharacter(lib.store, manga.id, 'Mika');
    seedCharacter(lib.store, manga.id, 'Ren');
    const bd = breakdown(2);
    const sc: ScriptsOutput = scripts(bd, 'Aiko');
    const extra = (name: string) => ({ name, pose: 'waving', expression: 'happy', position: 'right' as const });
    sc.pages[0]!.panels[0]!.characters.push(extra('Ren'));
    sc.pages[0]!.panels[1]!.characters.push(extra('mika'));
    sc.pages[1]!.panels[0]!.characters.push(extra('Mika'));
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: sc, premise: PREMISE });
    const cover = lib.store.panels.listByPage(coverPageId)[0]!;
    expect(cover.refCharacterIds).toEqual([aiko.id, mika.id]);
    expect(cover.script.characters).toEqual([
      { characterId: aiko.id, pose: 'facing the reader', expression: 'determined', position: 'left' },
      { characterId: mika.id, pose: 'facing the reader', expression: 'determined', position: 'right' },
    ]);
  });

  it('reuses an existing chapter cover and reports its rewritten panel as updated (F30, G5)', () => {
    const { chapter, manga, aiko } = world();
    const existing = createCoverPage(lib.store, manga.id, chapter.id);
    const coverPanel = existing.panels[0]!;
    const bd = breakdown(1);
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    expect(coverPageId).toBe(existing.page.id);
    const cover = lib.store.panels.require(coverPanel.id);
    expect(cover.script).toMatchObject({ background: PREMISE.setting, characters: [{ characterId: aiko.id, position: 'center' }] });
    expect(cover.refCharacterIds).toEqual([aiko.id]);
    // The cover page row is unchanged; its panel's script and refs are (G5: one event per changed row).
    expect(events.flatMap((e) => (e.type === 'entity' ? [`${e.entity}:${e.op}:${e.id}`] : [])).slice(-1)).toEqual([`panel:updated:${coverPanel.id}`]);
    expect(entityEvents()).toEqual(['page:created', 'panel:updated']);
  });

  it('creates a fresh cover when the chapter cover id dangles', () => {
    const { chapter } = world();
    // Foreign keys (ON DELETE SET NULL) keep this from happening through the store; a raw connection with them off can.
    const raw = new Database(join(lib.dir, 'library.sqlite'));
    try {
      raw.pragma('foreign_keys = OFF');
      raw.prepare('UPDATE chapters SET cover_page_id = ? WHERE id = ?').run('pg_gone0000001', chapter.id);
    } finally {
      raw.close();
    }
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBe('pg_gone0000001');
    const bd = breakdown(1);
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    expect(coverPageId).not.toBe('pg_gone0000001');
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBe(coverPageId);
    expect(entityEvents()).toEqual(['page:created', 'page:created', 'chapter:updated']);
  });

  it('refuses a chapter that already has story pages', () => {
    const { chapter } = world();
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const bd = breakdown(1);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE }))
      .toThrow(ConflictError);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(1);
  });

  it('rolls everything back when a page script does not fit its layout', () => {
    const { chapter } = world();
    const bd = breakdown(2);
    const bad = scripts(bd, 'Aiko');
    bad.pages[1]!.panels.push(bad.pages[1]!.panels[0]!);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: bad, premise: PREMISE }))
      .toThrow(`page 2: layout "${TWO_PANEL_PRESET}" has 2 panels but the script has 3`);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(0);
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBeNull();
    expect(entityEvents()).toEqual([]);
  });

  it('rejects an unknown character name', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Nobody'), premise: PREMISE }))
      .toThrow(ValidationError);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(0);
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBeNull();
    expect(entityEvents()).toEqual([]);
  });

  it('refuses scripts whose page count differs from the breakdown (M4)', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(breakdown(2), 'Aiko'), premise: PREMISE }))
      .toThrow('the breakdown has 1 pages but the scripts have 2');
    expect(storyPages(lib.store, chapter.id)).toHaveLength(0);
    expect(entityEvents()).toEqual([]);
  });
});

describe('edits after materialization', () => {
  it('applyScripts rewrites panel scripts in place and refuses a different shape', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    events = [];
    const edited = scripts(bd, null);
    applyScripts({ store: lib.store, bus }, chapter.id, edited);
    const page = storyPages(lib.store, chapter.id)[0]!;
    expect(lib.store.panels.listByPage(page.id).flatMap((p) => p.script.dialogue.map((d) => d.kind))).toEqual(['narration', 'narration']);
    expect(lib.store.panels.listByPage(page.id).map((p) => p.refCharacterIds)).toEqual([[], []]);
    expect(entityEvents()).toEqual(['panel:updated', 'panel:updated']);
    expect(() => applyScripts({ store: lib.store, bus }, chapter.id, scripts(breakdown(2), 'Aiko')))
      .toThrow('the chapter has 1 pages but the scripts have 2; re-run the scripts step instead');
  });
});

describe('applyPrompts', () => {
  const LLM = { source: 'llm' } as const;
  function materialized(opts: { duo?: boolean } = {}) {
    const w = world();
    const bd = breakdown(1);
    const sc = scripts(bd, 'Aiko');
    if (opts.duo) {
      seedCharacter(lib.store, w.manga.id, 'Mika');
      sc.pages[0]!.panels[1]!.characters.push({ name: 'Mika', pose: 'sitting', expression: 'shy', position: 'right' });
    }
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, w.chapter.id, { breakdown: bd, scripts: sc, premise: PREMISE });
    const page = storyPages(lib.store, w.chapter.id)[0]!;
    const [a, b] = readingOrder(page.layout, w.manga.readingDirection).map((id) => lib.store.panels.require(id));
    const cover = lib.store.panels.listByPage(coverPageId)[0]!;
    events = [];
    return { ...w, a: a!, b: b!, cover };
  }

  it('finishes LLM scenes: camera framing from the script first, the model framing and forbidden words dropped (F2)', () => {
    const { chapter, a, b } = materialized();
    applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [
        { panelId: a.id, scene: 'from below, cowboy shot, 1girl, rain, speech bubble', negative: undefined },
        { panelId: b.id, scene: 'no humans, pier', negative: 'people' },
      ],
    }, LLM);
    // Both panels are medium/eye with one cast member (oneChar → a tags recipe): "upper body" goes first.
    expect(lib.store.panels.require(a.id).prompt).toEqual({ scene: 'upper body, 1girl, rain', negative: '' });
    expect(lib.store.panels.require(b.id).prompt).toEqual({ scene: 'upper body, no humans, pier', negative: 'people' });
    expect(entityEvents()).toEqual(['panel:updated', 'panel:updated']);
  });

  it('uses the style of the recipe each panel routes to (F3): the two-character cover gets a framing sentence', () => {
    const { chapter, a, cover } = materialized({ duo: true });
    applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [
        { panelId: a.id, scene: '1girl, rain', negative: undefined },
        { panelId: cover.id, scene: 'Close-up. Aiko and Mika stand on the pier at dusk.', negative: undefined },
      ],
    }, LLM);
    expect(lib.store.panels.require(a.id).prompt.scene).toBe('upper body, 1girl, rain');
    expect(lib.store.panels.require(cover.id).prompt.scene).toBe('Medium shot from a low angle. Aiko and Mika stand on the pier at dusk.');
  });

  it('strips chromatic colour words from a black-and-white manga, keeping black, white, grey and silver (Task 4 review M3)', () => {
    const { chapter, a, cover } = materialized({ duo: true });
    applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [
        { panelId: a.id, scene: '1girl, red umbrella, golden light, blue-green sea, orange, white dress, grey sky, silver hair, black cat', negative: undefined },
        { panelId: cover.id, scene: 'An orange sky glows above a red-haired girl in a crimson coat and a black scarf.', negative: undefined },
      ],
    }, LLM);
    expect(lib.store.panels.require(a.id).prompt.scene)
      .toBe('upper body, 1girl, umbrella, light, sea, white dress, grey sky, silver hair, black cat');
    expect(lib.store.panels.require(cover.id).prompt.scene)
      .toBe('Medium shot from a low angle. A sky glows above a girl in a coat and a black scarf.');
  });

  it('never strips a character whose name is a colour word (M1)', () => {
    const { chapter, manga, a, b } = materialized();
    seedCharacter(lib.store, manga.id, 'Amber');
    applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [
        { panelId: a.id, scene: '1girl, amber, amber lamp', negative: undefined },
        { panelId: b.id, scene: 'Amber holds an amber lamp', negative: undefined },
      ],
    }, LLM);
    // The name is masked as a whole word, case-insensitively: a colour word that is a character's name always stays.
    expect(lib.store.panels.require(a.id).prompt.scene).toBe('upper body, 1girl, amber, amber lamp');
    expect(lib.store.panels.require(b.id).prompt.scene).toBe('upper body, Amber holds an amber lamp');
  });

  it('keeps colour words in a colour manga', () => {
    const { chapter, manga, a } = materialized();
    lib.store.mangas.update(manga.id, { colorMode: 'color' });
    applyPrompts({ store: lib.store, bus }, chapter.id, { panels: [{ panelId: a.id, scene: '1girl, red umbrella', negative: undefined }] }, LLM);
    expect(lib.store.panels.require(a.id).prompt.scene).toBe('upper body, 1girl, red umbrella');
  });

  it('fails naming the panel when nothing usable is left, even after the colour strip, and writes nothing', () => {
    const { chapter, a, b } = materialized();
    const run = () => applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [{ panelId: a.id, scene: '1girl, rain', negative: undefined }, { panelId: b.id, scene: 'red, golden, cowboy shot', negative: undefined }],
    }, LLM);
    expect(run).toThrow(InvalidOutputError);
    expect(run).toThrow(`prompts: the AI wrote no usable scene for panel ${b.id}`);
    expect(lib.store.panels.require(a.id).prompt.scene).toBe('');
    expect(entityEvents()).toEqual([]);
  });

  it('stores user edits verbatim', () => {
    const { chapter, a, b } = materialized();
    applyPrompts({ store: lib.store, bus }, chapter.id, {
      panels: [{ panelId: a.id, scene: '1girl, rain', negative: undefined }, { panelId: b.id, scene: 'no humans, red pier', negative: 'people' }],
    }, { source: 'user' });
    expect(lib.store.panels.require(a.id).prompt).toEqual({ scene: '1girl, rain', negative: '' });
    expect(lib.store.panels.require(b.id).prompt).toEqual({ scene: 'no humans, red pier', negative: 'people' });
  });

  it('refuses panels of other chapters', () => {
    const { chapter } = materialized();
    for (const source of ['llm', 'user'] as const) {
      expect(() => applyPrompts({ store: lib.store, bus }, chapter.id, { panels: [{ panelId: 'pn_elsewhere', scene: 'x', negative: undefined }] }, { source }))
        .toThrow('panel pn_elsewhere is not part of this chapter');
    }
  });
});
