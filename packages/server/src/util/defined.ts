/** T with `undefined` removed from every optional property (what exactOptionalPropertyTypes expects). */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops keys whose value is undefined. zod's partial() types allow `undefined`; repo patches do not. */
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}
