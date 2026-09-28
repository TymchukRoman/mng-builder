import { ApiError } from '../api';
import { createStore } from '../lib/store';

export interface Toast { id: number; kind: 'error' | 'info'; text: string }

const MAX_TOASTS = 4;
let nextId = 1;
export const toastStore = createStore<Toast[]>([]);

// One ttl timer per live toast id, so a manual dismiss can cancel the pending auto-expiry instead of
// leaving a stale timer running.
const ttlTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function pushToast(kind: Toast['kind'], text: string, ttlMs = 6000): number {
  const toast: Toast = { id: nextId++, kind, text };
  toastStore.set([...toastStore.get(), toast].slice(-MAX_TOASTS));
  ttlTimers.set(toast.id, setTimeout(() => dismissToast(toast.id), ttlMs));
  return toast.id;
}

export function dismissToast(id: number): void {
  const timer = ttlTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    ttlTimers.delete(id);
  }
  toastStore.set(toastStore.get().filter((t) => t.id !== id));
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
