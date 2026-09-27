const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG image');
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') throw new Error('not a PNG image (no IHDR chunk)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
