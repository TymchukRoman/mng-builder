import { describe, expect, it } from 'vitest';
import type { Box } from '@manga/shared';
import { MIN_FRAME, canRotate, defaultTail, dragBox, hasTail, nudgeBox, rotationFromPointer } from '../src/editor/frameDrag';
import { isTypingTarget, keyAction } from '../src/editor/keys';

function close(actual: Box, expected: Box): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.w).toBeCloseTo(expected.w, 9);
  expect(actual.h).toBeCloseTo(expected.h, 9);
}

const start: Box = { x: 0.1, y: 0.1, w: 0.3, h: 0.2 };

describe('dragBox', () => {
  it('moves and resizes from each corner', () => {
    close(dragBox(start, 'move', 0.05, -0.05), { x: 0.15, y: 0.05, w: 0.3, h: 0.2 });
    close(dragBox(start, 'se', 0.1, 0.1), { x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    close(dragBox(start, 'nw', 0.1, 0.05), { x: 0.2, y: 0.15, w: 0.2, h: 0.15 });
    close(dragBox(start, 'ne', 0.1, 0.05), { x: 0.1, y: 0.15, w: 0.4, h: 0.15 });
    close(dragBox(start, 'sw', -0.05, 0.1), { x: 0.05, y: 0.1, w: 0.35, h: 0.3 });
  });
  it('never shrinks below the minimum, even when dragged past the opposite edge', () => {
    close(dragBox(start, 'nw', 0.5, 0.5), { x: 0.38, y: 0.28, w: MIN_FRAME, h: MIN_FRAME });
    close(dragBox(start, 'se', -1, -1), { x: 0.1, y: 0.1, w: MIN_FRAME, h: MIN_FRAME });
  });
  it('nudges by screen pixels', () => {
    close(nudgeBox(start, 10, 10, { w: 200, h: 400 }), { x: 0.15, y: 0.125, w: 0.3, h: 0.2 });
  });
});

describe('rotation and tails', () => {
  it('measures clockwise degrees from straight up', () => {
    const c = { x: 0, y: 0 };
    expect(rotationFromPointer(c, { x: 0, y: -10 })).toBe(0);
    expect(rotationFromPointer(c, { x: 10, y: 0 })).toBe(90);
    expect(rotationFromPointer(c, { x: -10, y: 0 })).toBe(-90);
    expect(rotationFromPointer(c, { x: 0, y: 10 })).toBe(180);
  });
  it('knows which kinds have tails or rotate', () => {
    expect(['speech', 'thought', 'shout', 'narration', 'sfx', 'title'].filter((k) => hasTail(k as never))).toEqual(['speech', 'thought', 'shout']);
    expect(['speech', 'sfx', 'title'].filter((k) => canRotate(k as never))).toEqual(['sfx', 'title']);
    const t = defaultTail(start);
    expect(t.x).toBeCloseTo(0.19, 9);
    expect(t.y).toBeCloseTo(0.34, 9);
  });
});

describe('keys', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
    keyAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
  it('maps undo, redo, delete, escape', () => {
    expect(k('z', { ctrlKey: true })).toEqual({ type: 'undo' });
    expect(k('Z', { ctrlKey: true, shiftKey: true })).toEqual({ type: 'redo' });
    expect(k('y', { ctrlKey: true })).toEqual({ type: 'redo' });
    expect(k('z', { metaKey: true })).toEqual({ type: 'undo' });
    expect(k('Delete')).toEqual({ type: 'delete' });
    expect(k('Backspace')).toEqual({ type: 'delete' });
    expect(k('Escape')).toEqual({ type: 'escape' });
  });
  it('nudges by 1 px, or 10 px with Shift', () => {
    expect(k('ArrowLeft')).toEqual({ type: 'nudge', dx: -1, dy: 0 });
    expect(k('ArrowDown', { shiftKey: true })).toEqual({ type: 'nudge', dx: 0, dy: 10 });
  });
  it('ignores everything else', () => {
    expect(k('a')).toBeNull();
    expect(k('a', { ctrlKey: true })).toBeNull();
    expect(k('ArrowUp', { ctrlKey: true })).toBeNull();
  });
  it('recognises typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
