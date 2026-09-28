import { describe, expect, it } from 'vitest';
import type { EditorCommand } from '../src/editor/commands';
import { History, IdMap } from '../src/editor/history';

function cmd(label: string, log: string[], opts: { failRevert?: boolean; failApply?: boolean; gate?: Promise<void> } = {}): EditorCommand {
  return {
    label,
    async apply() {
      log.push(`apply ${label}`);
      if (opts.gate) await opts.gate;
      if (opts.failApply) throw new Error(`apply ${label} failed`);
      log.push(`applied ${label}`);
    },
    async revert() {
      if (opts.failRevert) throw new Error(`revert ${label} failed`);
      log.push(`revert ${label}`);
    },
  };
}

describe('History', () => {
  it('runs, undoes and redoes with labels', async () => {
    const log: string[] = [];
    const h = new History();
    await h.run(cmd('A', log));
    expect(h.snapshot()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'A' });
    expect(await h.undo()).toBe(true);
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'A' });
    expect(await h.redo()).toBe(true);
    expect(log).toEqual(['apply A', 'applied A', 'revert A', 'apply A', 'applied A']);
    expect(await h.redo()).toBe(false);
  });

  it('a new command clears the redo stack', async () => {
    const h = new History();
    await h.run(cmd('A', []));
    await h.undo();
    await h.run(cmd('B', []));
    expect(h.snapshot().canRedo).toBe(false);
  });

  it('keeps at most `limit` commands', async () => {
    const h = new History(3);
    for (const l of ['A', 'B', 'C', 'D']) await h.run(cmd(l, []));
    let undone = 0;
    while (await h.undo()) undone += 1;
    expect(undone).toBe(3);
  });

  it('serialises overlapping calls', async () => {
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const h = new History();
    const running = h.run(cmd('A', log, { gate }));
    const undoing = h.undo();
    expect(h.snapshot().busy).toBe(true);
    open();
    await running;
    expect(await undoing).toBe(true);
    expect(log).toEqual(['apply A', 'applied A', 'revert A']);
    expect(h.snapshot().busy).toBe(false);
  });

  it('does not record a failed apply', async () => {
    const h = new History();
    await expect(h.run(cmd('A', [], { failApply: true }))).rejects.toThrow('apply A failed');
    expect(h.snapshot().canUndo).toBe(false);
  });

  it('a failed undo drops the redo stack', async () => {
    const h = new History();
    await h.run(cmd('A', [], { failRevert: true }));
    await h.run(cmd('B', []));
    await h.undo();
    expect(h.snapshot().canRedo).toBe(true);
    await expect(h.undo()).rejects.toThrow('revert A failed');
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('a failed redo drops the redo stack and keeps the queue usable', async () => {
    let fail = false;
    const flaky: EditorCommand = {
      label: 'F',
      async apply() { if (fail) throw new Error('redo F failed'); },
      async revert() {},
    };
    const h = new History();
    await h.run(flaky);
    await h.run(cmd('B', []));
    await h.undo();
    await h.undo();
    fail = true;
    await expect(h.redo()).rejects.toThrow('redo F failed');
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: false });
    await h.run(cmd('C', []));
    expect(h.snapshot().undoLabel).toBe('C');
  });

  it('barrier clears both stacks only after success', async () => {
    const h = new History();
    await h.run(cmd('A', []));
    await expect(h.barrier(async () => { throw new Error('needs confirm'); })).rejects.toThrow('needs confirm');
    expect(h.snapshot().canUndo).toBe(true);
    expect(await h.barrier(async () => 42)).toBe(42);
    expect(h.snapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('notifies subscribers and keeps a stable snapshot between changes', async () => {
    const h = new History();
    let calls = 0;
    const off = h.subscribe(() => { calls += 1; });
    const s1 = h.snapshot();
    expect(h.snapshot()).toBe(s1);
    await h.run(cmd('A', []));
    expect(calls).toBeGreaterThan(0);
    expect(h.snapshot()).not.toBe(s1);
    off();
  });
});

describe('IdMap', () => {
  it('follows chains and ignores self-maps and cycles', () => {
    const ids = new IdMap();
    ids.set('a', 'b');
    ids.set('b', 'c');
    ids.set('x', 'x');
    expect(ids.resolve('a')).toBe('c');
    expect(ids.resolve('x')).toBe('x');
    expect(ids.resolve('zzz')).toBe('zzz');
    ids.set('c', 'a');
    expect(['a', 'b', 'c']).toContain(ids.resolve('a'));
  });
});
