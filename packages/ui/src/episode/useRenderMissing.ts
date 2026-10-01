import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRef } from '@manga/shared';
import { api, seg } from '../api';
import { qk } from '../queryKeys';
import { pushToast } from '../ui/toasts';
import { renderMissingNotice } from './episodeView';

/**
 * W1 R1: queue a render for every panel of the chapter without an image (the episode panel and the editor toolbar).
 * Rejections are toasted by the MutationCache; the job bar shows the queued renders; a click that queued nothing says so.
 */
export function useRenderMissing(chapterId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<JobRef[]>(`/api/chapters/${seg(chapterId)}/render-missing`),
    onSuccess: (queued) => {
      const notice = renderMissingNotice(queued);
      if (notice) pushToast('info', notice);
      void qc.invalidateQueries({ queryKey: qk.jobs() });
      if (chapterId) void qc.invalidateQueries({ queryKey: qk.missingPanels(chapterId) });
    },
  });
}
