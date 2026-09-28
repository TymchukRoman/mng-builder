import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Character, PanelScript } from '@manga/shared';
import { CAMERA_TAGS, cameraSentence, cameraTags, cameraWording, stripCameraSentences, stripCameraTags } from '../src/prompts/camera.js';
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

  it('forbids appearance, names, lettering and camera framing in both scene prompts', () => {
    for (const name of ['panel-prompt-tags', 'panel-prompt-natural'] as const) {
      const text = loadPrompt(name);
      expect(text).toContain('hair colour');
      expect(text).toContain('character names');
      expect(text).toContain('manga, comic, text, speech bubble');
      expect(text).toContain('the app adds the camera');
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
      '- Camera: medium shot, low angle (from below)',
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
      '- Camera: wide shot (full body), overhead (from directly above)',
      '- Action: (not given)',
      '- Background: city at night',
      '- Characters (0): nobody; draw no people.',
    ].join('\n'));
  });
});

describe('camera (I2: the script decides shot and angle, never the LLM)', () => {
  it.each<[PanelScript['shot'], PanelScript['angle'], string[]]>([
    ['extreme-close', 'eye', ['extreme close-up']],
    ['close', 'low', ['close-up', 'from below']],
    ['medium', 'eye', ['upper body']],
    ['medium', 'high', ['upper body', 'from above']],
    ['wide', 'dutch', ['full body', 'wide shot', 'dutch angle']],
    ['extreme-wide', 'overhead', ['very wide shot', 'from above', 'overhead view']],
  ])('cameraTags(%s, %s) = %j', (shot, angle, tags) => {
    expect(cameraTags(shot, angle)).toEqual(tags);
    for (const tag of tags) expect(CAMERA_TAGS.has(tag)).toBe(true);
  });

  it('writes one framing sentence for the natural style', () => {
    expect(cameraSentence('medium', 'eye')).toBe('Medium shot at eye level.');
    expect(cameraSentence('close', 'low')).toBe('Close-up from a low angle.');
    expect(cameraSentence('extreme-close', 'high')).toBe('Extreme close-up from a high angle.');
    expect(cameraSentence('wide', 'dutch')).toBe('Wide full-body shot at a tilted dutch angle.');
    expect(cameraSentence('extreme-wide', 'overhead')).toBe('Very wide shot from directly overhead.');
  });

  it('words the camera for people and LLMs reading the script', () => {
    expect(cameraWording('medium', 'eye')).toBe('medium shot, eye level');
    expect(cameraWording('close', 'low')).toBe('close-up, low angle (from below)');
    expect(cameraWording('extreme-close', 'high')).toBe('extreme close-up, high angle (from above)');
    expect(cameraWording('extreme-wide', 'dutch')).toBe('extreme wide shot, dutch angle (tilted)');
  });

  it('strips camera tags in any spelling, and keeps facing and everything else', () => {
    expect(stripCameraTags('solo, From Below, cowboy_shot, (close-up:1.2), standing, from side, from behind, portrait, rooftop'))
      .toBe('solo, standing, from side, from behind, rooftop');
    expect(stripCameraTags('upper body, from above')).toBe('');
  });

  it('drops framing sentences and keeps the rest', () => {
    expect(stripCameraSentences('Low-angle close-up. The character from picture 1 shouts on a rooftop. Light falls from above.'))
      .toBe('The character from picture 1 shouts on a rooftop. Light falls from above.');
    expect(stripCameraSentences('A medium shot at eye level!')).toBe('');
  });

  it('strips only the framing phrase, keeping the scene content around it (R2)', () => {
    expect(stripCameraSentences('Close-up of the character from picture 1 crying, tears on her cheeks.'))
      .toContain('the character from picture 1 crying, tears on her cheeks.');
    expect(stripCameraSentences('She holds the letter at eye level.')).toBe('She holds the letter.');
  });

  it('still drops a sentence that is framing only, once nothing usable is left after stripping (R2)', () => {
    expect(stripCameraSentences('Extreme close-up from a low angle.')).toBe('');
  });
});
