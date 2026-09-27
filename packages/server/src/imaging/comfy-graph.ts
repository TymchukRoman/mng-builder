/** ComfyUI API-format graph: node id → { class_type, inputs }. A link is [nodeId, outputSlot]. */
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type Link = [string, number];

export function nodesOf(graph: ComfyGraph, classType: string): Array<{ id: string; inputs: Record<string, unknown> }> {
  return Object.entries(graph)
    .filter(([, node]) => node.class_type === classType)
    .map(([id, node]) => ({ id, inputs: node.inputs }));
}
