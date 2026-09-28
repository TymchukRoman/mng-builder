import type { Character, PanelScript } from '@manga/shared';
import { cameraWording } from './camera.js';

/** The panel script as prompt text. Names only; appearance never appears here (the app injects tags itself). */
export function scriptBlock(script: PanelScript, characters: Character[]): string {
  const nameOf = (id: string | null): string =>
    id === null ? 'narrator' : characters.find((c) => c.id === id)?.name ?? 'someone';
  const lines = [
    'Panel script:',
    `- Camera: ${cameraWording(script.shot, script.angle)}`, // readable wording, not the raw enums (I2)
    `- Action: ${script.action.trim() || '(not given)'}`,
    `- Background: ${script.background.trim() || '(not given)'}`,
  ];
  if (characters.length === 0) {
    lines.push('- Characters (0): nobody; draw no people.');
  } else {
    lines.push(`- Characters (${characters.length}):`);
    characters.forEach((c, i) => {
      const stage = script.characters.find((s) => s.characterId === c.id);
      lines.push(stage
        ? `  ${i + 1}. ${c.name}: position ${stage.position}; pose: ${stage.pose.trim() || 'unspecified'}; expression: ${stage.expression.trim() || 'unspecified'}`
        : `  ${i + 1}. ${c.name}: present`);
    });
  }
  if (script.dialogue.length > 0) {
    lines.push('- Dialogue (context only; it is lettered later and must never be drawn):');
    for (const line of script.dialogue) lines.push(`  - ${nameOf(line.speakerId)} (${line.kind}): "${line.text}"`);
  }
  return lines.join('\n');
}
