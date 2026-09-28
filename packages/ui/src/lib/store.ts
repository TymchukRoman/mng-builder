import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(fn: () => void): () => void;
}

/** A minimal external store for UI-only state (theme, toasts, connection). */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
