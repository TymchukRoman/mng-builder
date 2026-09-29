import type { JSX } from 'react';
import type { RecipeInfo } from '@manga/shared';
import { useRecipes } from '../queries';
import { Check } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';

const FLAGS: Array<[keyof RecipeInfo, string]> = [
  ['requiresRefs', 'Needs refs'], ['supportsPose', 'Pose'], ['supportsLineart', 'Lineart'], ['supportsLoras', 'LoRAs'], ['supportsInit', 'Init image'],
];

export function RecipeList(): JSX.Element {
  const query = useRecipes();
  return (
    <section className="settings-card settings-card--wide">
      <h2>Recipes</h2>
      {!query.data && (query.isError
        ? <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        : <StatusLoader label="Loading recipes" />)}
      {query.data && (
        <table className="recipe-table">
          <thead>
            <tr><th>Recipe</th><th>Max refs</th>{FLAGS.map(([k, label]) => <th key={k}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {query.data.map((r) => (
              <tr key={r.id}>
                <td><span className="recipe-table__label">{r.label}</span> <code>{r.id}</code></td>
                <td>{r.maxRefs}</td>
                {FLAGS.map(([k, label]) => <td key={k}>{r[k] === true ? <Check size={14} role="img" aria-label={label} data-tip={label} /> : null}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
