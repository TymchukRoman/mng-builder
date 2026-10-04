import type { JSX } from 'react';
import { IMAGE_MODELS, imageModelById } from '@manga/shared';

/**
 * The image model of a manga or chapter (shared IMAGE_MODELS): one choice that fills the panel routes. The empty choice
 * means "not set here": a chapter then uses its manga's model, a manga uses the routing of Settings; `inheritLabel` says which.
 */
export function ImageModelSelect({ value, onChange, label, inheritLabel, compact = false }: {
  value: string | null; onChange(value: string | null): void; label: string; inheritLabel: string; compact?: boolean;
}): JSX.Element {
  const model = imageModelById(value);
  return (
    <>
      <select className={compact ? 'select select--compact' : 'select'} aria-label={label} value={model ? model.id : ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">{inheritLabel}</option>
        {Object.values(IMAGE_MODELS).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {model && <span className="field__hint">{model.summary}</span>}
    </>
  );
}
