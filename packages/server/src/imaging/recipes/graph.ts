import type { ComfyGraph, Link } from '../comfy-graph.js';

/** Builds an API-format graph with sequential string ids '1', '2', … in insertion order. */
export class GraphBuilder {
  readonly graph: ComfyGraph = {};
  private next = 1;

  add(classType: string, inputs: Record<string, unknown>): string {
    const id = String(this.next);
    this.next += 1;
    this.graph[id] = { class_type: classType, inputs };
    return id;
  }
}

export function out(id: string, slot = 0): Link {
  return [id, slot];
}
