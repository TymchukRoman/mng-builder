export type IdPrefix = 'mg' | 'cr' | 'ch' | 'pg' | 'pn' | 'tf' | 'im' | 'jb' | 'er' | 'ar';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 10 chars from 'abcdefghijklmnopqrstuvwxyz234567' via globalThis.crypto.getRandomValues, e.g. newId('mg') → 'mg_k3j9x2abq7'. */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte & 31);
  return `${prefix}_${out}`;
}
