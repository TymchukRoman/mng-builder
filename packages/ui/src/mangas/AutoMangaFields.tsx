import { useEffect, useRef, useState, type JSX } from 'react';
import { formatMangaEstimate, type ColorMode } from '@manga/shared';
import { useSettings } from '../queries';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { ImageIcon } from '../ui/icons';
import { ImageModelSelect } from '../ui/ImageModelSelect';
import { EMPTY_AUTO_DRAFT, parseChapters, parsePagesPerChapter, resizeChapterModels, type AutoMangaDraft } from './autoManga';

/**
 * The "from a prompt" half of the New manga dialog: one free-text brief (plot AND notes), the size of the series, the image
 * model of the manga and of each chapter, the poster, and what it will cost. `before` is the brief box on its own, so the dialog
 * can put the shared fields (title, language …) between the brief and the rest.
 */
export function AutoBrief({ value, set }: { value: AutoMangaDraft; set(patch: Partial<AutoMangaDraft>): void }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Field label="Plot and notes" hint="Anything goes: the story, and notes like “simplistic art style”, “short dialogue”, “no romance”.">
      <textarea
        ref={ref} className="textarea" rows={5} aria-label="Plot and notes" value={value.brief}
        placeholder="A stray cat becomes the detective of a harbour town. Simplistic art style, short punchy dialogue."
        onChange={(e) => set({ brief: e.target.value })}
      />
    </Field>
  );
}

export function AutoMangaFields({ value, set, colorMode }: { value: AutoMangaDraft; set(patch: Partial<AutoMangaDraft>): void; colorMode: ColorMode }): JSX.Element {
  const settings = useSettings();
  // The number fields keep what was typed (empty or out of range mid-edit); the draft only ever holds a clamped number.
  const [chaptersText, setChaptersText] = useState(String(value.chapters));
  const [pagesText, setPagesText] = useState(String(value.pages));
  const estimate = settings.data
    ? formatMangaEstimate({ chapters: value.chapters, pagesPerChapter: value.pages, imageModel: value.imageModel, chapterModels: value.chapterModels }, settings.data, colorMode)
    : null;
  return (
    <div className="stack auto-manga">
      <div className="form-row">
        <Field label="Chapters">
          <input
            className="input" type="number" inputMode="numeric" min={1} max={20} value={chaptersText}
            onChange={(e) => {
              setChaptersText(e.target.value);
              const chapters = parseChapters(e.target.value);
              set({ chapters, chapterModels: resizeChapterModels(value.chapterModels, chapters) });
            }}
            onBlur={() => setChaptersText(String(value.chapters))}
          />
        </Field>
        <Field label="Pages per chapter">
          <input
            className="input" type="number" inputMode="numeric" min={1} max={30} value={pagesText}
            onChange={(e) => { setPagesText(e.target.value); set({ pages: parsePagesPerChapter(e.target.value) }); }}
            onBlur={() => setPagesText(String(value.pages))}
          />
        </Field>
      </div>
      <Field label="Image model">
        <ImageModelSelect label="Image model" value={value.imageModel} inheritLabel="Default (Settings → Routing)" onChange={(imageModel) => set({ imageModel })} />
      </Field>
      {value.chapters > 1 && (
        <details className="auto-manga__chapters">
          <summary>Image model per chapter</summary>
          <div className="stack">
            {value.chapterModels.map((m, i) => (
              <Field key={i} label={`Chapter ${i + 1}`} inline>
                <ImageModelSelect
                  compact label={`Image model of chapter ${i + 1}`} value={m} inheritLabel="Same as the manga"
                  onChange={(next) => set({ chapterModels: value.chapterModels.map((x, j) => (j === i ? next : x)) })}
                />
              </Field>
            ))}
          </div>
        </details>
      )}
      <div className="row auto-manga__foot">
        <IconButton icon={ImageIcon} size="sm" active={value.poster} tipSide="top" label="Draw a poster for the manga" onClick={() => set({ poster: !value.poster })} />
        {estimate && <span className="ai-section__estimate" data-testid="auto-estimate">{estimate}</span>}
      </div>
    </div>
  );
}

export { EMPTY_AUTO_DRAFT };
