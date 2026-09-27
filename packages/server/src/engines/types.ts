import type { z } from 'zod';
import type { EngineName, ServiceState, Task } from '@manga/shared';

export interface JsonRequest<T> {
  /** Stable id for logs and fakes, e.g. 'panel-prompt', 'appearance', 'review', 'episode.premise'. */
  name: string;
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Absolute file paths (vision). */
  images?: string[];
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
}

export interface TextEngine {
  readonly name: EngineName;
  completeJson<T>(req: JsonRequest<T>): Promise<T>;
  health(): Promise<ServiceState>;
}
