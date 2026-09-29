import type { EditorCommand } from './commands';

/** Old id → new id, for entities a revert or a redo re-created. Resolution follows chains. */
export class IdMap {
  private readonly map = new Map<string, string>();

  set(from: string, to: string): void {
    if (from !== to) this.map.set(from, to);
  }

  resolve(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      const next = this.map.get(cur);
      if (next === undefined || seen.has(cur)) return cur;
      seen.add(cur);
      cur = next;
    }
  }
}

export interface HistorySnapshot {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** The page of the command undo (redo) would run next, when it names one. */
  undoPageId: string | null;
  redoPageId: string | null;
  busy: boolean;
}

/**
 * Undo/redo stacks of API-backed commands. Every call runs on one promise chain, so a Ctrl+Z
 * pressed while a drag's request is in flight waits for it. Errors are re-thrown for the caller's toast.
 */
export class History {
  private undoStack: EditorCommand[] = [];
  private redoStack: EditorCommand[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private running = 0;
  private readonly listeners = new Set<() => void>();
  private snap: HistorySnapshot = this.compute();

  constructor(private readonly limit = 200) {}

  /** Applies `cmd`; only a successful apply is recorded (and clears the redo stack). */
  run(cmd: EditorCommand): Promise<void> {
    return this.enqueue(async () => {
      await cmd.apply();
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    });
  }

  /** A failed revert drops the command and the redo stack (the server state is no longer known). */
  undo(): Promise<boolean> {
    return this.enqueue(async () => {
      const cmd = this.undoStack.pop();
      if (!cmd) return false;
      try {
        await cmd.revert();
      } catch (err) {
        this.redoStack = [];
        throw err;
      }
      this.redoStack.push(cmd);
      return true;
    });
  }

  /** A failed redo drops the command and the rest of the redo stack. */
  redo(): Promise<boolean> {
    return this.enqueue(async () => {
      const cmd = this.redoStack.pop();
      if (!cmd) return false;
      try {
        await cmd.apply();
      } catch (err) {
        this.redoStack = [];
        throw err;
      }
      this.undoStack.push(cmd);
      return true;
    });
  }

  /**
   * Non-undoable operations (preset, merge): ordered with commands; both stacks are cleared on success,
   * because recorded commands can name split paths and panels that no longer exist.
   */
  barrier<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const out = await fn();
      this.undoStack = [];
      this.redoStack = [];
      return out;
    });
  }

  snapshot(): HistorySnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.running += 1;
    this.emit();
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p.finally(() => {
      this.running -= 1;
      this.emit();
    });
  }

  private emit(): void {
    this.snap = this.compute();
    for (const fn of [...this.listeners]) fn();
  }

  private compute(): HistorySnapshot {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      undoPageId: this.undoStack.at(-1)?.pageId ?? null,
      redoPageId: this.redoStack.at(-1)?.pageId ?? null,
      busy: this.running > 0,
    };
  }
}
