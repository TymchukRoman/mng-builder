import type { JSX, RefObject } from 'react';
import type { PageFormat, ReadingDirection } from '@manga/shared';
import { useLayouts } from '../queries';
import { Popover } from '../ui/Popover';
import { StatusLoader } from '../ui/StatusLoader';
import { errorText } from '../ui/toasts';
import { PresetPreview } from './PresetPreview';

export function PresetPicker({ anchor, open, onClose, readingDirection, format, onPick }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose(): void; readingDirection: ReadingDirection; format: PageFormat; onPick(name: string): void;
}): JSX.Element {
  const layouts = useLayouts();
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Layout presets (cannot be undone)" className="preset-popover">
      {layouts.isPending && <StatusLoader label="Loading presets" />}
      {layouts.error && <p className="error-text">{errorText(layouts.error)}</p>}
      {layouts.data && (
        <div className="preset-grid">
          {layouts.data.map((p) => {
            const label = `${p.name}, ${p.panelCount} ${p.panelCount === 1 ? 'panel' : 'panels'}`;
            return (
              <button key={p.name} type="button" className="preset" aria-label={label} data-tip={label} onClick={() => onPick(p.name)}>
                <PresetPreview name={p.name} dir={readingDirection} format={format} />
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
