import { useEffect, useRef, useState } from 'react';

export interface LiveOverride<T> {
  value: T;
  begin(): void;
  update(v: T): void;
  /** Stops dragging; returns the last live value (kept on screen until `committed` changes), or null. */
  end(): T | null;
  cancel(): void;
}

export function useLiveOverride<T>(committed: T): LiveOverride<T> {
  const [live, setLive] = useState<{ v: T } | null>(null);
  const dragging = useRef(false);
  const last = useRef<{ v: T } | null>(null);
  useEffect(() => {
    if (!dragging.current) { last.current = null; setLive(null); }
  }, [committed]);
  return {
    value: live ? live.v : committed,
    begin: () => { dragging.current = true; },
    update: (v) => { last.current = { v }; setLive({ v }); },
    end: () => { dragging.current = false; return last.current ? last.current.v : null; },
    cancel: () => { dragging.current = false; last.current = null; setLive(null); },
  };
}
