import { describe, expect, it } from 'vitest';
import { readImageMeta, sniffImageMime } from '../src/files/image-meta.js';
import { makeJpegHeader, makePng } from './helpers/png.js';

describe('readImageMeta', () => {
  it('reads width and height from a PNG IHDR', () => {
    expect(readImageMeta(makePng(640, 480))).toEqual({ format: 'png', width: 640, height: 480 });
  });

  it('reads width and height from a baseline JPEG after an APP0 segment', () => {
    expect(readImageMeta(makeJpegHeader(1216, 832))).toEqual({ format: 'jpeg', width: 1216, height: 832 });
  });

  it('reads a progressive JPEG (SOF2)', () => {
    expect(readImageMeta(makeJpegHeader(300, 200, 0xc2))).toEqual({ format: 'jpeg', width: 300, height: 200 });
  });

  it('returns null for text, GIF, truncated data and zero sizes', () => {
    expect(readImageMeta(Buffer.from('hello, not an image'))).toBeNull();
    expect(readImageMeta(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1'))).toBeNull();
    expect(readImageMeta(makePng(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageMeta(makeJpegHeader(10, 10).subarray(0, 12))).toBeNull();
    expect(readImageMeta(makePng(0, 10))).toBeNull();
    expect(readImageMeta(new Uint8Array(0))).toBeNull();
  });

  it('sniffs the content type from the bytes', () => {
    expect(sniffImageMime(makePng(1, 1))).toBe('image/png');
    expect(sniffImageMime(makeJpegHeader(1, 1))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('x'))).toBe('application/octet-stream');
  });
});
