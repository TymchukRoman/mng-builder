import type { JSX } from 'react';
import type { Manga, PageDetail } from '@manga/shared';
import type { EditorCommand } from '../editor/commands';
import type { Ops } from '../editor/ops';
import type { Selection } from '../editor/selection';
import { useCharacters } from '../queries';
import { FrameInspector } from './FrameInspector';
import { panelNumbers } from './inspectorModel';
import { PageInspector } from './PageInspector';
import { PanelInspector } from './PanelInspector';
import './inspector.css';

export interface InspectorProps {
  manga: Manga;
  detail: PageDetail;
  pageNumber: number | null;
  selection: Selection;
  onSelect(s: Selection): void;
  /** Runs a command through History and toasts a rejection (Task 18 supplies it). */
  run(cmd: EditorCommand): Promise<void>;
  ops: Ops;
  mode: 'chapter' | 'cover';
}

export function Inspector({ manga, detail, pageNumber, selection, onSelect, run, ops, mode }: InspectorProps): JSX.Element {
  const characters = useCharacters(manga.id).data ?? [];
  if (selection.kind === 'frame') {
    const frame = detail.frames.find((f) => f.id === selection.frameId);
    if (frame) {
      return (
        <aside className="inspector" aria-label="Inspector">
          <FrameInspector key={frame.id} manga={manga} detail={detail} frame={frame} characters={characters} run={run} ops={ops} onSelect={onSelect} mode={mode} />
        </aside>
      );
    }
  }
  if (selection.kind === 'panel') {
    const panel = detail.panels.find((p) => p.id === selection.panelId);
    if (panel) {
      return (
        <aside className="inspector" aria-label="Inspector">
          <PanelInspector key={panel.id} manga={manga} detail={detail} panel={panel} characters={characters} selection={selection} onSelect={onSelect} run={run} ops={ops}
            number={panelNumbers(detail.page.layout, manga.readingDirection).get(panel.id)} />
        </aside>
      );
    }
  }
  return (
    <aside className="inspector" aria-label="Inspector">
      <PageInspector detail={detail} number={pageNumber} onSelect={onSelect} />
    </aside>
  );
}
