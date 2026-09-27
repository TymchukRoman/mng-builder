import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Character, PanelScript } from '@manga/shared';
import { loadPrompt } from '../src/prompts/load.js';
import { normalizeAppearanceTags, sanitizeSentences, sanitizeTags } from '../src/prompts/sanitize.js';
import { scriptBlock } from '../src/prompts/script-block.js';

function character(id: string, name: string): Character {
  return {
    id, mangaId: 'mg_test000001', name, role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl, silver hair',
    seed: 1, recipe: null, refs: {}, createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('loadPrompt', () => {
  it.each(['panel-prompt-tags', 'panel-prompt-natural', 'appearance', 'review'] as const)('loads %s.md from disk', (name) => {
    const onDisk = readFileSync(fileURLToPath(new URL(`../src/prompts/${name}.md`, import.meta.url)), 'utf8').trim();
    expect(loadPrompt(name)).toBe(onDisk);
    expect(onDisk.length).toBeGreaterThan(200);
  });

  it('forbids appearance, names and lettering in both scene prompts', () => {
    for (const name of ['panel-prompt-tags', 'panel-prompt-natural'] as const) {
      const text = loadPrompt(name);
      expect(text).toContain('hair colour');
      expect(text).toContain('character names');
      expect(text).toContain('manga, comic, text, speech bubble');
    }
  });
});

describe('sanitizers', () => {
  it('drops forbidden and duplicate tags, keeps harmless look-alikes', () => {
    expect(sanitizeTags('Solo, manga, speech bubble, standing, solo, text, rooftop, no text')).toBe('Solo, standing, rooftop');
    expect(sanitizeTags('textbook, holding textbook')).toBe('textbook, holding textbook');
    expect(sanitizeTags(' , ,')).toBe('');
  });

  it('removes forbidden words from sentences and tidies punctuation', () => {
    expect(sanitizeSentences('Picture 1 girl on a rooftop, no speech bubbles, at sunset.')).toBe('Picture 1 girl on a rooftop, at sunset.');
    expect(sanitizeSentences('A comic scene without text.')).toBe('A scene.');
    expect(sanitizeSentences('Two people argue, no speech bubbles.')).toBe('Two people argue.');
  });

  it('normalizes appearance tags to lowercase unique tags', () => {
    expect(normalizeAppearanceTags('1girl, Silver Hair, twintails, silver hair, manga')).toBe('1girl, silver hair, twintails');
  });
});

describe('scriptBlock', () => {
  it('describes shot, stage directions and dialogue without appearance', () => {
    const aiko = character('cr_aiko000001', 'Aiko');
    const ren = character('cr_ren0000001', 'Ren');
    const script: PanelScript = {
      action: 'Aiko confronts Ren', shot: 'medium', angle: 'low', background: 'school rooftop',
      characters: [{ characterId: aiko.id, pose: 'pointing', expression: 'angry', position: 'left' }],
      dialogue: [
        { speakerId: aiko.id, kind: 'shout', text: 'Ти збрехав!' },
        { speakerId: null, kind: 'narration', text: 'Later.' },
      ],
    };
    expect(scriptBlock(script, [aiko, ren])).toBe([
      'Panel script:',
      '- Shot: medium; angle: low',
      '- Action: Aiko confronts Ren',
      '- Background: school rooftop',
      '- Characters (2):',
      '  1. Aiko: position left; pose: pointing; expression: angry',
      '  2. Ren: present',
      '- Dialogue (context only; it is lettered later and must never be drawn):',
      '  - Aiko (shout): "Ти збрехав!"',
      '  - narrator (narration): "Later."',
    ].join('\n'));
  });

  it('says so when nobody is in the panel', () => {
    const script: PanelScript = { action: '', shot: 'wide', angle: 'overhead', background: 'city at night', characters: [], dialogue: [] };
    expect(scriptBlock(script, [])).toBe([
      'Panel script:',
      '- Shot: wide; angle: overhead',
      '- Action: (not given)',
      '- Background: city at night',
      '- Characters (0): nobody; draw no people.',
    ].join('\n'));
  });
});
