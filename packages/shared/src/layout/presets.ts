import type { LayoutNode, ReadingDirection, SplitDir } from '../schemas.js';
import { LayoutError, mirrorLayout } from './tree.js';

/** A preset template: '_' is a panel; a tuple is a split [dir, ratio, a, b]. Authored LTR. */
type Template = '_' | readonly [SplitDir, number, Template, Template];

const _ = '_' as const;
const h = (ratio: number, a: Template, b: Template): Template => ['h', ratio, a, b];
const v = (ratio: number, a: Template, b: Template): Template => ['v', ratio, a, b];
const pair = (): Template => v(1 / 2, _, _);

/** The 16 presets from spec §5, in spec order. Defined once; RTL variants come from mirrorLayout. */
const TEMPLATES: Record<string, Template> = {
  'splash': _,
  '2-rows': h(1 / 2, _, _),
  '3-rows': h(1 / 3, _, h(1 / 2, _, _)),
  '4-rows': h(1 / 2, h(1 / 2, _, _), h(1 / 2, _, _)),
  '2x2': h(1 / 2, pair(), pair()),
  '2x3': h(1 / 3, pair(), h(1 / 2, pair(), pair())),
  'big-top-2': h(0.6, _, pair()),
  'big-top-3': h(0.55, _, v(1 / 3, _, v(1 / 2, _, _))),
  'big-bottom-2': h(0.4, pair(), _),
  '2-big-bottom': h(0.4, h(1 / 2, _, _), _),
  'left-tall-2': v(1 / 2, _, h(1 / 2, _, _)),
  'right-tall-2': v(1 / 2, h(1 / 2, _, _), _),
  '3-rows-mid-split': h(1 / 3, _, h(1 / 2, pair(), _)),
  'row-2-1-2': h(1 / 3, pair(), h(1 / 2, _, pair())),
  'cinematic-3': h(0.25, _, h(2 / 3, _, _)),
  '5-stagger': h(1 / 3, v(0.62, _, _), h(1 / 2, v(0.38, _, _), _)),
};

export const PRESET_NAMES: readonly string[] = Object.freeze(Object.keys(TEMPLATES));

function template(name: string): Template {
  const found = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : undefined;
  if (found === undefined) throw new LayoutError('unknown-preset', `unknown layout preset "${name}"`);
  return found;
}

function countPanels(t: Template): number {
  return t === '_' ? 1 : countPanels(t[2]) + countPanels(t[3]);
}

function instantiate(t: Template, newId: () => string): LayoutNode {
  if (t === '_') return { type: 'panel', id: newId() };
  const [dir, ratio, a, b] = t;
  const first = instantiate(a, newId);
  const second = instantiate(b, newId);
  return { type: 'split', dir, ratio, a: first, b: second };
}

export function presetPanelCount(name: string): number {
  return countPanels(template(name));
}

/** Builds the LTR-authored preset with fresh ids (depth-first), mirrored when dir === 'rtl'. */
export function buildPreset(name: string, dir: ReadingDirection, newId: () => string): LayoutNode {
  const tree = instantiate(template(name), newId);
  return dir === 'rtl' ? mirrorLayout(tree) : tree;
}
