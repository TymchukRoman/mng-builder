import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type RecipeInfo, type Settings } from '@manga/shared';
import { applySettingsPatch, effectiveEngine, modelValue, queueSummary, refineChoices, routeChoices, serviceView, taskChoice, tasksPatch } from '../src/settings/settingsPatch';

const withTasks = (tasks: Settings['engine']['tasks']): Settings => ({ ...DEFAULT_SETTINGS, engine: { mode: 'claude', tasks } });

describe('engine task overrides', () => {
  it('reads the per-task choice', () => {
    expect(taskChoice(withTasks({ review: 'local' }), 'review')).toBe('local');
    expect(taskChoice(withTasks({}), 'story')).toBe('default');
  });
  it('sends the whole tasks map, dropping defaults', () => {
    const s = withTasks({ review: 'local', story: 'claude' });
    expect(tasksPatch(s, 'prompts', 'local')).toEqual({ engine: { tasks: { story: 'claude', prompts: 'local', review: 'local' } } });
    expect(tasksPatch(s, 'review', 'default')).toEqual({ engine: { tasks: { story: 'claude' } } });
  });
  it('resolves the engine a task will use', () => {
    expect(effectiveEngine(withTasks({ review: 'local' }), 'review')).toBe('local');
    expect(effectiveEngine(withTasks({}), 'story')).toBe('claude');
  });
});

const recipe = (id: string): RecipeInfo => ({
  id, label: `${id} label`, maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
});
const RECIPES = ['anime', 'anime-ref', 'anime-refine', 'upscale'].map(recipe);

describe('routing choices', () => {
  it('offers generation recipes only', () => {
    expect(routeChoices(RECIPES, 'anime').map((c) => c.id)).toEqual(['anime', 'anime-ref']);
  });
  it('keeps a saved id the server no longer lists, first', () => {
    expect(routeChoices(RECIPES, 'gone').map((c) => c.id)).toEqual(['gone', 'anime', 'anime-ref']);
    expect(routeChoices(undefined, 'anime')).toEqual([{ id: 'anime', label: 'anime' }]);
  });
  it('offers only anime-refine for the B&W refine pass, and nothing extra when it is off', () => {
    expect(refineChoices(RECIPES, null).map((c) => c.id)).toEqual(['anime-refine']);
    expect(refineChoices(RECIPES, 'anime-refine').map((c) => c.id)).toEqual(['anime-refine']);
  });
});

describe('model names and service rows', () => {
  it('never saves a blank or unchanged model name', () => {
    expect(modelValue('  ', 'opus')).toBeNull();
    expect(modelValue('opus', 'opus')).toBeNull();
    expect(modelValue(' sonnet ', 'opus')).toBe('sonnet');
  });
  it('describes a service check', () => {
    expect(serviceView(undefined)).toEqual({ tone: 'unknown', text: 'Checking' });
    expect(serviceView({ ok: true, detail: '' })).toEqual({ tone: 'ok', text: 'Ready' });
    expect(serviceView({ ok: false, detail: '' })).toEqual({ tone: 'down', text: 'Unavailable' });
    expect(serviceView({ ok: false, detail: 'refused' })).toEqual({ tone: 'down', text: 'refused' });
  });
});

describe('optimistic settings patch', () => {
  it('replaces engine.tasks whole and merges every other section per key, like the server', () => {
    const base = withTasks({ review: 'local', story: 'claude' });
    expect(applySettingsPatch(base, { engine: { tasks: { prompts: 'local' } } }).engine).toEqual({ mode: 'claude', tasks: { prompts: 'local' } });
    expect(applySettingsPatch(base, { engine: { mode: 'local' } }).engine).toEqual({ mode: 'local', tasks: { review: 'local', story: 'claude' } });
    const next = applySettingsPatch(base, { claude: { models: { story: 'haiku' } }, ollama: { textModel: 'x' }, review: { rounds: 4 }, routing: { bwRefine: 'anime-refine' } });
    expect(next.claude.models).toEqual({ ...DEFAULT_SETTINGS.claude.models, story: 'haiku' });
    expect(next.ollama).toEqual({ ...DEFAULT_SETTINGS.ollama, textModel: 'x' });
    expect(next.review).toEqual({ ...DEFAULT_SETTINGS.review, rounds: 4 });
    expect(next.routing).toEqual({ ...DEFAULT_SETTINGS.routing, bwRefine: 'anime-refine' });
    expect(base.engine.tasks).toEqual({ review: 'local', story: 'claude' });
  });

  it('merges the episode section per key and keeps it on other patches (W1)', () => {
    const base = withTasks({});
    const next = applySettingsPatch(base, { episode: { confirmRenderMinutes: 90 } });
    expect(next.episode).toEqual({ confirmRenderMinutes: 90 });
    expect(applySettingsPatch(next, { review: { rounds: 1 } }).episode).toEqual({ confirmRenderMinutes: 90 });
    expect(applySettingsPatch(next, { episode: { confirmRenderMinutes: undefined } }).episode).toEqual({ confirmRenderMinutes: 90 });
    expect(base.episode).toEqual({ confirmRenderMinutes: 45 });
  });

  it('carries the first override in the second body when built from the optimistic cache', () => {
    const cache0 = withTasks({});
    const first = tasksPatch(cache0, 'story', 'local');
    const cache1 = applySettingsPatch(cache0, first);
    expect(tasksPatch(cache1, 'review', 'local')).toEqual({ engine: { tasks: { story: 'local', review: 'local' } } });
    // built from the stale render-time settings instead, the first override would be dropped
    expect(tasksPatch(cache0, 'review', 'local')).toEqual({ engine: { tasks: { review: 'local' } } });
  });
});

describe('services card', () => {
  it('shows every row as unreachable when the status request fails', () => {
    expect(serviceView(undefined, true)).toEqual({ tone: 'down', text: 'Server not reachable' });
    expect(serviceView({ ok: true, detail: 'x' }, true).tone).toBe('down');
  });
  it('summarises the queue for the header tooltip', () => {
    expect(queueSummary(undefined)).toBeUndefined();
    expect(queueSummary({ claude: { ok: true, detail: '' }, ollama: { ok: true, detail: '' }, comfy: { ok: true, detail: '' }, queue: { running: 1, queued: 3, pausedLanes: [] } })).toBe('1 running, 3 queued');
  });
});
