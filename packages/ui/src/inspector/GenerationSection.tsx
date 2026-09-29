import type { JSX } from 'react';
import type { Character, Panel } from '@manga/shared';
import { imageUrl } from '../api';
import { cx } from '../lib/cx';
import { generationRecipes } from '../lib/recipes';
import { randomSeed } from '../lib/seed';
import { useRecipes } from '../queries';
import type { UpdatePanelBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Dices, Lock, LockOpen, UserRound } from '../ui/icons';
import { NumberField } from '../ui/NumberField';
import { recipeChoices, seedPatch, toggleId } from './inspectorModel';

export function GenerationSection({ panel, characters, patch }: { panel: Panel; characters: Character[]; patch(body: UpdatePanelBody): Promise<void> }): JSX.Element {
  const recipes = recipeChoices(generationRecipes(useRecipes().data), panel.recipe);
  return (
    <section className="insp-section">
      <h3>Generation</h3>
      <Field label="Recipe">
        <select className="select" value={panel.recipe ?? ''} onChange={(e) => void patch({ recipe: e.target.value || null })}>
          <option value="">Auto (by characters)</option>
          {recipes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      {/* Not a <Field> (a label around buttons): the seed input alone answers to the label "Seed". */}
      <div className="field">
        <span className="field__label">Seed</span>
        <div className="row">
          <NumberField label="Seed" value={panel.seed} min={0} integer onSave={(seed) => void patch(seedPatch(seed))} />
          <IconButton icon={panel.seedLock ? Lock : LockOpen} active={panel.seedLock}
            label={panel.seedLock ? 'Unlock seed' : 'Lock seed'}
            onClick={() => void patch({ seedLock: !panel.seedLock })} />
          <IconButton icon={Dices} label="Random seed" onClick={() => void patch(seedPatch(randomSeed()))} />
        </div>
      </div>
      <div className="field" role="group" aria-label="Reference characters">
        <span className="field__label">Reference characters</span>
        <div className="ref-chips">
          {characters.length === 0 && <span className="muted">No characters in this manga</span>}
          {characters.map((c) => {
            const on = panel.refCharacterIds.includes(c.id);
            return (
              <button key={c.id} type="button" className={cx('ref-chip', on && 'is-on')} aria-pressed={on} data-tip={on ? 'Remove reference' : 'Use as reference'}
                onClick={() => void patch({ refCharacterIds: toggleId(panel.refCharacterIds, c.id) })}>
                {c.refs.portrait ? <img src={imageUrl(c.refs.portrait)} alt="" /> : <UserRound size={14} aria-hidden />}
                <span>{c.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
