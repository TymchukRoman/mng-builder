import { useRef, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character, JobRef } from '@manga/shared';
import { api } from '../api';
import { waitForJob } from '../events';
import { jobStatusLabel } from '../jobs/jobView';
import { useJobs } from '../queries';
import { qk } from '../queryKeys';
import { AutoText } from '../ui/AutoText';
import { IconButton } from '../ui/IconButton';
import { Sparkles, WandSparkles } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { StatusLoader } from '../ui/StatusLoader';

export function AppearanceField({ character, onSave }: { character: Character; onSave(v: string): Promise<void> | void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const jobs = useJobs();
  const qc = useQueryClient();
  const job = jobId ? jobs.data?.find((j) => j.id === jobId) : undefined;

  const suggest = useMutation({
    mutationFn: async (text: string) => {
      const { jobId: id } = await api.post<JobRef>(`/api/characters/${character.id}/suggest-appearance`, { description: text });
      setJobId(id);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: qk.jobs() });
      // The job writes character.appearanceTags itself; a failure is toasted by the socket handler.
      return waitForJob(id);
    },
    onSuccess: () => setDescription(''),
    onSettled: () => {
      setJobId(null);
      void qc.invalidateQueries({ queryKey: qk.character(character.id) });
    },
  });

  return (
    <div className="field">
      <div className="row">
        <span className="field__label">Appearance tags</span>
        <span className="spacer" />
        <IconButton ref={anchor} icon={WandSparkles} size="sm" label="Suggest tags from a description (AI)" busy={suggest.isPending} onClick={() => setOpen((o) => !o)} />
      </div>
      <AutoText multiline label="Appearance tags" value={character.appearanceTags} onSave={onSave} placeholder="1girl, silver hair, twintails, amber eyes" />
      {suggest.isPending && <StatusLoader label={job ? jobStatusLabel(job) : 'Asking the AI'} />}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" label="Describe the look" className="suggest-popover">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); const d = description.trim(); if (d) suggest.mutate(d); }}>
          <textarea className="textarea" aria-label="Describe the look" rows={3} maxLength={4000} autoFocus value={description}
            placeholder="A tall girl with silver twin-tails and a red scarf" onChange={(e) => setDescription(e.target.value)} />
          <div className="form-actions">
            <IconButton type="submit" icon={Sparkles} tone="primary" label="Suggest tags" disabled={!description.trim()} />
          </div>
        </form>
      </Popover>
    </div>
  );
}
