import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character, JobRefs } from '@manga/shared';
import { api, imageUrl } from '../api';
import { activeJobs, isPortraitJob, jobProgress, jobStatusLabel, jobTargetsCharacter } from '../jobs/jobView';
import { cx } from '../lib/cx';
import { useCharacterImages, useJobs } from '../queries';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { Sparkles } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { PORTRAIT_BATCH, imagesForSlot } from './characterModel';

export function PortraitVariants({ character }: { character: Character }): JSX.Element {
  const images = useCharacterImages(character.id);
  const jobs = useJobs();
  const qc = useQueryClient();
  const portraits = imagesForSlot(images.data, 'portrait');
  const pending = activeJobs(jobs.data).filter((j) => jobTargetsCharacter(j, character.id) && isPortraitJob(j));
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: qk.character(character.id) });
    void qc.invalidateQueries({ queryKey: qk.characterImages(character.id) });
    void qc.invalidateQueries({ queryKey: qk.characters(character.mangaId) });
  };
  const generate = useMutation({
    mutationFn: () => api.post<JobRefs>(`/api/characters/${character.id}/portraits`, { n: PORTRAIT_BATCH }),
    // Show the queued tiles now instead of waiting for the first job event.
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.jobs() }); },
  });
  const pick = useMutation({ mutationFn: (imageId: string) => api.post<Character>(`/api/characters/${character.id}/refs/portrait`, { imageId }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (imageId: string) => api.delete(`/api/images/${imageId}`), onSuccess: refresh });

  return (
    <section className="drawer-section">
      <div className="section-head">
        <h3>Portraits</h3>
        <IconButton icon={Sparkles} label={`Generate ${PORTRAIT_BATCH} portraits`} busy={generate.isPending} onClick={() => generate.mutate()} />
      </div>
      <div className="variant-grid">
        {pending.map((j) => {
          const prog = jobProgress(j);
          return <div key={j.id} className="variant variant--pending"><StatusLoader label={jobStatusLabel(j)} value={prog?.value} max={prog?.max} /></div>;
        })}
        {portraits.map((img) => {
          const picked = character.refs.portrait === img.id;
          return (
            <div key={img.id} className={cx('variant', picked && 'is-picked')}>
              <button type="button" className="variant__pick" aria-pressed={picked} aria-label="Use as portrait" data-tip="Use as portrait" onClick={() => pick.mutate(img.id)}>
                <img src={imageUrl(img.id)} alt="" />
              </button>
              <ConfirmIconButton size="sm" className="variant__delete" label="Delete image" confirmLabel="Click again to delete" onConfirm={() => remove.mutate(img.id)} />
            </div>
          );
        })}
        {portraits.length === 0 && pending.length === 0 && <p className="muted">No portraits yet</p>}
      </div>
    </section>
  );
}
