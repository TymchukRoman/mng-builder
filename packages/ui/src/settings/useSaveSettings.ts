import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsPatch, Task } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';
import { applySettingsPatch, tasksPatch, type SaveSettings, type TaskChoice } from './settingsPatch';

const MUTATION_KEY = ['settings', 'patch'] as const;

/**
 * PATCH /api/settings, applied optimistically (same pattern as usePatchManga). The server replaces `engine.tasks`
 * whole, so every override change is built from the cache at call time: a second change made before the first
 * settles then carries both overrides. Failures roll back and reach the user through the app-wide mutation toast.
 */
export function useSaveSettings(): { save: SaveSettings; setTask(task: Task, choice: TaskChoice): void } {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: (p: SettingsPatch) => api.patch<Settings>('/api/settings', p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: qk.settings() });
      const previous = qc.getQueryData<Settings>(qk.settings());
      if (previous) qc.setQueryData(qk.settings(), applySettingsPatch(previous, p));
      return { previous };
    },
    onError: (_err, _p, ctx) => { if (ctx?.previous) qc.setQueryData(qk.settings(), ctx.previous); },
    // Refetch only when the last in-flight save settles, so an earlier response cannot undo a later optimistic edit.
    onSettled: () => { if (qc.isMutating({ mutationKey: MUTATION_KEY }) <= 1) void qc.invalidateQueries({ queryKey: qk.settings() }); },
  });
  const save: SaveSettings = (p, opts) => patch.mutate(p, opts?.onError ? { onError: opts.onError } : undefined);
  const setTask = (task: Task, choice: TaskChoice): void => {
    const current = qc.getQueryData<Settings>(qk.settings());
    if (current) save(tasksPatch(current, task, choice));
  };
  return { save, setTask };
}
