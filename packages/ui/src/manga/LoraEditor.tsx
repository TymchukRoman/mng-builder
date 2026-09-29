import { useEffect, useRef, useState, type JSX } from 'react';
import type { LoraRef } from '@manga/shared';
import { IconButton } from '../ui/IconButton';
import { Minus, Plus } from '../ui/icons';
import { NumberField } from '../ui/NumberField';
import { validLoras } from './mangaModel';

/** A local row carries a stable id, so renaming it never remounts its inputs (which would drop focus). */
type Row = LoraRef & { id: number };

/** Local rows so a new, still-unnamed LoRA can exist; only named rows are saved (LoraRef.name is min(1)). */
export function LoraEditor({ loras, onChange }: { loras: LoraRef[]; onChange(next: LoraRef[]): void }): JSX.Element {
  const nextId = useRef(0);
  const withIds = (list: readonly LoraRef[]): Row[] => list.map((l) => ({ ...l, id: nextId.current++ }));
  const [rows, setRows] = useState<Row[]>(() => withIds(loras));
  const plain = (list: readonly Row[]): LoraRef[] => list.map(({ name, strength }) => ({ name, strength }));
  useEffect(() => {
    setRows((cur) => (JSON.stringify(validLoras(plain(cur))) === JSON.stringify(loras) ? cur : withIds(loras)));
  }, [loras]);
  const commit = (next: Row[]): void => {
    setRows(next);
    const valid = validLoras(plain(next));
    if (JSON.stringify(valid) !== JSON.stringify(loras)) onChange(valid);
  };
  const edit = (id: number, p: Partial<LoraRef>): void => commit(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <div className="lora-editor" role="group" aria-label="LoRAs">
      <div className="section-head">
        <span className="field__label">LoRAs</span>
        <IconButton icon={Plus} size="sm" label="Add LoRA" onClick={() => setRows([...rows, ...withIds([{ name: '', strength: 0.8 }])])} />
      </div>
      {rows.map((row) => (
        <div className="lora-row" key={row.id}>
          <input className="input" aria-label="LoRA file name" placeholder="name.safetensors" defaultValue={row.name}
            onBlur={(e) => edit(row.id, { name: e.target.value })} />
          <NumberField label="LoRA strength" value={row.strength} min={-2} max={2} step={0.05}
            onSave={(strength) => edit(row.id, { strength })} />
          <IconButton icon={Minus} size="sm" label="Remove LoRA" onClick={() => commit(rows.filter((r) => r.id !== row.id))} />
        </div>
      ))}
    </div>
  );
}
