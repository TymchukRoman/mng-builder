import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type RecipeInfo, type Settings } from '@manga/shared';
import { effectiveEngine, modelValue, refineChoices, routeChoices, serviceView, taskChoice, tasksPatch } from '../src/settings/settingsPatch';

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
