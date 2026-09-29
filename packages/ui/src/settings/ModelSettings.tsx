import type { JSX } from 'react';
import type { Settings } from '@manga/shared';
import { Field } from '../ui/Field';
import { ModelField } from './ModelField';
import { TASKS, TASK_LABEL, type SaveSettings } from './settingsPatch';

export function ModelSettings({ settings, save }: { settings: Settings; save: SaveSettings }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>Models</h2>
      {TASKS.map((task) => (
        <Field key={task} label={`Claude: ${TASK_LABEL[task].toLowerCase()}`} inline>
          <ModelField label={`Claude model for ${TASK_LABEL[task].toLowerCase()}`} value={settings.claude.models[task]}
            save={(model, onError) => save({ claude: { models: { [task]: model } } }, { onError })} />
        </Field>
      ))}
      <Field label="ollama text model" inline>
        <ModelField label="ollama text model" value={settings.ollama.textModel}
          save={(textModel, onError) => save({ ollama: { textModel } }, { onError })} />
      </Field>
      <Field label="ollama vision model" inline>
        <ModelField label="ollama vision model" value={settings.ollama.visionModel}
          save={(visionModel, onError) => save({ ollama: { visionModel } }, { onError })} />
      </Field>
    </section>
  );
}
