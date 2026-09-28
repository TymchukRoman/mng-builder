import { ApiError } from '../api';
import { createStore } from '../lib/store';

export interface Toast { id: number; kind: 'error' | 'info'; text: string }

const MAX_TOASTS = 4;
let nextId = 1;
export const toastStore = createStore<Toast[]>([]);

export function pushToast(kind: Toast['kind'], text: string, ttlMs = 6000): number {
  const toast: Toast = { id: nextId++, kind, text };
  toastStore.set([...toastStore.get(), toast].slice(-MAX_TOASTS));
  setTimeout(() => dismissToast(toast.id), ttlMs);
  return toast.id;
}

export function dismissToast(id: number): void {
  toastStore.set(toastStore.get().filter((t) => t.id !== id));
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
