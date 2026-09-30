import { describe, expect, it } from 'vitest';
import { ANTI_FEMALE_NEGATIVE, antiFemaleNegative, castCount, countSentence, countTag, genderOf, withCountTag } from '@manga/shared';

describe('genderOf (the subject gender from appearance tags)', () => {
  it.each([
    ['1boy, spiky blond hair, orange jumpsuit', 'male'],
    ['2boys', 'male'],
    ['1other, fat man, long hair, wavy hair, aristocratic clothes', 'male'],
    ['old man, beard, robe', 'male'],
    ['Old_Man, cane', 'male'],
    ['tall, king, crown, cape', 'male'],
    ['young prince, blond hair', 'male'],
    ['monk, bald, orange robe', 'male'],
    ['grandpa, glasses', 'male'],
    ['husband, suit', 'male'],
    ['mature male, scar', 'male'],
    ['businessman, necktie', 'male'],
    ['1girl, short black hair, school uniform', 'female'],
    ['1other, old woman, shawl', 'female'],
    ['queen, tiara, long dress', 'female'],
    ['princess, pink dress', 'female'],
    ['grandma, apron', 'female'],
    ['lady, parasol', 'female'],
    ['mature female, kimono', 'female'],
    ['kunoichi, mask', 'female'],
    ['1other, hooded cloak, mask', 'other'],
    ['tall, black cloak', 'other'],
    ['', 'other'],
    ['no humans, kitten, cat', 'other'],
    ['No_Humans, man-eating plant', 'other'],
    ['1other, man, woman', 'other'],
  ] as const)('%s → %s', (tags, gender) => {
    expect(genderOf(tags)).toBe(gender);
  });

  it('matches whole words only: "female" is not "male", "woman" is not "man", "human" and "shaman" are not men', () => {
    expect(genderOf('female, long hair')).toBe('female');
    expect(genderOf('woman, long hair')).toBe('female');
    expect(genderOf('human, robe')).toBe('other');
    expect(genderOf('shaman, feathers')).toBe('other');
    expect(genderOf('boyish, short hair')).toBe('other');
    expect(genderOf('tomboy, short hair')).toBe('female');
  });

  it('trusts an explicit 1boy/1girl over the words', () => {
    expect(genderOf('1girl, wearing a man\'s suit')).toBe('female');
    expect(genderOf('1boy, princess dress')).toBe('male');
  });
});

describe('withCountTag (the count tag a prompt uses; stored tags stay as they are)', () => {
  it('turns 1other into 1boy or 1girl when the words say so, in place', () => {
    expect(withCountTag('1other, fat man, long hair, wavy hair, aristocratic clothes')).toBe('1boy, fat man, long hair, wavy hair, aristocratic clothes');
    expect(withCountTag('1other, old woman, shawl')).toBe('1girl, old woman, shawl');
    expect(withCountTag('tall, 1other, king')).toBe('tall, 1boy, king');
  });

  it('adds the count tag in front when the tags have none', () => {
    expect(withCountTag('fat man, long hair')).toBe('1boy, fat man, long hair');
    expect(withCountTag('queen, tiara')).toBe('1girl, queen, tiara');
  });

  it('leaves correct, unknown, non-human and empty tags unchanged', () => {
    for (const tags of ['1boy, black hair', '1girl, bob cut', '1other, hooded cloak', 'hooded cloak', 'no humans, cat', ''])
      expect(withCountTag(tags), tags).toBe(tags);
  });
});

describe('people count (one source of truth for the panel build and the retry)', () => {
  const c = (appearanceTags: string) => ({ appearanceTags });

  it('counts humans by gender from the words, not only the count tag, and skips non-humans', () => {
    expect(castCount([c('1other, fat man'), c('1girl'), c('hooded cloak'), c('no humans, cat')])).toEqual({ boy: 1, girl: 1, other: 1 });
  });

  it('writes the Danbooru count tags, with solo and male focus', () => {
    expect(countTag(castCount([]))).toBe('no humans');
    expect(countTag(castCount([c('1boy, glasses')]))).toBe('1boy, solo, male focus');
    expect(countTag(castCount([c('1girl, glasses')]))).toBe('1girl, solo');
    expect(countTag(castCount([c('hooded cloak')]))).toBe('1other, solo');
    expect(countTag(castCount([c('1boy'), c('1boy')]))).toBe('2boys, male focus');
    expect(countTag(castCount([c('1girl'), c('1boy')]))).toBe('1boy, 1girl');
    expect(countTag(castCount([c('1boy'), c('')]))).toBe('1boy, 1other');
    expect(countTag(castCount([c('1girl'), c('1girl'), c('1boy'), c('')]))).toBe('1boy, 2girls, 1other');
    expect(countTag(castCount(Array.from({ length: 7 }, () => c('1boy'))))).toBe('multiple boys, male focus');
  });

  it('writes the count as a sentence for the natural style', () => {
    expect(countSentence(castCount([]))).toBe('No people.');
    expect(countSentence(castCount([c('1boy')]))).toBe('Exactly one man.');
    expect(countSentence(castCount([c('1girl')]))).toBe('Exactly one woman.');
    expect(countSentence(castCount([c('')]))).toBe('Exactly one person.');
    expect(countSentence(castCount([c('1boy'), c('fat man')]))).toBe('Exactly two men.');
    expect(countSentence(castCount([c('1girl'), c('1girl')]))).toBe('Exactly two women.');
    expect(countSentence(castCount([c(''), c('')]))).toBe('Exactly two people.');
    expect(countSentence(castCount([c('1girl'), c('1boy')]))).toBe('Exactly two people: one man and one woman.');
    expect(countSentence(castCount([c('1girl'), c('1boy'), c('')]))).toBe('Exactly three people: one man, one woman and one other person.');
    expect(countSentence(castCount(Array.from({ length: 12 }, () => c('1girl'))))).toBe('Exactly 12 women.');
  });

  it('adds the anti-female negative only with a male and no female human', () => {
    expect(ANTI_FEMALE_NEGATIVE).toBe('1girl, female, woman, breasts, feminine, makeup');
    expect(antiFemaleNegative(castCount([c('1boy')]))).toBe(ANTI_FEMALE_NEGATIVE);
    expect(antiFemaleNegative(castCount([c('1boy'), c('hooded cloak'), c('no humans, cat')]))).toBe(ANTI_FEMALE_NEGATIVE);
    expect(antiFemaleNegative(castCount([c('1boy'), c('1girl')]))).toBe('');
    expect(antiFemaleNegative(castCount([c('1girl')]))).toBe('');
    expect(antiFemaleNegative(castCount([]))).toBe('');
  });
});
