import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character, JobRef } from '@manga/shared';
import { api, seg } from '../api';
import { activeJobs, jobProgress, jobStatusLabel, jobTargetsCharacter } from '../jobs/jobView';
import { useCharacterImages, useJobs } from '../queries';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { Sparkles } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { REF_SLOTS, canGenerateSheet, imagesForSlot } from './characterModel';
import { RefSlot } from './RefSlot';

export function RefSlots({ character }: { character: Character }): JSX.Element {
  const images = useCharacterImages(character.id);
  const jobs = useJobs();
  const qc = useQueryClient();
  const state = canGenerateSheet(character);
  const sheetJob = activeJobs(jobs.data).find((j) => j.kind === 'character.refs' && jobTargetsCharacter(j, character.id));
  const sheet = useMutation({
    mutationFn: () => api.post<JobRef>(`/api/characters/${seg(character.id)}/sheet`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.jobs() }); },
  });
  const prog = sheetJob ? jobProgress(sheetJob) : null;
  return (
    <section className="drawer-section">
      <div className="section-head">
        <h3>References</h3>
        <IconButton icon={Sparkles} label={state.reason} disabled={!state.enabled} busy={sheet.isPending || sheetJob !== undefined} onClick={() => sheet.mutate()} />
      </div>
      {sheetJob && <StatusLoader label={jobStatusLabel(sheetJob)} value={prog?.value} max={prog?.max} />}
      <div className="slot-grid">
        {REF_SLOTS.map((slot) => <RefSlot key={slot} character={character} slot={slot} images={imagesForSlot(images.data, slot)} />)}
      </div>
    </section>
  );
}
