import type { JSX } from 'react';
import type { PageDetail } from '@manga/shared';
import { FRAME_KIND_ICON } from '../editor/frameKinds';
import { Info } from '../ui/icons';
import { frameSelection, type Selection } from '../editor/selection';
import { framesInOrder } from '../page/pageModel';

export function PageInspector({ detail, number, onSelect }: { detail: PageDetail; number: number | null; onSelect(s: Selection): void }): JSX.Element {
  const frames = framesInOrder(detail.frames);
  const stats = `${detail.panels.length} panels, ${detail.frames.length} text frames`;
  return (
    <div className="inspector-body">
      <div className="section-head">
        <h2 className="inspector-title">{detail.page.kind === 'cover' ? 'Cover' : `Page ${number ?? ''}`}</h2>
        <span className="page-stats" role="img" aria-label={stats} data-tip={stats}><Info size={14} aria-hidden /></span>
      </div>
      {frames.length > 0 && (
        <ul className="frame-list">
          {frames.map((f) => {
            const Icon = FRAME_KIND_ICON[f.kind];
            return (
              <li key={f.id}>
                <button type="button" className="frame-list__item" onClick={() => onSelect(frameSelection(f.id))}>
                  <Icon size={14} aria-hidden />
                  <span>{f.text || '...'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
