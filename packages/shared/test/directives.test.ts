import { describe, expect, it } from 'vitest';
import {
  DIRECTIVE_READERS, briefSegments, deriveArtTags, deriveNotes, directiveLines, directivesFor, directivesOfChapter, mergeDirectives, planChapterDirectives,
  uncoveredSegments, type Directive, type DirectiveDraft,
} from '../src/index.js';

const draft = (text: string, over: Partial<DirectiveDraft> = {}): DirectiveDraft => ({ text, kind: 'plot', chapters: [], must: true, quote: '', sources: [], tags: '', ...over });
const dir = (id: string, text: string, over: Partial<Directive> = {}): Directive => ({ ...draft(text), id, ...over });

describe('briefSegments', () => {
  it('numbers sentences and lines, continuing across parts', () => {
    expect(briefSegments('A cat. It hates rain!  Really?\nSecond line', 'Short dialogue.').map((s) => [s.n, s.text])).toEqual([
      [1, 'A cat.'], [2, 'It hates rain!'], [3, 'Really?'], [4, 'Second line'], [5, 'Short dialogue.'],
    ]);
  });

  it('keeps a closing quote with its sentence and splits Ukrainian text', () => {
    expect(briefSegments('Вона сказала: «Іди». Він пішов.').map((s) => s.text)).toEqual(['Вона сказала: «Іди».', 'Він пішов.']);
    expect(briefSegments('He said "go." Then left.').map((s) => s.text)).toEqual(['He said "go."', 'Then left.']);
  });

  it('skips empty parts and blank lines', () => {
    expect(briefSegments('', undefined, '  \n\n')).toEqual([]);
  });

  it('finds the sentences no directive was taken from', () => {
    const segments = briefSegments('One. Two. Three.');
    expect(uncoveredSegments(segments, [{ sources: [1] }, { sources: [3, 9] }]).map((s) => s.n)).toEqual([2]);
    expect(uncoveredSegments(segments, [])).toHaveLength(3);
  });
});

describe('mergeDirectives', () => {
  it('numbers from D1, continues after existing ones and drops repeats', () => {
    const first = mergeDirectives([], [draft('Aiko has a red scarf.'), draft('It rains.')]);
    expect(first.map((d) => [d.id, d.text])).toEqual([['D1', 'Aiko has a red scarf.'], ['D2', 'It rains.']]);
    const more = mergeDirectives(first, [draft('aiko has a RED scarf'), draft('No romance.', { kind: 'avoid' })]);
    expect(more.map((d) => d.id)).toEqual(['D1', 'D2', 'D3']);
    expect(more[2]).toMatchObject({ text: 'No romance.', kind: 'avoid' });
  });

  it('cleans sources and chapters', () => {
    const [d] = mergeDirectives([], [draft('x', { sources: [3, 1, 3, 99], chapters: [3, 2, 3] })], 5);
    expect(d).toMatchObject({ sources: [1, 3], chapters: [2, 3] });
  });

  it('ignores empty text', () => {
    expect(mergeDirectives([], [draft('...')])).toEqual([]);
  });
});

describe('which directives a step reads', () => {
  const all = [
    dir('D1', 'Aiko is a detective.', { kind: 'plot' }), dir('D2', 'Aiko has a red scarf.', { kind: 'character' }),
    dir('D3', 'Thick ink lines.', { kind: 'visual', tags: 'thick outlines' }), dir('D4', 'No romance.', { kind: 'avoid' }),
    dir('D5', 'In chapter 2 it snows.', { kind: 'setting', chapters: [2] }), dir('D6', 'Short sentences.', { kind: 'dialogue' }),
    dir('D7', 'The last page is a splash.', { kind: 'structure', chapters: [3] }),
  ];

  it('gives each step its kinds, for its chapter', () => {
    expect(directivesFor('prompts', all, 1).map((d) => d.id)).toEqual(['D3', 'D4']);
    expect(directivesFor('prompts', all, 2).map((d) => d.id)).toEqual(['D3', 'D4', 'D5']);
    expect(directivesFor('breakdown', all, 3).map((d) => d.id)).toEqual(['D4', 'D7']);
    expect(directivesFor('scripts', all, 1).map((d) => d.id)).toEqual(['D1', 'D2', 'D4', 'D6']);
    expect(directivesFor('premise', all, null)).toHaveLength(7);
    expect(directivesOfChapter(all, 2).map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  });

  it('never loses a kind: every kind is read by the premise and the plan', () => {
    for (const reader of ['premise', 'plan'] as const) expect(DIRECTIVE_READERS[reader]).toHaveLength(10);
  });

  it('writes the notes and the art tags from the directives', () => {
    expect(deriveNotes(all)).toBe('No romance. Short sentences. The last page is a splash.');
    expect(deriveArtTags(all)).toBe('thick outlines');
    expect(deriveArtTags([...all, dir('D8', 'Soft shading.', { kind: 'visual', tags: 'Thick Outlines, soft shading', chapters: [2] })])).toBe('thick outlines, soft shading');
    expect(deriveArtTags(all, { skipSeries: true })).toBe('');
  });

  it('quotes directives to a checker', () => {
    expect(directiveLines([dir('D1', 'A.'), dir('D2', 'B.', { must: false, kind: 'tone' })])).toBe('D1 [must, plot] A.\nD2 [wish, tone] B.');
  });
});

describe('planChapterDirectives', () => {
  const directives = [
    dir('D1', 'Chapter one fight.'), dir('D2', 'A rooftop duel.'), dir('D3', 'Aiko has a scarf.', { kind: 'character' }),
    dir('D4', 'Thick lines.', { kind: 'visual' }), dir('D5', 'Winter in chapter 2.', { kind: 'setting', chapters: [2] }), dir('D6', 'Unplaced.'),
  ];
  const coverage = [
    { id: 'D1', where: 'chapters' as const, chapters: [1] }, { id: 'D2', where: 'chapters' as const, chapters: [2, 3] }, { id: 'D3', where: 'cast' as const, chapters: [] },
    { id: 'D4', where: 'style' as const, chapters: [] }, { id: 'D5', where: 'chapters' as const, chapters: [2] },
  ];

  it('gives a chapter the plot placed in it, what names it, and what is for the whole series', () => {
    const ids = (n: number): string[] => planChapterDirectives({ directives, coverage }, n).map((d) => d.id);
    expect(ids(1)).toEqual(['D1', 'D3', 'D4', 'D6']);
    expect(ids(2)).toEqual(['D2', 'D3', 'D4', 'D5', 'D6']);
    expect(ids(3)).toEqual(['D2', 'D3', 'D4', 'D6']);
  });
});
