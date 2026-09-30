import type { ReactElement } from 'react';

export interface JsonFormProps { value: unknown; onChange(value: unknown): void; readOnly: boolean; label?: string }

/**
 * Edits any step output in place: strings, numbers and booleans become inputs; lists and objects nest. Shape changes go
 * through "Edit as JSON". Enums (shot, angle, kind, …) are free text for the MVP (F32): the server validates them on save.
 */
export function JsonForm({ value, onChange, readOnly, label = 'output' }: JsonFormProps): ReactElement {
  if (typeof value === 'string') {
    const long = value.length > 48 || value.includes('\n');
    return long
      ? <textarea className="textarea jf-text" aria-label={label} value={value} readOnly={readOnly} rows={Math.min(6, Math.ceil(value.length / 48) + 1)} onChange={(e) => onChange(e.target.value)} />
      : <input className="input" aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />;
  }
  if (typeof value === 'number') {
    return <input className="input jf-num" type="number" aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  }
  if (typeof value === 'boolean') {
    return <input type="checkbox" aria-label={label} checked={value} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (value === null || value === undefined) return <span className="muted" aria-label={label}>—</span>;
  if (Array.isArray(value)) {
    return (
      <ol className="jf-list" aria-label={label}>
        {value.map((item, i) => (
          <li key={i}>
            <JsonForm value={item} label={`${label} ${i + 1}`} readOnly={readOnly} onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))} />
          </li>
        ))}
      </ol>
    );
  }
  const obj = value as Record<string, unknown>;
  return (
    <div className="jf-obj">
      {Object.entries(obj).map(([key, v]) => (
        <div key={key} className="jf-field">
          <span className="jf-key">{key}</span>
          <JsonForm value={v} label={key} readOnly={readOnly} onChange={(next) => onChange({ ...obj, [key]: next })} />
        </div>
      ))}
    </div>
  );
}
