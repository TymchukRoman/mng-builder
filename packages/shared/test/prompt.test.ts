import { describe, expect, it } from 'vitest';
import { assemblePrompt, BASE_NEGATIVE, BW_TOKENS, type StyleGuide } from '@manga/shared';

const style: StyleGuide = { recipe: 'anime', stylePrompt: 'masterpiece, best quality', negativePrompt: 'lowres, bad hands', loras: [] };

describe('assemblePrompt', () => {
  it('joins style, B&W tokens, character tags and scene in that order', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'bw', characterTags: ['1girl, red hair, (green eyes:1.2)'], scene: 'standing in the rain' });
    expect(r.prompt).toBe(`masterpiece, best quality, ${BW_TOKENS}, 1girl, red hair, (green eyes:1.2), standing in the rain`);
    expect(BW_TOKENS).toBe('monochrome, greyscale, screentone, lineart');
  });

  it('adds the B&W tokens only for bw mangas', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'color', characterTags: [], scene: 'city at night' });
    expect(r.prompt).toBe('masterpiece, best quality, city at night');
    expect(r.prompt).not.toContain('monochrome');
  });

  it('strips the whole words manga, comic and comics from the scene, in any case', () => {
    const r = assemblePrompt({
      styleGuide: style, colorMode: 'color', characterTags: [],
      scene: 'MANGA panel, a Comic shop, stacks of comics, manga-style shading, mangaka at desk',
    });
    expect(r.prompt).toBe('masterpiece, best quality, panel, a shop, stacks of, style shading, mangaka at desk');
  });

  it('keeps character tags and the style prompt verbatim even when they contain those words', () => {
    const r = assemblePrompt({
      styleGuide: { ...style, stylePrompt: 'manga lineart  style' }, colorMode: 'color',
      characterTags: ['comic-book hero costume'], scene: 'manga',
    });
    expect(r.prompt).toBe('manga lineart  style, comic-book hero costume');
  });

  it('builds the negative from the style negative, the base negative and the extra negative', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'bw', characterTags: [], scene: 'x', extraNegative: 'extra fingers' });
    expect(r.negative).toBe(`lowres, bad hands, ${BASE_NEGATIVE}, extra fingers`);
    expect(BASE_NEGATIVE).toBe('text, speech bubble, sound effects, signature, watermark, logo');
  });

  it('skips empty parts instead of leaving double commas', () => {
    const r = assemblePrompt({ styleGuide: { ...style, stylePrompt: '', negativePrompt: '' }, colorMode: 'color', characterTags: ['', '  '], scene: '' });
    expect(r).toEqual({ prompt: '', negative: BASE_NEGATIVE });
  });
});
