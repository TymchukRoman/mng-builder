import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FrameKind, JobRef, Manga, Page, SplitDir } from '@manga/shared';
import { api, ApiError, seg } from '../api';
import { Inspector } from '../inspector/Inspector';
import { JobBar } from '../jobs/JobBar';
import { cx } from '../lib/cx';
import { pageSizePx } from '../page/geometry';
import { renderBlock } from '../episode/episodeView';
import { useRenderMissing } from '../episode/useRenderMissing';
import { useEpisode, useMissingPanels, usePageDetail } from '../queries';
import { qk } from '../queryKeys';
import { errorText, pushToast } from '../ui/toasts';
import { queryCache } from './cacheAdapter';
import { Canvas } from './Canvas';
import type { EditorCommand } from './commands';
import { ConfirmPresetModal } from './ConfirmPresetModal';
import { EditorToolbar } from './EditorToolbar';
import {
  autoLetterFlow, deletePageFlow, escapeSelection, exportTarget, frameInsert, pageAfterRemoval, pageToShow, removedPanelCount, resolveCurrentPage,
} from './editorModel';
import { History, IdMap } from './history';
import { HistoryBarrierContext, type Barrier } from './HistoryBarrierContext';
import { createOps } from './ops';
import { OpsContext } from './OpsContext';
import { PageList } from './PageList';
import { PAGE_SELECTION, frameSelection, panelSelection, reconcileSelection, selectedPanelId, type Selection } from './selection';
import { useEditorKeys } from './useEditorKeys';
import { useFrameNudge } from './useFrameNudge';
import { useHistorySnapshot } from './useHistory';
import { fitWidth, zoomFactor, type Zoom } from './zoom';
import './editor.css';

export interface ChapterEditorProps {
  manga: Manga;
  mode: 'chapter' | 'cover';
  chapterId: string | null;
  pageIds: string[];
  title: string;
  backTo: string;
  aside?: ReactNode;
}

/**
 * The chapter and cover editor (spec §9, §11). The current page lives in `?p=<pageId>`. Every layout, frame, transform
 * and variant edit runs through one History: PageView and the Inspector only emit commands, and this host runs them
 * (preset and merge as barriers) and toasts rejections.
 */
export function ChapterEditor({ manga, mode, chapterId, pageIds, title, backTo, aside }: ChapterEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const pageId = resolveCurrentPage(pageIds, search.get('p'));
  const detail = usePageDetail(pageId);
  const d = detail.data ?? null;

  const [selection, setSelection] = useState<Selection>(PAGE_SELECTION);
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [container, setContainer] = useState({ w: 800, h: 1000 });
  const [confirm, setConfirm] = useState<{ preset: string; removed: number } | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [lettering, setLettering] = useState(false);
  const [history] = useState(() => new History(200));
  const [ids] = useState(() => new IdMap());
  const cache = useMemo(() => queryCache(qc), [qc]);
  // Stable for the editor's lifetime: the Inspector and PageView build commands from it.
  // The ops read the page format at use time (panel rects decide where frames follow their panel), so the ops themselves stay stable.
  const formatRef = useRef(manga.pageFormat);
  useLayoutEffect(() => { formatRef.current = manga.pageFormat; });
  const ops = useMemo(() => createOps({ api, ids, cache, format: () => formatRef.current, onFrameError: (err) => pushToast('error', errorText(err)) }), [ids, cache]);
  const snap = useHistorySnapshot(history);

  const run = useCallback(async (cmd: EditorCommand): Promise<void> => {
    try { await history.run(cmd); } catch (err) { pushToast('error', errorText(err)); }
  }, [history]);
  const nudger = useFrameNudge(ops, cache, run);
  const flushNudge = nudger.flush;
  const widthPx = Math.max(120, Math.round(fitWidth(container, manga.pageFormat) * zoomFactor(zoom)));
  const size = pageSizePx(manga.pageFormat, widthPx);
  const onResize = useCallback((next: { w: number; h: number }) => {
    setContainer((c) => (c.w === next.w && c.h === next.h ? c : next));
  }, []);

  useEffect(() => { flushNudge(); setSelection(PAGE_SELECTION); }, [pageId, flushNudge]);
  useEffect(() => { if (d) setSelection((s) => reconcileSelection(s, d)); }, [d]);

  const selectPage = (id: string | null): void => setSearch(id ? { p: id } : {}, { replace: true });
  // Read after an await: the page and the page list may have changed while a request ran.
  const latest = useRef({ pageId, pageIds, selectPage });
  useLayoutEffect(() => { latest.current = { pageId, pageIds, selectPage }; });
  // The page in the URL was deleted elsewhere (an episode re-run, another tab, or its socket event beat our own DELETE's
  // response): show its neighbour and fix `?p=` instead of silently falling back to the first page.
  const idsKey = pageIds.join(',');
  const shownIds = useRef(pageIds);
  useLayoutEffect(() => {
    const prev = shownIds.current;
    shownIds.current = latest.current.pageIds;
    const target = pageAfterRemoval(prev, latest.current.pageIds, search.get('p'));
    if (target !== undefined) latest.current.selectPage(target);
  }, [idsKey]); // runs when the list changes; everything else is read through `latest`
  /** One History spans the chapter: after an undo or redo, show the page the command changed. */
  const showCommandPage = (commandPageId: string | null): void => {
    const l = latest.current;
    const target = pageToShow(commandPageId, l.pageId, l.pageIds);
    if (target) l.selectPage(target);
  };
  const undo = (): void => {
    flushNudge();
    history.undo().then(
      (done) => { if (done) showCommandPage(history.snapshot().redoPageId); },
      (err: unknown) => pushToast('error', errorText(err)),
    );
  };
  const redo = (): void => {
    flushNudge();
    history.redo().then(
      (done) => { if (done) showCommandPage(history.snapshot().undoPageId); },
      (err: unknown) => pushToast('error', errorText(err)),
    );
  };
  /** Not undoable, and a barrier: commands that name the page are dropped with it (spec §9.3 keeps page ops out of the history). */
  const deletePage = async (id: string): Promise<void> => {
    try {
      await deletePageFlow(id, {
        flush: flushNudge,
        barrier: (fn) => history.barrier(fn),
        view: () => ({ currentId: latest.current.pageId, pageIds: latest.current.pageIds }),
        remove: (pid) => api.delete(`/api/pages/${seg(pid)}`),
        after: (pid, show) => {
          if (show !== undefined) latest.current.selectPage(show);
          if (chapterId) qc.setQueryData<Page[]>(qk.pages(chapterId), (prev) => prev?.filter((p) => p.id !== pid));
          qc.removeQueries({ queryKey: qk.page(pid), exact: true });
          if (chapterId) void qc.invalidateQueries({ queryKey: qk.pages(chapterId) });
        },
      });
    } catch (err) { pushToast('error', errorText(err)); }
  };
  /**
   * For the aside (the episode stepper): a change there that deletes pages must not leave undo naming them (F33). It
   * also drops the selection first (residual N2): an inspector left on a panel the change deletes would refetch that
   * panel's images (on any image event) while the delete is in flight, and get a 404.
   */
  const asideBarrier = useCallback<Barrier>((fn) => {
    flushNudge();
    setSelection(PAGE_SELECTION);
    return history.barrier(fn);
  }, [history, flushNudge]);
  const panelId = selectedPanelId(selection);
  const selectedFrame = d && selection.kind === 'frame' ? d.frames.find((f) => f.id === selection.frameId) : undefined;

  /** Not undoable: a barrier clears both stacks. A preset with fewer panels asks first (409 needs_confirm). */
  const applyPreset = async (name: string, confirmed: boolean): Promise<void> => {
    if (!pageId) return;
    flushNudge();
    setPresetBusy(true);
    try {
      const { framesError } = await history.barrier(() => ops.applyPreset(pageId, name, confirmed));
      setConfirm(null);
      setSelection(PAGE_SELECTION);
      // The layout changed; only moving the frames along failed.
      if (framesError) pushToast('error', errorText(framesError));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'needs_confirm' && !confirmed) setConfirm({ preset: name, removed: removedPanelCount(err.details) });
      else { setConfirm(null); pushToast('error', errorText(err)); }
    } finally {
      setPresetBusy(false);
    }
  };
  const split = (dir: SplitDir): void => { if (pageId && panelId) void run(ops.split(pageId, panelId, dir)); };
  /** Not undoable: the selected panel (A) keeps its id; the shift-clicked partner is merged into it. */
  const merge = async (): Promise<void> => {
    if (!pageId || selection.kind !== 'panel' || selection.mergeWith === null) return;
    const keep = selection.panelId;
    const other = selection.mergeWith;
    flushNudge();
    try {
      await history.barrier(() => ops.merge(pageId, keep, other));
      setSelection(panelSelection(keep));
    } catch (err) { pushToast('error', errorText(err)); }
  };
  /** Not undoable, and a barrier: the server letters every dialogue line of the page that has no frame yet. */
  const autoLetter = async (): Promise<void> => {
    if (!pageId || lettering) return;
    setLettering(true);
    try {
      await autoLetterFlow(pageId, {
        flush: flushNudge, barrier: (fn) => history.barrier(fn), run: (id) => ops.autoLetter(id),
        fail: (err) => pushToast('error', errorText(err)),
      });
    } finally { setLettering(false); }
  };
  const addFrame = async (kind: FrameKind): Promise<void> => {
    if (!pageId) return;
    const cmd = ops.addFrame(pageId, frameInsert(kind, selection));
    await run(cmd);
    if (cmd.createdId) setSelection(frameSelection(cmd.createdId));
  };
  // Generating with `{}` uses the panel's own recipe, seed and lock. Refusals are toasted by the mutation cache.
  const generate = useMutation({
    mutationFn: (id: string) => api.post<JobRef>(`/api/panels/${seg(id)}/generate`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.jobs() }); },
  });
  // W1 R1, chapter mode only: render every panel that has no image. Blocked while the episode owns those panels.
  const storyId = mode === 'chapter' ? chapterId ?? undefined : undefined;
  const missing = useMissingPanels(storyId);
  const episode = useEpisode(storyId);
  const renderMissing = useRenderMissing(storyId);

  useEditorKeys({
    onUndo: undo,
    onRedo: redo,
    onDelete: () => {
      if (!selectedFrame) return;
      flushNudge();
      setSelection(PAGE_SELECTION);
      void run(ops.deleteFrame(selectedFrame));
    },
    onEscape: () => setSelection(escapeSelection),
    onNudge: (dx, dy) => { if (selectedFrame && pageId) nudger.nudge(pageId, selectedFrame, dx, dy, size); },
  });

  return (
    <OpsContext.Provider value={ops}>
      <div className={cx('editor', mode === 'cover' && 'editor--cover')}>
        <EditorToolbar
          mode={mode} title={title} backTo={backTo} detail={d} selection={selection} history={snap}
          readingDirection={manga.readingDirection} format={manga.pageFormat} zoom={zoom} generating={generate.isPending} lettering={lettering}
          exportTarget={exportTarget(chapterId, pageId)}
          missingImages={storyId ? missing.data?.panelIds.length ?? null : null} renderingMissing={renderMissing.isPending}
          renderMissingBlocked={renderBlock(episode.data)} onRenderMissing={() => renderMissing.mutate()}
          onUndo={undo} onRedo={redo}
          onApplyPreset={(name) => void applyPreset(name, false)}
          onSplit={split}
          onMerge={() => void merge()}
          onAddFrame={(kind) => void addFrame(kind)}
          onAutoLetter={() => void autoLetter()}
          onGenerate={() => { if (panelId) generate.mutate(panelId); }}
          onZoom={setZoom}
        />
        <div className="editor__aside"><HistoryBarrierContext.Provider value={asideBarrier}>{aside}</HistoryBarrierContext.Provider></div>
        {mode === 'chapter' && chapterId && (
          <PageList chapterId={chapterId} manga={manga} pageIds={pageIds} currentId={pageId} onSelectPage={selectPage} onDelete={(id) => void deletePage(id)} />
        )}
        <Canvas detail={d} manga={manga} widthPx={widthPx} selection={selection} onSelect={setSelection}
          onChange={(c) => void run(c)} onResize={onResize} loading={pageId !== null && detail.isPending}
          error={pageId !== null ? detail.error : null} onRetry={() => void detail.refetch()} />
        {d ? (
          <Inspector manga={manga} detail={d} pageNumber={pageId ? pageIds.indexOf(pageId) + 1 : null}
            selection={selection} onSelect={setSelection} run={run} ops={ops} mode={mode} />
        ) : <aside className="inspector" aria-label="Inspector" />}
        <JobBar />
        <ConfirmPresetModal open={confirm !== null} preset={confirm?.preset ?? ''} removed={confirm?.removed ?? 0} busy={presetBusy}
          onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm) void applyPreset(confirm.preset, true); }} />
      </div>
    </OpsContext.Provider>
  );
}
