import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appearanceStep } from '../src/handlers/appearance.js';
import { panelPromptStep } from '../src/handlers/panel-prompt.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { PermanentError } from '../src/jobs/index.js';
import { loadPrompt } from '../src/prompts/load.js';
import { NotFoundError } from '../src/store/index.js';
import { handlerServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
const comfy = new ComfyClient({ url: 'http://127.0.0.1:9', launcher: null });
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

const stage = (characterId: string, position: 'left' | 'center' | 'right' = 'center') => ({ characterId, pose: 'standing', expression: 'calm', position });

describe('llm.step panel-prompt', () => {
  it('writes sanitized Danbooru tags for anime-routed panels without appearance in the request', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { 'panel-prompt': () => ({ scene: 'solo, speech bubble, standing, manga, rooftop, Solo' }) } });
    const { manga, panels } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: '', negative: 'keep me' } });
    const payload = { type: 'panel-prompt' as const, panelId: panel.id };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(panelPromptStep(services)(ctx, payload)).resolves.toEqual({ scene: 'solo, standing, rooftop' });
    expect(lib.store.panels.require(panel.id).prompt).toEqual({ scene: 'solo, standing, rooftop', negative: 'keep me' });
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'panel-prompt', task: 'prompts', system: loadPrompt('panel-prompt-tags') });
    expect(call.prompt).toContain('1. Aiko: position center; pose: standing; expression: calm');
    expect(call.prompt).not.toContain('silver hair');
    expect(call.prompt.endsWith('Write the scene tags for this panel.')).toBe(true);
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: panel.id, op: 'updated', mangaId: manga.id });
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'panel' && e.op === 'updated')).toHaveLength(1);
  });

  it('writes sentences with picture numbers when the panel routes to qwen-edit-ref', async () => {
    const services = handlerServices(lib.store, comfy, {
      claude: { 'panel-prompt': () => ({ scene: 'The character from picture 1 shouts at the character from picture 2, no speech bubbles.' }) },
    });
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const ren = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Ren', '1boy'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(ren.id, 'right')] }, { refCharacterIds: [aiko.id, ren.id] });
    const payload = { type: 'panel-prompt' as const, panelId: panel.id };
    await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload);
    const call = services.claude.calls[0]!;
    expect(call.system).toBe(loadPrompt('panel-prompt-natural'));
    expect(call.prompt).toContain('- picture 1 shows Aiko');
    expect(call.prompt).toContain('- picture 2 shows Ren');
    expect(lib.store.panels.require(panel.id).prompt.scene).toBe('The character from picture 1 shouts at the character from picture 2.');
  });

  it('refuses an answer made only of forbidden words', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { 'panel-prompt': () => ({ scene: 'manga, speech bubble, text' }) } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    const err = await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect(lib.store.panels.require(panels[0]!.id).prompt.scene).toBe('');
  });

  it('refuses an answer that sanitizes down to only punctuation', async () => {
    // "..." is not a forbidden word, so sanitizeTags keeps it as a tag — the near-empty check (m2-rulings Task
    // 20 addition) must still catch it, since no letter or digit survived.
    const services = handlerServices(lib.store, comfy, { claude: { 'panel-prompt': () => ({ scene: '...' }) } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    const err = await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).message).toBe('panel-prompt: the AI wrote no usable scene');
    expect(lib.store.panels.require(panels[0]!.id).prompt.scene).toBe('');
  });

  it('rejects without crashing when the panel is deleted while the engine is writing the scene', async () => {
    const { panels } = seedManga(lib.store);
    const panelId = panels[0]!.id;
    const services = handlerServices(lib.store, comfy, {
      // Scripted engines answer in-process (no real network round trip like ComfyUI's), so the delete happens
      // from the answer hook itself — the same "mid-flight owner deletion" shape as Tasks 15/17/19's hooks.
      claude: { 'panel-prompt': () => { lib.store.panels.delete(panelId); return { scene: 'solo, standing, rooftop' }; } },
    });
    const payload = { type: 'panel-prompt' as const, panelId };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(panelPromptStep(services)(ctx, payload)).rejects.toThrow(NotFoundError);
    expect(events.some((e) => e.type === 'entity' && e.entity === 'panel' && e.op === 'updated')).toBe(false);
  });

  it('runs a gpu-lane job on the local engine (I1: the lane decides the engine)', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { tasks: { prompts: 'local' } } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload, { lane: 'gpu' }).ctx, payload);
    expect(services.local.calls).toHaveLength(1);
    expect(services.claude.calls).toHaveLength(0);
  });

  it('runs a job that stays in the claude lane on Claude, even when the settings now say local (I1)', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { mode: 'local' } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload, { lane: 'claude' }).ctx, payload);
    expect(services.claude.calls).toHaveLength(1);
    expect(services.local.calls).toHaveLength(0);
  });

  it('rejects a payload of another type', async () => {
    const services = handlerServices(lib.store, comfy);
    const payload = { type: 'appearance' as const, characterId: 'cr_other000001', description: 'x' };
    await expect(panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload)).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('llm.step appearance', () => {
  it('turns a description into normalized appearance tags on the character', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { appearance: () => ({ appearanceTags: '1girl, Silver Hair, twintails, silver hair, manga' }) } });
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const payload = { type: 'appearance' as const, characterId: aiko.id, description: 'A girl with silver twin-tails.' };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(appearanceStep(services)(ctx, payload)).resolves.toEqual({ appearanceTags: '1girl, silver hair, twintails' });
    expect(lib.store.characters.require(aiko.id).appearanceTags).toBe('1girl, silver hair, twintails');
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'appearance', task: 'prompts', system: loadPrompt('appearance') });
    expect(call.prompt).toContain('A girl with silver twin-tails.');
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: aiko.id, op: 'updated', mangaId: manga.id });
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'character' && e.op === 'updated')).toHaveLength(1);
  });

  it('follows the job lane, not the live settings, for the engine (I1)', async () => {
    const services = handlerServices(lib.store, comfy);
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const payload = { type: 'appearance' as const, characterId: aiko.id, description: 'A girl with silver hair.' };
    lib.store.settings.patch({ engine: { mode: 'local' } });
    await appearanceStep(services)(jobContext(lib.store, 'llm.step', payload, { lane: 'claude' }).ctx, payload);
    expect([services.claude.calls.length, services.local.calls.length]).toEqual([1, 0]);
    lib.store.settings.patch({ engine: { mode: 'claude' } });
    await appearanceStep(services)(jobContext(lib.store, 'llm.step', payload, { lane: 'gpu' }).ctx, payload);
    expect([services.claude.calls.length, services.local.calls.length]).toEqual([1, 1]);
  });

  it('fails without touching the existing tags when the answer is only forbidden words', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { appearance: () => ({ appearanceTags: 'manga, speech bubble' }) } });
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
    const payload = { type: 'appearance' as const, characterId: aiko.id, description: 'A girl with silver hair.' };
    const err = await appearanceStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).message).toBe('appearance: the AI wrote no usable appearance tags');
    expect(lib.store.characters.require(aiko.id).appearanceTags).toBe('1girl, silver hair');
  });

  it('rejects without crashing when the character is deleted while the engine is answering', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const services = handlerServices(lib.store, comfy, {
      claude: { appearance: () => { lib.store.characters.delete(aiko.id); return { appearanceTags: '1girl, silver hair' }; } },
    });
    const payload = { type: 'appearance' as const, characterId: aiko.id, description: 'A girl with silver hair.' };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(appearanceStep(services)(ctx, payload)).rejects.toThrow(NotFoundError);
    expect(events.some((e) => e.type === 'entity' && e.entity === 'character' && e.op === 'updated')).toBe(false);
  });
});
