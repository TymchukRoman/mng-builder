import { describe, expect, it } from 'vitest';
import { commitValue, parseNumberDraft } from '../src/ui/formValues';

describe('commitValue', () => {
  it('trims single-line input and reports changes only', () => {
    expect(commitValue('  New title ', 'Old', { required: true, multiline: false })).toBe('New title');
    expect(commitValue('Old ', 'Old', { required: true, multiline: false })).toBeNull();
  });
  it('refuses to commit an empty required value', () => {
    expect(commitValue('   ', 'Old', { required: true, multiline: false })).toBeNull();
    expect(commitValue('', 'Old', { required: false, multiline: false })).toBe('');
  });
  it('keeps inner newlines in multiline text but drops trailing whitespace', () => {
    expect(commitValue('a\nb\n\n', 'x', { required: false, multiline: true })).toBe('a\nb');
  });
});

describe('parseNumberDraft', () => {
  it('parses, clamps and rounds', () => {
    expect(parseNumberDraft('12.5', { integer: false })).toBe(12.5);
    expect(parseNumberDraft('12.6', { integer: true })).toBe(13);
    expect(parseNumberDraft('900', { integer: true, max: 600 })).toBe(600);
    expect(parseNumberDraft('-3', { integer: false, min: 0 })).toBe(0);
  });
  it('accepts a comma as the decimal separator', () => {
    expect(parseNumberDraft('0,8', { integer: false })).toBe(0.8);
  });
  it('rejects empty and non-numeric input', () => {
    expect(parseNumberDraft('', { integer: false })).toBeNull();
    expect(parseNumberDraft('abc', { integer: false })).toBeNull();
  });
});
