import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, type PageDetail } from '@manga/shared';
import { EditorToolbar } from '../src/editor/EditorToolbar';
import type { HistorySnapshot } from '../src/editor/history';
import { PAGE_SELECTION, panelSelection, type Selection } from '../src/editor/selection';
import { makeDetail } from './fixtures';

const IDLE: HistorySnapshot = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, undoPageId: null, redoPageId: null, busy: false };
const noop = (): void => undefined;

/** The toolbar's accessible labels (used by the E2E specs), rendered without a DOM. */
function render(mode: 'chapter' | 'cover', selection: Selection, detail: PageDetail | null = makeDetail(), history = IDLE): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <EditorToolbar mode={mode} title="1. Start" backTo="/m/mg_1" detail={detail} selection={selection} history={history}
          readingDirection="rtl" format={DEFAULT_PAGE_FORMAT} zoom={{ mode: 'fit' }} generating={false} exportTarget={null}
          onUndo={noop} onRedo={noop} onApplyPreset={noop} onSplit={noop} onMerge={noop} onAddFrame={noop} onGenerate={noop} onZoom={noop} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const enabled = (html: string, label: string): boolean => {
  const escaped = label.replace(/[()+]/g, (c) => `\\${c}`);
  const tag = html.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no button "${label}"`);
  return !tag.includes('aria-disabled="true"');
};

describe('editor toolbar', () => {
  it('chapter mode: layout tools, the five story frame kinds, zoom and the disabled export slot', () => {
    const html = render('chapter', panelSelection('pn_a', { mergeWith: 'pn_b' }));
    for (const label of ['Layout presets', 'Split into top and bottom', 'Split into left and right', 'Merge panels (cannot be undone)',
      'Add speech bubble', 'Add thought bubble', 'Add shout', 'Add narration box', 'Add sound effect',
      'Generate image for the selected panel', 'Zoom out', 'Fit page to screen', 'Zoom in']) {
      expect(enabled(html, label), label).toBe(true);
      expect(html).toContain(`data-tip="${label}"`);
    }
    expect(enabled(html, 'Export (coming soon)')).toBe(false);
    expect(html).not.toContain('Add title');
  });

  it('without a panel selection, split, merge and generate are disabled with a reason', () => {
    const html = render('chapter', PAGE_SELECTION);
    expect(enabled(html, 'Select a panel to split')).toBe(false);
    expect(enabled(html, 'Merge: select a panel, then shift-click its neighbour')).toBe(false);
    expect(enabled(html, 'Generate image: select a panel')).toBe(false);
  });

  it('cover mode: only "Add title", no layout tools', () => {
    const detail = makeDetail();
    detail.page = { ...detail.page, kind: 'cover', chapterId: null, layout: { type: 'panel', id: 'pn_a' } };
    const html = render('cover', panelSelection('pn_a'), detail);
    expect(enabled(html, 'Add title')).toBe(true);
    for (const gone of ['Layout presets', 'Split into', 'Merge', 'Add speech bubble']) expect(html).not.toContain(gone);
  });

  it('names the command undo and redo would run', () => {
    const html = render('chapter', PAGE_SELECTION, makeDetail(), { canUndo: true, canRedo: true, undoLabel: 'Resize panels', redoLabel: 'Add speech', undoPageId: null, redoPageId: null, busy: false });
    expect(enabled(html, 'Undo: resize panels (Ctrl+Z)')).toBe(true);
    expect(enabled(html, 'Redo: add speech (Ctrl+Y)')).toBe(true);
  });
});
