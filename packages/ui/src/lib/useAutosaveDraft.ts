import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { debounce } from './debounce';

/**
 * A local draft of a server value, saved `ms` after the last change.
 * While the user is editing, server refreshes do not overwrite the draft; once the save settles,
 * the draft follows the server again (so undo and other clients show up).
 * A `save` that returns (or resolves to) `false` declined to save yet: the draft stays dirty, so it is kept.
 * A `save` that throws (or rejects) failed: the draft goes back to the stored value (M5), and the caller shows the error.
 */
export type SaveOutcome = 'saved' | 'declined' | 'failed';

/** Once a save settles: whether the draft is still dirty, and whether it goes back to the stored value (see useAutosaveDraft). */
export function afterSave(outcome: SaveOutcome, newerEditPending: boolean): { dirty: boolean; reset: boolean } {
  if (newerEditPending || outcome === 'declined') return { dirty: true, reset: false };
  return { dirty: false, reset: outcome === 'failed' };
}

export function useAutosaveDraft<T>(value: T, save: (next: T) => unknown, ms = 300): { draft: T; setDraft(next: T): void; flush(): void } {
  const [draft, setDraftState] = useState<T>(value);
  const dirty = useRef(false);
  const saveRef = useRef(save);
  const valueRef = useRef(value);
  useLayoutEffect(() => { saveRef.current = save; valueRef.current = value; });

  const debounced = useMemo(() => debounce((next: T) => {
    let outcome: SaveOutcome = 'saved';
    void Promise.resolve()
      .then(() => saveRef.current(next))
      .then((result) => { if (result === false) outcome = 'declined'; }, () => { outcome = 'failed'; })
      .finally(() => {
        const after = afterSave(outcome, debounced.pending());
        dirty.current = after.dirty;
        if (after.reset) setDraftState(valueRef.current);
      });
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
