import type { ServiceStatus } from './api.js';
import type { Job } from './schemas.js';

export type EntityName = 'manga' | 'character' | 'chapter' | 'page' | 'panel' | 'textFrame' | 'image' | 'episodeRun' | 'settings';
export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'entity'; entity: EntityName; id: string; op: 'created' | 'updated' | 'deleted'; mangaId: string | null }
  | { type: 'status'; status: ServiceStatus }
  | { type: 'hello'; serverTime: string };
