import type { EntityName, ServerEvent } from '@manga/shared';

export type BusListener = (event: ServerEvent) => void;

/** In-process pub/sub. One listener throwing must not stop the others, or break the emitter. */
export class EventBus {
  private readonly listeners = new Set<BusListener>();

  emit(event: ServerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[manga] event listener failed:', err);
      }
    }
  }

  on(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The one helper for entity events; api/util.ts re-exports it. M2/M4 import it from events/bus.js — never re-implement it. */
export function emitEntity(bus: EventBus, entity: EntityName, id: string, op: 'created' | 'updated' | 'deleted', mangaId: string | null): void {
  bus.emit({ type: 'entity', entity, id, op, mangaId });
}
