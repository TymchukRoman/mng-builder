import { createContext } from 'react';

/** Runs a non-undoable change in order with the editor's commands; on success both undo stacks are cleared. */
export type Barrier = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Provided by the chapter editor around its aside, so a change made outside the editor that deletes pages (a confirmed
 * episode re-run, F33) is a History barrier: undo and redo can no longer name the deleted pages. Null outside an editor.
 */
export const HistoryBarrierContext = createContext<Barrier | null>(null);
