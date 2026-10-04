import type { JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ColorMode, Language, Manga, PageFormat, ReadingDirection, StyleGuide } from '@manga/shared';
import { useRecipes } from '../queries';
import { qk } from '../queryKeys';
import type { UpdateMangaBody } from '../types';
import { AutoText } from '../ui/AutoText';
import { Drawer } from '../ui/Drawer';
import { Field } from '../ui/Field';
import { ArrowLeft, ArrowRight } from '../ui/icons';
import { ImageModelSelect } from '../ui/ImageModelSelect';
import { NumberField } from '../ui/NumberField';
import { Segmented } from '../ui/Segmented';
import { LoraEditor } from './LoraEditor';
import { pageSizeLabel, recipeOptions } from './mangaModel';
import { usePatchManga } from './usePatchManga';

type Margin = keyof PageFormat['marginsMm'];
const MARGINS: Array<[Margin, string]> = [['top', 'Top margin'], ['bottom', 'Bottom margin'], ['inner', 'Inner margin'], ['outer', 'Outer margin']];

export function MangaSettingsDrawer({ manga, open, onClose }: { manga: Manga; open: boolean; onClose(): void }): JSX.Element {
  const recipes = useRecipes();
  const qc = useQueryClient();
  const patch = usePatchManga(manga.id);
  // Nested objects (styleGuide, pageFormat) are replaced whole by the server, so every edit is merged into the latest
  // cached manga, not the props of this render: two quick edits must not overwrite each other.
  const latest = (): Manga => qc.getQueryData<Manga>(qk.manga(manga.id)) ?? manga;
  const styleBody = (p: Partial<StyleGuide>): UpdateMangaBody => ({ styleGuide: { ...latest().styleGuide, ...p } });
  const formatBody = (p: Partial<PageFormat>): UpdateMangaBody => ({ pageFormat: { ...latest().pageFormat, ...p } });
  /** Fire and forget: a failure toasts through the mutation cache. */
  const save = (body: UpdateMangaBody): void => patch.mutate(body);
  /** For autosaving fields, which wait for the save to settle. */
  const saveAsync = async (body: UpdateMangaBody): Promise<void> => { await patch.mutateAsync(body); };
  const sg = manga.styleGuide;
  const pf = manga.pageFormat;
  const margin = (key: Margin, v: number): void => save(formatBody({ marginsMm: { ...latest().pageFormat.marginsMm, [key]: v } }));

  return (
    <Drawer open={open} onClose={onClose} title="Manga settings">
      <section className="drawer-section">
        <h3>Story</h3>
        <Field label="Language" group>
          <Segmented<Language> label="Language" value={manga.language} onChange={(language) => save({ language })}
            options={[{ value: 'en', label: 'English' }, { value: 'uk', label: 'Українська' }]} />
        </Field>
        <div className="grid-2">
          <Field label="Colour" group>
            <Segmented<ColorMode> label="Colour" value={manga.colorMode} onChange={(colorMode) => save({ colorMode })}
              options={[{ value: 'bw', label: 'B&W' }, { value: 'color', label: 'Colour' }]} />
          </Field>
          <Field label="Reading direction" group>
            <Segmented<ReadingDirection> label="Reading direction" value={manga.readingDirection} onChange={(readingDirection) => save({ readingDirection })}
              options={[{ value: 'rtl', label: 'Right to left', icon: ArrowLeft }, { value: 'ltr', label: 'Left to right', icon: ArrowRight }]} />
          </Field>
        </div>
      </section>

      <section className="drawer-section">
        <h3>Image model</h3>
        <Field label="Image model">
          <ImageModelSelect label="Image model" value={manga.imageModel} inheritLabel="Default (Settings → Routing)" onChange={(imageModel) => save({ imageModel })} />
        </Field>
      </section>

      <section className="drawer-section">
        <h3>Style guide</h3>
        <Field label="Recipe">
          {(recipes.data ?? []).length > 0 ? (
            <select className="select" value={sg.recipe} onChange={(e) => save(styleBody({ recipe: e.target.value }))}>
              {recipeOptions(recipes.data, sg.recipe).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          ) : (
            <AutoText label="Recipe" value={sg.recipe} onSave={(v) => (v.trim() ? saveAsync(styleBody({ recipe: v.trim() })) : undefined)} />
          )}
        </Field>
        <Field label="Style prompt"><AutoText multiline label="Style prompt" value={sg.stylePrompt} onSave={(stylePrompt) => saveAsync(styleBody({ stylePrompt }))} /></Field>
        <Field label="Negative prompt"><AutoText multiline label="Negative prompt" value={sg.negativePrompt} onSave={(negativePrompt) => saveAsync(styleBody({ negativePrompt }))} /></Field>
        <LoraEditor loras={sg.loras} onChange={(loras) => save(styleBody({ loras }))} />
      </section>

      <section className="drawer-section">
        <h3>Page geometry</h3>
        <span className="status-chip page-size" data-tip="Page size and resolution are fixed">{pageSizeLabel(pf)}</span>
        <div className="grid-2">
          {MARGINS.map(([key, label]) => (
            <Field key={key} label={`${label.replace(' margin', '')} (mm)`}>
              <NumberField label={label} value={pf.marginsMm[key]} min={0} max={100} step={0.5} onSave={(v) => margin(key, v)} />
            </Field>
          ))}
          <Field label="Column gutter (mm)"><NumberField label="Column gutter" value={pf.gutterColMm} min={0} max={50} step={0.5} onSave={(gutterColMm) => save(formatBody({ gutterColMm }))} /></Field>
          <Field label="Row gutter (mm)"><NumberField label="Row gutter" value={pf.gutterRowMm} min={0} max={50} step={0.5} onSave={(gutterRowMm) => save(formatBody({ gutterRowMm }))} /></Field>
          <Field label="Border (mm)"><NumberField label="Border width" value={pf.borderMm} min={0} max={10} step={0.1} onSave={(borderMm) => save(formatBody({ borderMm }))} /></Field>
        </div>
      </section>
    </Drawer>
  );
}
