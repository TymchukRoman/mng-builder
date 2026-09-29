import type { JSX } from 'react';
import type { ServiceState } from '@manga/shared';
import { useStatus } from '../queries';
import { IconButton } from '../ui/IconButton';
import { RefreshCw } from '../ui/icons';
import { queueSummary, serviceView } from './settingsPatch';

export function ServiceChecks(): JSX.Element {
  const status = useStatus();
  const s = status.data;
  const rows: Array<[string, ServiceState | undefined]> = [['Claude CLI', s?.claude], ['ollama', s?.ollama], ['ComfyUI', s?.comfy]];
  return (
    <section className="settings-card">
      <div className="section-head">
        <h2 data-tip={queueSummary(s)} data-tip-side="right">Services</h2>
        <IconButton icon={RefreshCw} label="Check again" size="sm" busy={status.isFetching} onClick={() => void status.refetch()} />
      </div>
      <ul className="service-list">
        {rows.map(([name, state]) => {
          const view = serviceView(state, status.isError);
          return (
            <li key={name} className="service-row">
              <span className={`status-dot status-dot--${view.tone}`} aria-hidden />
              <span className="service-row__name">{name}</span>
              <span className="service-row__detail" data-tip={state?.detail || undefined}>{view.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
