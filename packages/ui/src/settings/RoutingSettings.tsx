import type { JSX } from 'react';
import type { Settings } from '@manga/shared';
import { useRecipes } from '../queries';
import { Field } from '../ui/Field';
import { refineChoices, routeChoices, type RecipeChoice, type SaveSettings } from './settingsPatch';

type RouteKey = 'noChars' | 'oneChar' | 'multiChar' | 'driftFallback';
const ROUTES: Array<[RouteKey, string]> = [
  ['noChars', 'No characters'], ['oneChar', 'One character'], ['multiChar', 'Several characters'], ['driftFallback', 'Identity drift retry'],
];

const options = (choices: RecipeChoice[]): JSX.Element[] => choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>);

export function RoutingSettings({ settings, save }: { settings: Settings; save: SaveSettings }): JSX.Element {
  const recipes = useRecipes().data;
  return (
    <section className="settings-card">
      <h2>Recipe routing</h2>
      {ROUTES.map(([key, label]) => (
        <Field key={key} label={label} inline>
          <select className="select select--compact" value={settings.routing[key]} onChange={(e) => save({ routing: { [key]: e.target.value } })}>
            {options(routeChoices(recipes, settings.routing[key]))}
          </select>
        </Field>
      ))}
      <Field label="B&W refine" inline>
        <select className="select select--compact" value={settings.routing.bwRefine ?? ''} onChange={(e) => save({ routing: { bwRefine: e.target.value || null } })}>
          <option value="">None</option>
          {options(refineChoices(recipes, settings.routing.bwRefine))}
        </select>
      </Field>
    </section>
  );
}
