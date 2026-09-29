import type { JSX } from 'react';
import type { EngineName } from '@manga/shared';
import { useSettings, useStatus } from '../queries';
import { useSaveSettings } from '../settings/useSaveSettings';
import { Segmented } from '../ui/Segmented';
import { engineIndicator } from './engineState';

export function EngineSwitch(): JSX.Element | null {
  const settings = useSettings();
  const status = useStatus();
  // The same optimistic settings save as the settings page (M4): the switch flips at once and rolls back on failure.
  const { save } = useSaveSettings();
  if (!settings.data) return null;
  const mode = settings.data.engine.mode;
  const ind = engineIndicator(mode, status.data);
  return (
    <div className="engine-switch">
      <span className={`status-dot status-dot--${ind.tone}`} role="img" aria-label={ind.tip} data-tip={ind.tip} tabIndex={0} />
      <Segmented<EngineName>
        label="Text engine"
        value={mode}
        options={[{ value: 'claude', label: 'Claude' }, { value: 'local', label: 'Local' }]}
        onChange={(m) => { if (m !== mode) save({ engine: { mode: m } }); }}
      />
    </div>
  );
}
