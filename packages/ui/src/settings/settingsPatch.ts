import type { EngineName, RecipeInfo, ServiceState, ServiceStatus, Settings, SettingsPatch, Task } from '@manga/shared';
import { generationRecipes } from '../lib/recipes';

export type TaskChoice = 'default' | EngineName;
export type SaveSettings = (patch: SettingsPatch, opts?: { onError?: () => void }) => void;

export const TASKS: readonly Task[] = ['story', 'prompts', 'dialogue', 'review'];
export const TASK_LABEL: Record<Task, string> = { story: 'Story', prompts: 'Image prompts', dialogue: 'Dialogue', review: 'Image review' };

export function taskChoice(s: Settings, task: Task): TaskChoice {
  return s.engine.tasks[task] ?? 'default';
}

/** PATCH /api/settings replaces `engine.tasks` whole, so this always carries the complete map; "default" is the absence of a key. */
export function tasksPatch(s: Settings, task: Task, choice: TaskChoice): SettingsPatch {
  const tasks: Settings['engine']['tasks'] = {};
  for (const t of TASKS) {
    const v = t === task ? (choice === 'default' ? undefined : choice) : s.engine.tasks[t];
    if (v) tasks[t] = v;
  }
  return { engine: { tasks } };
}

export function effectiveEngine(s: Settings, task: Task): EngineName {
  return s.engine.tasks[task] ?? s.engine.mode;
}

export interface RecipeChoice { id: string; label: string }

/** The recipes a routing slot can point at. A saved id the server no longer lists stays selectable, so the select never shows a wrong value. */
export function routeChoices(recipes: readonly RecipeInfo[] | undefined, current: string | null): RecipeChoice[] {
  return withCurrent(generationRecipes(recipes), current);
}

/** B&W refine only ever runs `anime-refine` (or nothing, which the select adds itself). */
export function refineChoices(recipes: readonly RecipeInfo[] | undefined, current: string | null): RecipeChoice[] {
  return withCurrent((recipes ?? []).filter((r) => r.id === 'anime-refine'), current);
}

function withCurrent(list: readonly RecipeInfo[], current: string | null): RecipeChoice[] {
  const choices = list.map((r) => ({ id: r.id, label: r.label }));
  return current && !choices.some((c) => c.id === current) ? [{ id: current, label: current }, ...choices] : choices;
}

/** A blank model name is never saved; otherwise the trimmed value, or null when nothing changed. */
export function modelValue(draft: string, current: string): string | null {
  const v = draft.trim();
  return v && v !== current ? v : null;
}

export type ServiceTone = 'ok' | 'down' | 'unknown';
export function serviceView(state: ServiceState | undefined, failed = false): { tone: ServiceTone; text: string } {
  if (failed) return { tone: 'down', text: 'Server not reachable' };
  if (!state) return { tone: 'unknown', text: 'Checking' };
  return { tone: state.ok ? 'ok' : 'down', text: state.detail || (state.ok ? 'Ready' : 'Unavailable') };
}

/** Tooltip text for the services card header, or undefined until the first status arrives. */
export function queueSummary(status: ServiceStatus | undefined): string | undefined {
  return status ? `${status.queue.running} running, ${status.queue.queued} queued` : undefined;
}

/** Mirrors the server's `mergeSettings`: `engine.tasks` is replaced whole, every other section merges per key. */
export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  return {
    engine: { mode: patch.engine?.mode ?? base.engine.mode, tasks: patch.engine?.tasks ?? base.engine.tasks },
    claude: { models: mergeDefined(base.claude.models, patch.claude?.models) },
    ollama: mergeDefined(base.ollama, patch.ollama),
    review: mergeDefined(base.review, patch.review),
    routing: mergeDefined(base.routing, patch.routing),
    episode: mergeDefined(base.episode, patch.episode),
  };
}

/** Like the server's spread-merge after JSON: a key the patch leaves undefined keeps the base value. */
function mergeDefined<T extends object>(base: T, patch: { [K in keyof T]?: T[K] | undefined } | undefined): T {
  const out = { ...base };
  for (const k of Object.keys(patch ?? {}) as Array<keyof T>) {
    const v = patch?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
