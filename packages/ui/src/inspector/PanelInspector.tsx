import type { JSX } from 'react';
import type { Character, Manga, PageDetail, Panel } from '@manga/shared';
import type { EditorCommand } from '../editor/commands';
import type { Ops } from '../editor/ops';
import type { Selection } from '../editor/selection';
import { GenerationSection } from './GenerationSection';
import { ImageSection } from './ImageSection';
import { PromptSection } from './PromptSection';
import { ScriptForm } from './ScriptForm';
import { usePanelPatch } from './usePanelPatch';

export function PanelInspector({ manga, detail, panel, characters, selection, onSelect, run, ops, number }: {
  manga: Manga; detail: PageDetail; panel: Panel; characters: Character[]; selection: Selection; onSelect(s: Selection): void;
  run(cmd: EditorCommand): Promise<void>; ops: Ops; number: number | undefined;
}): JSX.Element {
  const patch = usePanelPatch(panel, ops);
  return (
    <div className="inspector-body">
      <h2 className="inspector-title">Panel {number ?? ''}</h2>
      <ImageSection detail={detail} panel={panel} colorMode={manga.colorMode} selection={selection} onSelect={onSelect} run={run} ops={ops} />
      <ScriptForm panel={panel} characters={characters} onSave={(script) => patch({ script })} />
      <PromptSection pageId={detail.page.id} panel={panel} patch={patch} />
      <GenerationSection panel={panel} characters={characters} patch={patch} />
    </div>
  );
}
