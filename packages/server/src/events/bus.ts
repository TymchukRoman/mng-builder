import type { ServerEvent } from '@manga/shared';

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
