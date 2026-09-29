import { useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsPatch, Task } from '@manga/shared';
import { api } from '../api';
import { useOptimisticPatch } from '../lib/optimisticPatch';
import { qk } from '../queryKeys';
import { applySettingsPatch, tasksPatch, type SaveSettings, type TaskChoice } from './settingsPatch';

/**
 * PATCH /api/settings through the shared optimistic pattern (lib/optimisticPatch), used by the settings page and the
 * top bar's engine switch alike. The server replaces `engine.tasks` whole, so every override change is built from the
 * cache at call time: a second change made before the first settles then carries both overrides. Failures roll back
 * and reach the user through the app-wide mutation toast.
 */
export function useSaveSettings(): { save: SaveSettings; setTask(task: Task, choice: TaskChoice): void } {
  const qc = useQueryClient();
  const patch = useOptimisticPatch<Settings, SettingsPatch, Settings>({
    queryKey: qk.settings(),
    mutationKey: ['settings', 'patch'],
    send: (p) => api.patch<Settings>('/api/settings', p),
    apply: applySettingsPatch,
  });
  const save: SaveSettings = (p, opts) => patch.mutate(p, opts?.onError ? { onError: opts.onError } : undefined);
  const setTask = (task: Task, choice: TaskChoice): void => {
    const current = qc.getQueryData<Settings>(qk.settings());
    if (current) save(tasksPatch(current, task, choice));
  };
  return { save, setTask };
}
