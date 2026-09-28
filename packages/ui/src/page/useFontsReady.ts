import { useEffect, useState } from 'react';

/** Increments when fonts finish loading, so text measurements rerun with the real face. */
export function useFontsReady(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    let alive = true;
    const bump = (): void => { if (alive) setTick((t) => t + 1); };
    void fonts.ready.then(bump);
    fonts.addEventListener('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener('loadingdone', bump);
    };
  }, []);
  return tick;
}
