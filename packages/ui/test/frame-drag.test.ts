import { describe, expect, it } from 'vitest';
import type { Box } from '@manga/shared';
import { MIN_FRAME, canRotate, clampBox, defaultTail, dragBox, hasTail, moveFrame, rotationFromPointer } from '../src/editor/frameDrag';
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
});

describe('page clamp', () => {
  it('clampBox keeps the box on the page and caps its size', () => {
    close(clampBox({ x: -0.2, y: 0.9, w: 0.3, h: 0.2 }), { x: 0, y: 0.8, w: 0.3, h: 0.2 });
    close(clampBox({ x: 0.5, y: 0.5, w: 2, h: 3 }), { x: 0, y: 0, w: 1, h: 1 });
    close(clampBox(start), start);
  });
  it('a move past each page edge stays on the page', () => {
    close(dragBox(start, 'move', -1, 0), { x: 0, y: 0.1, w: 0.3, h: 0.2 });
    close(dragBox(start, 'move', 5, 0), { x: 0.7, y: 0.1, w: 0.3, h: 0.2 });
    close(dragBox(start, 'move', 0, -1), { x: 0.1, y: 0, w: 0.3, h: 0.2 });
    close(dragBox(start, 'move', 0, 5), { x: 0.1, y: 0.8, w: 0.3, h: 0.2 });
  });
  it('a corner drag past the page edge is clamped and the opposite edge stays put', () => {
    close(dragBox(start, 'nw', -1, -1), { x: 0, y: 0, w: 0.4, h: 0.3 });
    close(dragBox(start, 'se', 5, 5), { x: 0.1, y: 0.1, w: 0.9, h: 0.9 });
    close(dragBox(start, 'ne', 5, -1), { x: 0.1, y: 0, w: 0.9, h: 0.3 });
    close(dragBox(start, 'sw', -1, 5), { x: 0, y: 0.1, w: 0.4, h: 0.9 });
  });
  it('moveFrame moves the tail by the same delta as the box', () => {
    const r = moveFrame({ box: start, tail: { x: 0.2, y: 0.4 } }, 0.05, -0.05);
    close(r.box, { x: 0.15, y: 0.05, w: 0.3, h: 0.2 });
    expect(r.tail?.x).toBeCloseTo(0.25, 9);
    expect(r.tail?.y).toBeCloseTo(0.35, 9);
  });
  it('moveFrame translates the tail by the effective (post-clamp) delta', () => {
    const right = moveFrame({ box: start, tail: { x: 0.2, y: 0.4 } }, 2, 0);
    close(right.box, { x: 0.7, y: 0.1, w: 0.3, h: 0.2 });
    expect(right.tail?.x).toBeCloseTo(0.8, 9);
    expect(right.tail?.y).toBeCloseTo(0.4, 9);
    const up = moveFrame({ box: start, tail: { x: 0.2, y: 0.4 } }, -1, -1);
    close(up.box, { x: 0, y: 0, w: 0.3, h: 0.2 });
    expect(up.tail?.x).toBeCloseTo(0.1, 9);
    expect(up.tail?.y).toBeCloseTo(0.3, 9);
  });
  it('moveFrame keeps a null tail null', () => {
    expect(moveFrame({ box: start, tail: null }, 0.1, 0.1).tail).toBeNull();
    expect(moveFrame({ box: start, tail: null }, 5, 5).tail).toBeNull();
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
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
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
  it('leaves Alt combinations to the browser', () => {
    expect(k('ArrowLeft', { altKey: true })).toBeNull();
    expect(k('Delete', { altKey: true })).toBeNull();
    expect(k('z', { ctrlKey: true, altKey: true })).toBeNull();
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
