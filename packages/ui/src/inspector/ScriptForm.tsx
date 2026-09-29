import type { JSX } from 'react';
import { AngleSchema, DialogueKindSchema, ShotSchema, StagePositionSchema, type Character, type Panel, type PanelScript } from '@manga/shared';
import { useAutosaveDraft } from '../lib/useAutosaveDraft';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Minus, Plus } from '../ui/icons';

export function ScriptForm({ panel, characters, onSave }: { panel: Panel; characters: Character[]; onSave(script: PanelScript): Promise<void> | void }): JSX.Element {
  const { draft, setDraft, flush } = useAutosaveDraft(panel.script, onSave, 300);
  const set = (p: Partial<PanelScript>): void => setDraft({ ...draft, ...p });
  const first = characters[0];
  return (
    <section className="insp-section" onBlur={flush}>
      <h3>Script</h3>
      <Field label="Action"><textarea className="textarea" rows={2} value={draft.action} onChange={(e) => set({ action: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Shot">
          <select className="select" value={draft.shot} onChange={(e) => set({ shot: ShotSchema.parse(e.target.value) })}>
            {ShotSchema.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Angle">
          <select className="select" value={draft.angle} onChange={(e) => set({ angle: AngleSchema.parse(e.target.value) })}>
            {AngleSchema.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Background"><textarea className="textarea" rows={2} value={draft.background} onChange={(e) => set({ background: e.target.value })} /></Field>

      <div className="section-head">
        <span className="field__label">Characters</span>
        <IconButton icon={Plus} size="sm" label="Add character to panel" disabled={!first}
          onClick={() => { if (first) set({ characters: [...draft.characters, { characterId: first.id, pose: '', expression: '', position: 'center' }] }); }} />
      </div>
      {draft.characters.map((pc, i) => {
        const upd = (p: Partial<typeof pc>): void => set({ characters: draft.characters.map((c, j) => (j === i ? { ...c, ...p } : c)) });
        return (
          <div className="script-row" key={i}>
            <select className="select" aria-label="Character" value={pc.characterId} onChange={(e) => upd({ characterId: e.target.value })}>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="input" aria-label="Pose" placeholder="Pose" value={pc.pose} onChange={(e) => upd({ pose: e.target.value })} />
            <input className="input" aria-label="Expression" placeholder="Expression" value={pc.expression} onChange={(e) => upd({ expression: e.target.value })} />
            <select className="select" aria-label="Position" value={pc.position} onChange={(e) => upd({ position: StagePositionSchema.parse(e.target.value) })}>
              {StagePositionSchema.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <IconButton icon={Minus} size="sm" label="Remove character" onClick={() => set({ characters: draft.characters.filter((_, j) => j !== i) })} />
          </div>
        );
      })}

      <div className="section-head">
        <span className="field__label">Dialogue</span>
        <IconButton icon={Plus} size="sm" label="Add dialogue line" onClick={() => set({ dialogue: [...draft.dialogue, { speakerId: null, kind: 'speech', text: '' }] })} />
      </div>
      {draft.dialogue.map((d, i) => {
        const upd = (p: Partial<typeof d>): void => set({ dialogue: draft.dialogue.map((x, j) => (j === i ? { ...x, ...p } : x)) });
        return (
          <div className="dialogue-row" key={i}>
            <select className="select" aria-label="Speaker" value={d.speakerId ?? ''} onChange={(e) => upd({ speakerId: e.target.value || null })}>
              <option value="">None</option>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="select" aria-label="Line kind" value={d.kind} onChange={(e) => upd({ kind: DialogueKindSchema.parse(e.target.value) })}>
              {DialogueKindSchema.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input className="input dialogue-row__text" aria-label="Dialogue text" value={d.text} onChange={(e) => upd({ text: e.target.value })} />
            <IconButton icon={Minus} size="sm" label="Remove line" onClick={() => set({ dialogue: draft.dialogue.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
    </section>
  );
}
