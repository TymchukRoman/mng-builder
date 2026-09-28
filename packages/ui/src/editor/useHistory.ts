import { useSyncExternalStore } from 'react';
import type { History, HistorySnapshot } from './history';

export function useHistorySnapshot(history: History): HistorySnapshot {
  return useSyncExternalStore((fn) => history.subscribe(fn), () => history.snapshot(), () => history.snapshot());
}
