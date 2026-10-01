import type { JSX } from 'react';
import type { Settings } from '@manga/shared';
import { Field } from '../ui/Field';
import { NumberField } from '../ui/NumberField';
import type { SaveSettings } from './settingsPatch';

export function ReviewSettings({ settings, save }: { settings: Settings; save: SaveSettings }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>Image review</h2>
      <label className="toggle">
        <input type="checkbox" checked={settings.review.autoInEpisode} onChange={(e) => save({ review: { autoInEpisode: e.target.checked } })} />
        <span>Review images automatically during episodes</span>
      </label>
      <Field label="Retry rounds" inline>
        <NumberField label="Retry rounds" value={settings.review.rounds} min={0} max={5} integer onSave={(rounds) => save({ review: { rounds } })} />
      </Field>
      <Field label="Confirm renders over (min)" inline>
        <NumberField label="Confirm renders over (min)" value={settings.episode.confirmRenderMinutes} min={1} max={1440} integer
          onSave={(confirmRenderMinutes) => save({ episode: { confirmRenderMinutes } })} />
      </Field>
    </section>
  );
}
