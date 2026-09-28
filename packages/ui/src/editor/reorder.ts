/** `toIndex` is an insertion index in the original list (0..length). */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex > from ? toIndex - 1 : toIndex));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export function dropIndex(itemTop: number, itemHeight: number, pointerY: number, index: number): number {
  return pointerY < itemTop + itemHeight / 2 ? index : index + 1;
}
