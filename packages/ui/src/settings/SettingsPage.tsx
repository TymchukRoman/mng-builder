import type { JSX } from 'react';
import { useSettings } from '../queries';
import { StatusLoader } from '../ui/StatusLoader';
import { ConfigSection } from './ConfigSection';
import { EngineSettings } from './EngineSettings';
import { ModelSettings } from './ModelSettings';
import { RecipeList } from './RecipeList';
import { ReviewSettings } from './ReviewSettings';
import { RoutingSettings } from './RoutingSettings';
import { ServiceChecks } from './ServiceChecks';
import { useSaveSettings } from './useSaveSettings';
import './settings.css';

export function SettingsPage(): JSX.Element {
  const settings = useSettings();
  const { save, setTask } = useSaveSettings();
  if (settings.isError) return <section className="screen"><p className="muted" role="alert">Settings could not be loaded.</p></section>;
  if (!settings.data) return <section className="screen"><StatusLoader label="Loading settings" /></section>;
  const s = settings.data;
  return (
    <section className="screen">
      <div className="settings-grid">
        <EngineSettings settings={s} save={save} setTask={setTask} />
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
