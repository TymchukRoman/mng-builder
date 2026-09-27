import { expect } from 'vitest';
import { nodesOf, type ComfyGraph } from '../../src/imaging/comfy-graph.js';
import type { RecipeParams } from '../../src/imaging/recipes/types.js';

export function params(over: Partial<RecipeParams> = {}): RecipeParams {
  return {
    prompt: 'POS', negative: 'NEG', width: 832, height: 1216, seed: 42, steps: 10, cfg: 5, loras: [], refs: [], refWeight: 0.4,
    control: null, init: null, upscale: null, filenamePrefix: 'manga-builder/test', ...over,
  };
}

export function classes(graph: ComfyGraph): string[] {
  return Object.values(graph).map((n) => n.class_type).sort();
}

export function one(graph: ComfyGraph, classType: string): { id: string; inputs: Record<string, unknown> } {
  const found = nodesOf(graph, classType);
  expect(found, classType).toHaveLength(1);
  return found[0]!;
}

/** class_type of the node a link points at. */
export function source(graph: ComfyGraph, link: unknown): string {
  const [id] = link as [string, number];
  return graph[id]!.class_type;
}

/** Every [nodeId, slot] input points at a node that exists. */
export function expectLinked(graph: ComfyGraph): void {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
        expect(graph[value[0]], `${id}.${key} → ${value[0]}`).toBeDefined();
      }
    }
  }
}
