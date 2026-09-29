import type { IdPrefix } from '@manga/shared';

/** The body of every id `newId` (@manga/shared) makes: lowercase base32, 'a'-'z' and '2'-'7'. */
const BODY = '[a-z2-7]+';

/**
 * Whether a route param is an id of this kind (I1). Routes check their params with this before any request, so a crafted
 * link (slashes, `?`, `%`, dot segments) renders "not found" instead of reaching the API.
 */
export function isId(value: string | undefined, prefix: IdPrefix): value is string {
  return value !== undefined && new RegExp(`^${prefix}_${BODY}$`).test(value);
}
