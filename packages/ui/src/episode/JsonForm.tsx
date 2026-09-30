import { useState, type ReactElement } from 'react';
import { childPath, numberFromInput, textRows } from './episodeView';

export interface JsonFormProps {
  value: unknown;
  onChange(value: unknown): void;
  readOnly: boolean;
  /** The accessible name of a root that is not an object or list (the step's name). */
  label?: string;
  /** The readable path of this value, e.g. `pages[2].panels[1].scene` (`childPath`); '' at the root. */
  path?: string;
}

/**
 * Edits any step output in place: strings, numbers and booleans become fields; lists and objects nest. Shape changes go
 * through "Edit as JSON". Enums (shot, angle, kind, …) are free text for the MVP (F32): the server validates them on save.
 * Each field is named by its path. Strings are always one auto-sizing textarea, so the element never changes while the
 * user types (an input swapped for a textarea would drop focus to the page, where the editor's keys act on the canvas).
 */
export function JsonForm({ value, onChange, readOnly, label = 'output', path = '' }: JsonFormProps): ReactElement {
  const name = path || label;
  if (typeof value === 'string') {
    return <textarea className="textarea jf-text" aria-label={name} value={value} readOnly={readOnly} rows={textRows(value)} onChange={(e) => onChange(e.target.value)} />;
  }
  if (typeof value === 'number') return <NumberField value={value} name={name} readOnly={readOnly} onChange={onChange} />;
  if (typeof value === 'boolean') {
    return <input type="checkbox" aria-label={name} checked={value} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (value === null || value === undefined) return <span className="muted" aria-label={name}>—</span>;
  if (Array.isArray(value)) {
    return (
      <ol className="jf-list" aria-label={name}>
        {value.map((item, i) => (
          <li key={i}>
            <JsonForm value={item} path={childPath(path, i)} readOnly={readOnly} onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))} />
          </li>
        ))}
      </ol>
    );
  }
  const obj = value as Record<string, unknown>;
  return (
    <div className="jf-obj">
      {Object.entries(obj).map(([key, v]) => {
        const at = childPath(path, key);
        return (
          <div key={key} className="jf-field">
            <span className="jf-key" data-tip={at === key ? undefined : at}>{key}</span>
            <JsonForm value={v} path={at} readOnly={readOnly} onChange={(next) => onChange({ ...obj, [key]: next })} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Keeps the typed text, so an empty or half-typed entry (`-`, `1e`) is shown as typed and writes nothing; only a finite number
 * is emitted, and leaving the field shows the value again. A value changed from outside replaces a numeric text.
 */
function NumberField({ value, name, readOnly, onChange }: { value: number; name: string; readOnly: boolean; onChange(value: number): void }): ReactElement {
  const [text, setText] = useState(() => String(value));
  const typed = numberFromInput(text);
  const shown = typed === null || typed === value ? text : String(value);
  return (
    <input className="input jf-num" inputMode="decimal" aria-label={name} value={shown} readOnly={readOnly}
      onChange={(e) => {
        setText(e.target.value);
        const n = numberFromInput(e.target.value);
        if (n !== null) onChange(n);
      }}
      onBlur={() => { if (typed === null) setText(String(value)); }} />
  );
}
