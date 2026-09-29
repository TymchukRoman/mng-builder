import type { JSX } from 'react';
import type { Settings } from '@manga/shared';
import { AutoText } from '../ui/AutoText';
import { Field } from '../ui/Field';
import { TASKS, TASK_LABEL, modelValue, type SaveSettings } from './settingsPatch';

export function ModelSettings({ settings, save }: { settings: Settings; save: SaveSettings }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>Models</h2>
      {TASKS.map((task) => {
        const label = `Claude model for ${TASK_LABEL[task].toLowerCase()}`;
        return (
          <Field key={task} label={`Claude: ${TASK_LABEL[task].toLowerCase()}`} inline>
            <AutoText label={label} value={settings.claude.models[task]}
              onSave={(v) => {
                const model = modelValue(v, settings.claude.models[task]);
                if (model) save({ claude: { models: { [task]: model } } });
              }} />
          </Field>
        );
      })}
      <Field label="ollama text model" inline>
        <AutoText label="ollama text model" value={settings.ollama.textModel}
          onSave={(v) => { const m = modelValue(v, settings.ollama.textModel); if (m) save({ ollama: { textModel: m } }); }} />
      </Field>
      <Field label="ollama vision model" inline>
        <AutoText label="ollama vision model" value={settings.ollama.visionModel}
          onSave={(v) => { const m = modelValue(v, settings.ollama.visionModel); if (m) save({ ollama: { visionModel: m } }); }} />
      </Field>
    </section>
  );
}
