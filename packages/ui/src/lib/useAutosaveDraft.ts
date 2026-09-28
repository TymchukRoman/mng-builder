import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { debounce } from './debounce';

/**
 * A local draft of a server value, saved `ms` after the last change.
 * While the user is editing, server refreshes do not overwrite the draft; once the save settles,
 * the draft follows the server again (so undo and other clients show up).
 */
export function useAutosaveDraft<T>(value: T, save: (next: T) => void | Promise<unknown>, ms = 300): { draft: T; setDraft(next: T): void; flush(): void } {
  const [draft, setDraftState] = useState<T>(value);
  const dirty = useRef(false);
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });

  const debounced = useMemo(() => debounce((next: T) => {
    void Promise.resolve()
      .then(() => saveRef.current(next))
      .catch(() => undefined)
      .finally(() => { if (!debounced.pending()) dirty.current = false; });
  }, ms), [ms]);

  useEffect(() => { if (!dirty.current) setDraftState(value); }, [value]);
  useEffect(() => () => debounced.flush(), [debounced]);

  const setDraft = useCallback((next: T) => {
    dirty.current = true;
    setDraftState(next);
    debounced(next);
  }, [debounced]);

  return { draft, setDraft, flush: debounced.flush };
}
