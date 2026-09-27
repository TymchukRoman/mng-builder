import type { EngineName, Lane, Settings, Task } from '@manga/shared';
import type { TextEngine } from './types.js';

export function resolveEngine(settings: Settings, task: Task): EngineName {
  return settings.engine.tasks[task] ?? settings.engine.mode;
}

export class Engines {
  constructor(private readonly opts: { settings: () => Settings; claude: TextEngine; local: TextEngine }) {}

  for(task: Task): TextEngine {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? this.opts.claude : this.opts.local;
  }

  /** Claude work runs in the 'claude' lane; local LLM work shares the GPU with ComfyUI. */
  laneFor(task: Task): Lane {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? 'claude' : 'gpu';
  }
}
