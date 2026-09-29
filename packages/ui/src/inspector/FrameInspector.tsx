import type { JSX } from 'react';
import { DEFAULT_FONT_SIZE, FONT_FOR_KIND, FrameKindSchema, type Character, type FrameKind, type Manga, type PageDetail, type TextFrame } from '@manga/shared';
import type { EditorCommand } from '../editor/commands';
import { canRotate, hasTail } from '../editor/frameDrag';
import { FRAME_KIND_ICON, FRAME_KIND_LABEL } from '../editor/frameKinds';
import type { Ops } from '../editor/ops';
import { PAGE_SELECTION, type Selection } from '../editor/selection';
import { useAutosaveDraft } from '../lib/useAutosaveDraft';
import type { UpdateFrameBody } from '../types';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { AlignCenter, AlignLeft, AlignRight, Maximize, X } from '../ui/icons';
import { NumberField } from '../ui/NumberField';
import { Segmented } from '../ui/Segmented';
import { fontChoices, panelNumbers } from './inspectorModel';

/** Every edit is an `ops.updateFrame` command, so undo and redo cover it; the text is batched (one command per burst of typing). */
export function FrameInspector({ manga, detail, frame, characters, run, ops, onSelect, mode }: {
  manga: Manga; detail: PageDetail; frame: TextFrame; characters: Character[];
  run(cmd: EditorCommand): Promise<void>; ops: Ops; onSelect(s: Selection): void; mode: 'chapter' | 'cover';
}): JSX.Element {
  const pageId = detail.page.id;
  const update = (before: UpdateFrameBody, after: UpdateFrameBody, label: string): void => { void run(ops.updateFrame(pageId, frame.id, before, after, label)); };
  const text = useAutosaveDraft(frame.text, (next) => run(ops.updateFrame(pageId, frame.id, { text: frame.text }, { text: next }, 'Edit text')), 300);
  const numbers = panelNumbers(detail.page.layout, manga.readingDirection);
  const kinds = FrameKindSchema.options.filter((k) => mode === 'cover' || k !== 'title');

  return (
    <div className="inspector-body">
      <div className="section-head">
        <h2 className="inspector-title">{FRAME_KIND_LABEL[frame.kind]}</h2>
        <ConfirmIconButton label="Delete frame" confirmLabel="Click again to delete this frame"
          onConfirm={() => { onSelect(PAGE_SELECTION); void run(ops.deleteFrame(frame)); }} />
      </div>
      <section className="insp-section">
        <Field label="Text">
          <textarea className="textarea frame-textarea" aria-label="Text" rows={4} value={text.draft} onBlur={text.flush}
            style={{ fontFamily: `"${frame.font}", sans-serif` }} onChange={(e) => text.setDraft(e.target.value)} />
        </Field>
        <Field label="Kind" group>
          <Segmented<FrameKind> label="Frame kind" value={frame.kind}
            options={kinds.map((k) => ({ value: k, label: FRAME_KIND_LABEL[k], icon: FRAME_KIND_ICON[k] }))}
            onChange={(kind) => update(
              { kind: frame.kind, font: frame.font, fontSize: frame.fontSize },
              { kind, font: FONT_FOR_KIND[kind], fontSize: DEFAULT_FONT_SIZE[kind] },
              'Change frame kind',
            )} />
        </Field>
        <div className="grid-2">
          <Field label="Speaker">
            <select className="select" value={frame.speakerId ?? ''} onChange={(e) => update({ speakerId: frame.speakerId }, { speakerId: e.target.value || null }, 'Change speaker')}>
              <option value="">None</option>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Panel">
            <select className="select" value={frame.panelId ?? ''} onChange={(e) => update({ panelId: frame.panelId }, { panelId: e.target.value || null }, 'Change anchor panel')}>
              <option value="">Page</option>
              {[...numbers].map(([id, n]) => <option key={id} value={id}>Panel {n}</option>)}
            </select>
          </Field>
        </div>
      </section>
      <section className="insp-section">
        <h3>Type</h3>
        <Field label="Font">
          <select className="select" value={frame.font} onChange={(e) => update({ font: frame.font }, { font: e.target.value }, 'Change font')}>
            {fontChoices(frame.font).map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}", sans-serif` }}>{f}</option>)}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Size (pt)">
            <NumberField label="Font size" value={frame.fontSize} min={4} max={96} step={0.5}
              onSave={(fontSize) => update({ fontSize: frame.fontSize }, { fontSize }, 'Change font size')} />
          </Field>
          <Field label="Align" group>
            <Segmented label="Text align" value={frame.align}
              options={[{ value: 'left', label: 'Align left', icon: AlignLeft }, { value: 'center', label: 'Centre', icon: AlignCenter }, { value: 'right', label: 'Align right', icon: AlignRight }]}
              onChange={(align) => update({ align: frame.align }, { align }, 'Change alignment')} />
          </Field>
        </div>
        <div className="row">
          <IconButton icon={Maximize} active={frame.autoFit}
            label={frame.autoFit ? 'Auto-fit on: text shrinks to fit the frame' : 'Auto-fit off: fixed size'}
            onClick={() => update({ autoFit: frame.autoFit }, { autoFit: !frame.autoFit }, 'Toggle auto-fit')} />
          {hasTail(frame.kind) && frame.tail && (
            <IconButton icon={X} label="Remove tail" onClick={() => update({ tail: frame.tail }, { tail: null }, 'Remove tail')} />
          )}
        </div>
        {canRotate(frame.kind) && (
          <Field label="Rotation (°)">
            <NumberField label="Rotation" value={frame.rotation} min={-180} max={180} integer
              onSave={(rotation) => update({ rotation: frame.rotation }, { rotation }, 'Rotate frame')} />
          </Field>
        )}
      </section>
    </div>
  );
}
