export interface ImageResult { label: string; ok: boolean }

export type RenderOutcome = { ready: true } | { ready: false; error: string };

/**
 * The print route may only signal READY when every image decoded. A missing or corrupt image would otherwise
 * be exported as a blank panel, so the route reports the failing panels instead and the exporter fails fast.
 */
export function renderOutcome(results: readonly ImageResult[]): RenderOutcome {
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  if (failed.length === 0) return { ready: true };
  return { ready: false, error: `Could not decode the image of ${failed.join(', ')}` };
}
