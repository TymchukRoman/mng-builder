export interface ImageMeta { format: 'png' | 'jpeg'; width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
/** Start-of-frame markers that carry dimensions (C4 DHT, C8 JPG and CC DAC are not frames). */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const at = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16 = (b: Uint8Array, i: number): number => (at(b, i) << 8) | at(b, i + 1);
const u32 = (b: Uint8Array, i: number): number => ((at(b, i) << 24) >>> 0) + (at(b, i + 1) << 16) + (at(b, i + 2) << 8) + at(b, i + 3);

function readPng(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return null;
  if (!IHDR.every((byte, i) => b[12 + i] === byte)) return null;
  const width = u32(b, 16);
  const height = u32(b, 20);
  return width > 0 && height > 0 ? { format: 'png', width, height } : null;
}

function readJpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = at(b, i + 1);
    while (marker === 0xff && i + 2 < b.length) {
      i += 1; // fill byte
      marker = at(b, i + 1);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan data before any frame header
    const length = u16(b, i + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (i + 8 >= b.length) return null;
      const height = u16(b, i + 5);
      const width = u16(b, i + 7);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** Dimensions from a PNG IHDR or JPEG SOF header, without decoding. Null for anything else. */
export function readImageMeta(bytes: Uint8Array): ImageMeta | null {
  return readPng(bytes) ?? readJpeg(bytes);
}

export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'application/octet-stream' {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return 'application/octet-stream';
}
