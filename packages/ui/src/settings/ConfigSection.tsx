import type { JSX } from 'react';
import { useConfig } from '../queries';
import { Info } from '../ui/icons';

const HELP = 'Read-only. Edit %USERPROFILE%\\.manga-builder\\config.json to change these.';

/** Read-only AppConfig (spec §11), from GET /api/config. Renders nothing if the request fails. */
export function ConfigSection(): JSX.Element | null {
  const config = useConfig();
  if (!config.data) return null;
  const c = config.data;
  return (
    <section className="settings-card">
      <div className="section-head">
        <h2>Library and ComfyUI</h2>
        <span className="info-tip" tabIndex={0} role="img" aria-label={HELP} data-tip={HELP}><Info size={14} aria-hidden /></span>
      </div>
      <dl className="kv">
        <dt>Library</dt><dd>{c.libraryPath}</dd>
        <dt>Port</dt><dd>{c.port}</dd>
        <dt>ComfyUI root</dt><dd>{c.comfyRoot}</dd>
        <dt>ComfyUI URL</dt><dd>{c.comfyUrl}</dd>
        <dt>ollama URL</dt><dd>{c.ollamaUrl}</dd>
      </dl>
    </section>
  );
}
