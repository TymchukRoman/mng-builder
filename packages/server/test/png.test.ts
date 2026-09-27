import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodeSolidPng } from '../src/dev/png.js';
import { pngSize } from '../src/imaging/png-size.js';

describe('PNG', () => {
  it('writes a valid PNG whose IHDR carries the size', () => {
    const png = encodeSolidPng(7, 5, [10, 20, 30]);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngSize(png)).toEqual({ width: 7, height: 5 });
  });

  it('stores the requested colour in every pixel', () => {
    const png = Buffer.from(encodeSolidPng(3, 2, [10, 20, 30]));
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(Array.from(raw)).toEqual([0, 10, 20, 30, 10, 20, 30, 10, 20, 30, 0, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects bad input', () => {
    expect(() => pngSize(new Uint8Array([1, 2, 3]))).toThrow('not a PNG');
    expect(() => encodeSolidPng(0, 5)).toThrow(RangeError);
  });
});
