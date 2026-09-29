import { useEffect, useState, type JSX } from 'react';
import type { LoraRef } from '@manga/shared';
import { IconButton } from '../ui/IconButton';
import { Minus, Plus } from '../ui/icons';
import { NumberField } from '../ui/NumberField';
import { validLoras } from './mangaModel';

/** Local rows so a new, still-unnamed LoRA can exist; only named rows are saved (LoraRef.name is min(1)). */
export function LoraEditor({ loras, onChange }: { loras: LoraRef[]; onChange(next: LoraRef[]): void }): JSX.Element {
  const [rows, setRows] = useState<LoraRef[]>(loras);
  useEffect(() => { setRows((cur) => (JSON.stringify(validLoras(cur)) === JSON.stringify(loras) ? cur : loras)); }, [loras]);
  const commit = (next: LoraRef[]): void => {
    setRows(next);
    const valid = validLoras(next);
    if (JSON.stringify(valid) !== JSON.stringify(loras)) onChange(valid);
  };
  return (
    <div className="lora-editor" role="group" aria-label="LoRAs">
      <div className="section-head">
        <span className="field__label">LoRAs</span>
        <IconButton icon={Plus} size="sm" label="Add LoRA" onClick={() => setRows([...rows, { name: '', strength: 0.8 }])} />
      </div>
      {rows.map((row, i) => (
        <div className="lora-row" key={`${i}:${row.name}`}>
          <input className="input" aria-label="LoRA file name" placeholder="name.safetensors" defaultValue={row.name}
            onBlur={(e) => commit(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
          <NumberField label="LoRA strength" value={row.strength} min={-2} max={2} step={0.05}
            onSave={(strength) => commit(rows.map((r, j) => (j === i ? { ...r, strength } : r)))} />
          <IconButton icon={Minus} size="sm" label="Remove LoRA" onClick={() => commit(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  );
}
