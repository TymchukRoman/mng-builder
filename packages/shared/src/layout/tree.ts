import type { LayoutNode, ReadingDirection, SplitDir } from '../schemas.js';

export type LayoutErrorCode = 'not-found' | 'not-siblings' | 'unknown-preset';

export class LayoutError extends Error {
  constructor(public code: LayoutErrorCode, message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/** Steps from the root: 'a' = first child (top/left), 'b' = second child (bottom/right). */
export type SplitPath = Array<'a' | 'b'>;

/** Each side of a split keeps at least 8% of its parent. */
export const MIN_RATIO = 0.08;
export const MAX_RATIO = 0.92;

/** Depth-first, a before b. */
export function panelIds(tree: LayoutNode): string[] {
  return tree.type === 'panel' ? [tree.id] : [...panelIds(tree.a), ...panelIds(tree.b)];
}

function requirePanel(tree: LayoutNode, panelId: string): void {
  if (!panelIds(tree).includes(panelId)) throw new LayoutError('not-found', `panel ${panelId} is not in this layout`);
}

/** Replaces the leaf with a 50/50 split; the existing panel becomes `a`, the new one `b`. */
export function splitPanel(tree: LayoutNode, panelId: string, dir: SplitDir, newId: string): LayoutNode {
  requirePanel(tree, panelId);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'panel') {
      return node.id === panelId ? { type: 'split', dir, ratio: 0.5, a: node, b: { type: 'panel', id: newId } } : node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(tree);
}

/** Merges two panels that are the two leaves of the same split. Keeps A's id (and so A's content). */
export function mergePanels(tree: LayoutNode, a: string, b: string): { tree: LayoutNode; keptId: string; removedId: string } {
  requirePanel(tree, a);
  requirePanel(tree, b);
  let merged = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'panel') return node;
    const left = node.a;
    const right = node.b;
    if (
      left.type === 'panel' && right.type === 'panel' &&
      ((left.id === a && right.id === b) || (left.id === b && right.id === a))
    ) {
      merged = true;
      return { type: 'panel', id: a };
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  const next = walk(tree);
  if (!merged) throw new LayoutError('not-siblings', `panels ${a} and ${b} are not the two halves of one split`);
  return { tree: next, keptId: a, removedId: b };
}

function describePath(path: SplitPath): string {
  return path.length === 0 ? 'root' : path.join('');
}

/** Sets the ratio of the split at `path`, clamped to [MIN_RATIO, MAX_RATIO]. */
export function resizeSplit(tree: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  if (!Number.isFinite(ratio)) throw new RangeError('ratio must be a finite number');
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const walk = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.type === 'panel') throw new LayoutError('not-found', `no split at path ${describePath(path)}`);
    if (depth === path.length) return { ...node, ratio: clamped };
    return path[depth] === 'a' ? { ...node, a: walk(node.a, depth + 1) } : { ...node, b: walk(node.b, depth + 1) };
  };
  return walk(tree, 0);
}

/** Depth-first, top before bottom; across a vertical cut, right before left in RTL and left before right in LTR. */
export function readingOrder(tree: LayoutNode, dir: ReadingDirection): string[] {
  if (tree.type === 'panel') return [tree.id];
  const rightFirst = tree.dir === 'v' && dir === 'rtl';
  const first = rightFirst ? tree.b : tree.a;
  const second = rightFirst ? tree.a : tree.b;
  return [...readingOrder(first, dir), ...readingOrder(second, dir)];
}

/** Mirrors left↔right: swaps a/b of every 'v' split and sets ratio → 1 - ratio. 'h' splits keep their order. */
export function mirrorLayout(tree: LayoutNode): LayoutNode {
  if (tree.type === 'panel') return tree;
  if (tree.dir === 'v') {
    return { type: 'split', dir: 'v', ratio: 1 - tree.ratio, a: mirrorLayout(tree.b), b: mirrorLayout(tree.a) };
  }
  return { ...tree, a: mirrorLayout(tree.a), b: mirrorLayout(tree.b) };
}
