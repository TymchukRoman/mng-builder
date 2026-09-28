import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EngineName, Settings } from '@manga/shared';
import { api } from '../api';
import { useSettings, useStatus } from '../queries';
import { qk } from '../queryKeys';
import { Segmented } from '../ui/Segmented';
import { engineIndicator } from './engineState';

export function EngineSwitch(): JSX.Element | null {
  const settings = useSettings();
  const status = useStatus();
  const qc = useQueryClient();
  const setMode = useMutation({
    mutationFn: (mode: EngineName) => api.patch<Settings>('/api/settings', { engine: { mode } }),
    onSuccess: (s) => qc.setQueryData(qk.settings(), s),
  });
  if (!settings.data) return null;
  const mode = settings.data.engine.mode;
  const ind = engineIndicator(mode, status.data);
  return (
    <div className="engine-switch">
      <span className={`status-dot status-dot--${ind.tone}`} role="img" aria-label={ind.tip} data-tip={ind.tip} tabIndex={0} />
      <Segmented<EngineName>
        label="Text engine"
        value={setMode.isPending && setMode.variables ? setMode.variables : mode}
        options={[{ value: 'claude', label: 'Claude' }, { value: 'local', label: 'Local' }]}
        onChange={(m) => { if (m !== mode) setMode.mutate(m); }}
      />
    </div>
  );
}
