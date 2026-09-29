import { useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import type { FrameKind, PageDetail, PageFormat, ReadingDirection, SplitDir } from '@manga/shared';
import { IconButton } from '../ui/IconButton';
import { ArrowLeft, Columns2, LayoutGrid, Merge, Redo2, Rows2, Sparkles, Undo2, ZoomIn, ZoomOut } from '../ui/icons';
import { CHAPTER_FRAME_KINDS, COVER_FRAME_KINDS } from './editorModel';
import { ExportButton } from './ExportButton';
import { FRAME_KIND_ICON, FRAME_KIND_LABEL } from './frameKinds';
import type { HistorySnapshot } from './history';
import { mergeState, presetState, splitState } from './layoutTree';
import { PresetPicker } from './PresetPicker';
import type { Selection } from './selection';
import { stepZoom, zoomButtonLabel, zoomLabel, type Zoom } from './zoom';

export interface EditorToolbarProps {
  mode: 'chapter' | 'cover';
  title: string;
  backTo: string;
  detail: PageDetail | null;
  selection: Selection;
  history: HistorySnapshot;
  readingDirection: ReadingDirection;
  format: PageFormat;
  zoom: Zoom;
  generating: boolean;
  exportTarget: { type: 'page' | 'chapter'; id: string } | null;
  onUndo(): void;
  onRedo(): void;
  onApplyPreset(name: string): void;
  onSplit(dir: SplitDir): void;
  onMerge(): void;
  onAddFrame(kind: FrameKind): void;
  onGenerate(): void;
  onZoom(z: Zoom): void;
}

export function EditorToolbar(p: EditorToolbarProps): JSX.Element {
  const navigate = useNavigate();
  const presetRef = useRef<HTMLButtonElement>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const pageKind = p.detail?.page.kind ?? 'page';
  const preset = p.detail ? presetState(pageKind) : { enabled: false, reason: 'Layout presets: no page' };
  const split = splitState(p.selection, pageKind);
  const merge = p.detail ? mergeState(p.detail.page.layout, p.selection, pageKind) : { enabled: false, reason: 'Merge: no page' };
  const hasPage = p.detail !== null;
  const panelSelected = p.selection.kind === 'panel';
  const kinds = p.mode === 'cover' ? COVER_FRAME_KINDS : CHAPTER_FRAME_KINDS;

  return (
    <div className="toolbar" role="toolbar" aria-label="Editor tools">
      <IconButton icon={ArrowLeft} label="Back" onClick={() => void navigate(p.backTo)} />
      <span className="toolbar__title" data-tip={p.title}>{p.title}</span>
      <span className="toolbar__sep" />
      <IconButton icon={Undo2} label={p.history.undoLabel ? `Undo: ${p.history.undoLabel.toLowerCase()} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} disabled={!p.history.canUndo} onClick={p.onUndo} />
      <IconButton icon={Redo2} label={p.history.redoLabel ? `Redo: ${p.history.redoLabel.toLowerCase()} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} disabled={!p.history.canRedo} onClick={p.onRedo} />
      {p.mode === 'chapter' && (
        <>
          <span className="toolbar__sep" />
          <IconButton ref={presetRef} icon={LayoutGrid} label={preset.enabled ? 'Layout presets' : preset.reason} disabled={!preset.enabled} active={presetsOpen}
            onClick={() => setPresetsOpen((o) => !o)} />
          <IconButton icon={Rows2} label={split.enabled ? 'Split into top and bottom' : split.reason} disabled={!split.enabled} onClick={() => p.onSplit('h')} />
          <IconButton icon={Columns2} label={split.enabled ? 'Split into left and right' : split.reason} disabled={!split.enabled} onClick={() => p.onSplit('v')} />
          <IconButton icon={Merge} label={merge.reason} disabled={!merge.enabled} onClick={p.onMerge} />
        </>
      )}
      <span className="toolbar__sep" />
      {kinds.map((k) => (
        <IconButton key={k} icon={FRAME_KIND_ICON[k]} label={`Add ${FRAME_KIND_LABEL[k].toLowerCase()}`} disabled={!hasPage} onClick={() => p.onAddFrame(k)} />
      ))}
      <span className="toolbar__sep" />
      <IconButton icon={Sparkles} label={panelSelected ? 'Generate image for the selected panel' : 'Generate image: select a panel'}
        disabled={!panelSelected} busy={p.generating} onClick={p.onGenerate} />
      <span className="spacer" />
      <IconButton icon={ZoomOut} label="Zoom out" onClick={() => p.onZoom(stepZoom(p.zoom, -1))} />
      <button type="button" className="toolbar__zoom" aria-label={zoomButtonLabel(p.zoom)} data-tip={zoomButtonLabel(p.zoom)} onClick={() => p.onZoom({ mode: 'fit' })}>
        {zoomLabel(p.zoom)}
      </button>
      <IconButton icon={ZoomIn} label="Zoom in" onClick={() => p.onZoom(stepZoom(p.zoom, 1))} />
      <span className="toolbar__sep" />
      <ExportButton target={p.exportTarget} />
      {p.mode === 'chapter' && (
        <PresetPicker anchor={presetRef} open={presetsOpen && preset.enabled} onClose={() => setPresetsOpen(false)} readingDirection={p.readingDirection} format={p.format}
          onPick={(name) => { setPresetsOpen(false); p.onApplyPreset(name); }} />
      )}
    </div>
  );
}
