import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsPatch } from '@manga/shared';
import { api } from '../api';
import { useSettings } from '../queries';
import { qk } from '../queryKeys';
import { StatusLoader } from '../ui/StatusLoader';
import { ConfigSection } from './ConfigSection';
import { EngineSettings } from './EngineSettings';
import { ModelSettings } from './ModelSettings';
import { RecipeList } from './RecipeList';
import { ReviewSettings } from './ReviewSettings';
import { RoutingSettings } from './RoutingSettings';
import { ServiceChecks } from './ServiceChecks';
import './settings.css';

export function SettingsPage(): JSX.Element {
  const settings = useSettings();
  const qc = useQueryClient();
  // Failures reach the user through the app-wide mutation error toast, so saves are fire-and-forget.
  const patch = useMutation({
    mutationFn: (p: SettingsPatch) => api.patch<Settings>('/api/settings', p),
    onSuccess: (s) => qc.setQueryData(qk.settings(), s),
    onError: () => void qc.invalidateQueries({ queryKey: qk.settings() }),
  });
  if (settings.isError) return <section className="screen"><p className="muted" role="alert">Settings could not be loaded.</p></section>;
  if (!settings.data) return <section className="screen"><StatusLoader label="Loading settings" /></section>;
  const s = settings.data;
  const save = (p: SettingsPatch): void => patch.mutate(p);
  return (
    <section className="screen">
      <div className="settings-grid">
        <EngineSettings settings={s} save={save} />
        <ServiceChecks />
        <ModelSettings settings={s} save={save} />
        <RoutingSettings settings={s} save={save} />
        <ReviewSettings settings={s} save={save} />
        <ConfigSection />
        <RecipeList />
      </div>
    </section>
  );
}
