import { useState, type JSX } from 'react';
import { AutoText } from '../ui/AutoText';
import { modelValue } from './settingsPatch';

/**
 * A model-name input. A blank or unchanged name is never saved, and a failed save is rolled back, so in both cases
 * the input snaps back to the stored value (by remounting) instead of keeping text that was never saved. A blank
 * draft is only reverted on blur, so pausing mid-edit does not wipe what is being typed.
 */
export function ModelField({ label, value, save }: { label: string; value: string; save(model: string, onError: () => void): void }): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const reset = (): void => setNonce((n) => n + 1);
  return (
    <span className="model-field" onBlur={(e) => { if (modelValue((e.target as HTMLInputElement).value, value) === null) reset(); }}>
      <AutoText key={nonce} label={label} value={value} onSave={(v) => { const m = modelValue(v, value); if (m) save(m, reset); }} />
    </span>
  );
}
