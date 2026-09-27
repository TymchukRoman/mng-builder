import { InvalidArgumentError } from 'commander';

export function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a whole number >= 0');
  return n;
}

export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a whole number >= 1');
  return n;
}

export function parseNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new InvalidArgumentError('expected a number');
  return n;
}

export function parsePositiveNumber(value: string): number {
  const n = parseNumber(value);
  if (n <= 0) throw new InvalidArgumentError('expected a number > 0');
  return n;
}

/** "x,y,w,h" in page-normalized units. */
export function parseBox(value: string): { x: number; y: number; w: number; h: number } {
  const parts = value.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new InvalidArgumentError('expected x,y,w,h as four numbers, e.g. 0.1,0.1,0.3,0.12');
  }
  const [x = 0, y = 0, w = 0, h = 0] = parts;
  return { x, y, w, h };
}

export function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Repeatable option: --line a --line b → ['a', 'b']. */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
