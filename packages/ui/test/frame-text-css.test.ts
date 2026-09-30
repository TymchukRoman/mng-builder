import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'page', 'page.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list names `selector`. */
function declarationsFor(selector: string): string {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1]!.split(',').map((s) => s.trim()).includes(selector)) out.push(m[2]!);
  }
  return out.join(';');
}

describe('frame text on art', () => {
  // Live smoke (M4 Task 22): the cover title, plain ink over a dark umbrella, could not be read.
  it('gives sfx and title text a paper-coloured halo, so they read over any art', () => {
    for (const kind of ['sfx', 'title']) {
      const decl = declarationsFor(`.frame-text--${kind} .frame-text__inner`);
      expect(decl).toContain('-webkit-text-stroke: var(--stroke) var(--paper)');
      expect(decl).toContain('paint-order: stroke fill');
    }
  });
});
