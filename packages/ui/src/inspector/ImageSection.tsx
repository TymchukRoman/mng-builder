import { useRef, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColorMode, Image, JobRef, PageDetail, Panel } from '@manga/shared';
import { api, seg } from '../api';
import type { EditorCommand } from '../editor/commands';
import type { Ops } from '../editor/ops';
import { panelSelection, type Selection } from '../editor/selection';
import { jobProgress, jobStatusLabel } from '../jobs/jobView';
import { panelImageFilter } from '../page/pageModel';
import { useJobs, usePanelImages } from '../queries';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { ImageUp, Move, ScanEye, Sparkles } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { panelJobs } from './inspectorModel';
import { ReviewBadge } from './ReviewBadge';
import { VariantStrip } from './VariantStrip';

export function ImageSection({ detail, panel, colorMode, selection, onSelect, run, ops }: {
  detail: PageDetail; panel: Panel; colorMode: ColorMode; selection: Selection; onSelect(s: Selection): void; run(cmd: EditorCommand): Promise<void>; ops: Ops;
}): JSX.Element {
  const images = usePanelImages(panel.id);
  const jobs = useJobs();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const pageId = detail.page.id;
  const pending = panelJobs(jobs.data, panel.id).image;
  const active = panel.activeImageId ? (images.data?.find((i) => i.id === panel.activeImageId) ?? detail.images[panel.activeImageId] ?? null) : null;
  const adjusting = selection.kind === 'panel' && selection.adjust;
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: qk.page(pageId) });
    void qc.invalidateQueries({ queryKey: qk.panelImages(panel.id) });
  };
  // Show the queued job now instead of waiting for its first event.
  const showJob = (): void => { void qc.invalidateQueries({ queryKey: qk.jobs() }); };

  // Refused calls are toasted by the query client's mutation cache. Generating with `{}` uses the panel's own recipe, seed and lock.
  const generate = useMutation({ mutationFn: () => api.post<JobRef>(`/api/panels/${seg(panel.id)}/generate`, {}), onSuccess: showJob });
  const review = useMutation({ mutationFn: () => api.post<JobRef>(`/api/panels/${seg(panel.id)}/review`), onSuccess: showJob });
  const upload = useMutation({ mutationFn: (f: File) => api.upload<Image>(`/api/panels/${seg(panel.id)}/upload`, f, f.name), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (imageId: string) => api.delete(`/api/images/${seg(imageId)}`), onSuccess: refresh });

  return (
    <section className="insp-section">
      <div className="section-head">
        <h3>Image</h3>
        <div className="row">
          {active?.review && <ReviewBadge review={active.review} />}
          <IconButton icon={Sparkles} label="Generate a new variant" busy={generate.isPending} onClick={() => generate.mutate()} />
          <IconButton icon={ScanEye} label={active ? 'Review image (AI)' : 'Review image: no active image'} disabled={!active} busy={review.isPending} onClick={() => review.mutate()} />
          <IconButton icon={ImageUp} label="Upload image" busy={upload.isPending} onClick={() => fileRef.current?.click()} />
          <IconButton icon={Move} label="Adjust image (or double-click the panel)" active={adjusting} disabled={!active}
            onClick={() => onSelect(panelSelection(panel.id, { adjust: !adjusting }))} />
        </div>
      </div>
      {pending.map((j) => {
        const prog = jobProgress(j);
        return <StatusLoader key={j.id} label={jobStatusLabel(j)} value={prog?.value} max={prog?.max} />;
      })}
      {images.error && <ErrorState error={images.error} onRetry={() => void images.refetch()} retrying={images.isFetching} />}
      <VariantStrip images={images.data ?? []} activeId={panel.activeImageId} filter={panelImageFilter(colorMode)}
        onActivate={(id) => void run(ops.activeImage(pageId, panel.id, panel.activeImageId, id))}
        onDelete={(id) => remove.mutate(id)} />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
    </section>
  );
}
