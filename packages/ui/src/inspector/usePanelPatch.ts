import { useCallback } from 'react';
import type { Panel } from '@manga/shared';
import type { Ops } from '../editor/ops';
import type { UpdatePanelBody } from '../types';
import { errorText, pushToast } from '../ui/toasts';

/**
 * Saves panel fields that are autosaved but not undoable (script, prompt, recipe, seed, refs; spec §9.3).
 * It goes through `ops.savePanel`, the same optimistic write the undoable panel commands use, but it never enters the history.
 * A refused save toasts and resolves, so callers can fire and forget.
 */
export function usePanelPatch(panel: Pick<Panel, 'id' | 'pageId'>, ops: Ops): (body: UpdatePanelBody) => Promise<void> {
  const { id, pageId } = panel;
  return useCallback(async (body: UpdatePanelBody) => {
    try {
      await ops.savePanel(pageId, id, body);
    } catch (err) {
      pushToast('error', errorText(err));
    }
  }, [ops, pageId, id]);
}
