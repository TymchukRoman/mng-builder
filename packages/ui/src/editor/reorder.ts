/** `toIndex` is an insertion index in the original list (0..length). */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex > from ? toIndex - 1 : toIndex));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** True when dropping `id` at `toIndex` leaves the order as it is (just above or below itself). */
export function isNoopMove(ids: readonly string[], id: string, toIndex: number): boolean {
  return moveId(ids, id, toIndex).every((x, i) => x === ids[i]);
}

/**
 * The insertion index for a pointer over a vertical list: before the first item whose midpoint is below the
 * pointer, else the end. So a drop in the gap between two items, or in the empty space below the last, still lands.
 */
export function dropIndex(items: readonly { top: number; height: number }[], pointerY: number): number {
  const i = items.findIndex((r) => pointerY < r.top + r.height / 2);
  return i < 0 ? items.length : i;
}
