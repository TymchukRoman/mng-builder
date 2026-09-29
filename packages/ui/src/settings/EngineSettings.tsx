import type { JSX } from 'react';
import type { EngineName, Settings, Task } from '@manga/shared';
import { Field } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import { TASKS, TASK_LABEL, taskChoice, type SaveSettings, type TaskChoice } from './settingsPatch';

const ENGINE_LABEL: Record<EngineName, string> = { claude: 'Claude', local: 'Local' };

export function EngineSettings({ settings, save, setTask }: { settings: Settings; save: SaveSettings; setTask(task: Task, choice: TaskChoice): void }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>Text engine</h2>
      <Field label="Default" group inline>
        <Segmented<EngineName> label="Default engine" value={settings.engine.mode} onChange={(mode) => save({ engine: { mode } })}
          options={[{ value: 'claude', label: 'Claude' }, { value: 'local', label: 'Local' }]} />
      </Field>
      {TASKS.map((task) => (
        <Field key={task} label={TASK_LABEL[task]} inline>
          <select className="select select--compact" value={taskChoice(settings, task)}
            onChange={(e) => setTask(task, e.target.value as TaskChoice)}>
            <option value="default">Default ({ENGINE_LABEL[settings.engine.mode]})</option>
            <option value="claude">Claude</option>
            <option value="local">Local</option>
          </select>
        </Field>
      ))}
    </section>
  );
}
