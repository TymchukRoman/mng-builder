import { describe, expect, it } from 'vitest';
import { castPrompt, stripCountSentences, stripCountTags } from '../src/prompts/count.js';

const c = (appearanceTags: string) => ({ appearanceTags });
const ROGUE = c('1boy, long dark hair, ninja headband, dark cloak, mask');
const COUNT_TAGS = /(?:^|, )(?:\d\+?(?:girl|boy|other)s?|multiple (?:girl|boy|other)s|solo|solo focus|male focus|female focus)(?=,|$)/g;

describe('stripCountTags', () => {
  it('drops every people-count and gender-focus tag, in any spelling, and keeps the rest', () => {
    expect(stripCountTags('1girl, 2Girls, 6+girls, multiple_girls, 1boy, 3boys, 6+boys, multiple boys, 1other, 2others, solo, Solo Focus, male focus, female_focus, (2girls:1.2), from side, rain'))
      .toBe('from side, rain');
  });

  it('keeps tags that only contain a count word', () => {
    expect(stripCountTags('boy scout uniform, girl holding cat, soloist')).toBe('boy scout uniform, girl holding cat, soloist');
  });
});

describe('stripCountSentences', () => {
  it('drops sentences that only state the people count and keeps the scene', () => {
    expect(stripCountSentences('Exactly two people: two girls. Two girls. Solo. The ninja crouches on a branch. No people.'))
      .toBe('The ninja crouches on a branch.');
    expect(stripCountSentences('Two men fight on the bridge.')).toBe('Two men fight on the bridge.');
  });
});

describe('castPrompt (deterministic panel people count from the cast)', () => {
  it("replaces the LLM's wrong count on Roman's Rogue Ninja scene: no 2girls, exactly one count tag set, first", () => {
    const scene = 'upper body, 2girls, from side, crouching on a branch, forest, night';
    const out = castPrompt('tags', [ROGUE], scene);
    const prompt = [...out.characterTags, out.scene].join(', ');
    expect(prompt).not.toContain('2girls');
    expect(prompt.match(COUNT_TAGS)?.map((t) => t.replace(/^, /, ''))).toEqual(['1boy', 'solo', 'male focus']);
    expect(out.characterTags).toEqual(['1boy, solo, male focus', 'long dark hair, ninja headband, dark cloak, mask']);
    expect(out.scene).toBe('upper body, from side, crouching on a branch, forest, night');
  });

  it('counts Naruto and Sasuke as two boys, whatever the scene said', () => {
    const out = castPrompt('tags', [c('1boy, spiky blond hair'), c('1boy, black hair')], 'full body, 2girls, 1boy, solo, rooftop');
    expect(out.characterTags).toEqual(['2boys, male focus', 'spiky blond hair', 'black hair']);
    expect(out.scene).toBe('full body, rooftop');
  });

  it('counts a 1other man as a boy and a mixed panel without male focus', () => {
    expect(castPrompt('tags', [c('1other, fat man, long hair')], 'solo').characterTags).toEqual(['1boy, solo, male focus', 'mature male, fat man, long hair']);
    expect(castPrompt('tags', [c('1boy'), c('1girl, bob cut')], '1girl, park').characterTags).toEqual(['1boy, 1girl', 'bob cut']);
  });

  it('gives `mature male` to the grown man only, after the single count set (GPU check: Mnga 0.4 drew a soft boy)', () => {
    const out = castPrompt('tags', [c('1other, fat man, long hair'), c('1boy, teen, school uniform')], 'hall');
    expect(out.characterTags).toEqual(['2boys, male focus', 'mature male, fat man, long hair', 'teen, school uniform']);
    expect(castPrompt('natural', [c('1boy, beard')], 'He waits.').scene).toBe('Exactly one grown man. He waits.');
    expect(castPrompt('natural', [c('1boy, beard'), c('1boy, teen')], 'They wait.').scene).toBe('Exactly two men. They wait.');
  });

  it('writes the count as the first sentence for the natural style', () => {
    const out = castPrompt('natural', [ROGUE], 'Medium shot at eye level. Exactly two people: two girls. The ninja crouches on a branch.');
    expect(out.scene).toBe('Exactly one man. Medium shot at eye level. The ninja crouches on a branch.');
    expect(out.characterTags).toEqual(['long dark hair, ninja headband, dark cloak, mask']);
  });

  it('leaves the scene and tags alone when the cast has no human (crowds and extras are not in the cast)', () => {
    const cat = c('no humans, kitten');
    expect(castPrompt('tags', [], 'wide shot, crowd, multiple boys, market')).toEqual({
      characterTags: [], scene: 'wide shot, crowd, multiple boys, market', count: { boy: 0, girl: 0, other: 0 },
    });
    expect(castPrompt('tags', [cat], 'no humans, box').characterTags).toEqual(['no humans, kitten']);
  });
});
