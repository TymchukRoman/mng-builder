import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRef, Panel } from '@manga/shared';
import { api, seg } from '../api';
import { waitForJob } from '../events';
import { jobStatusLabel } from '../jobs/jobView';
import { useJobs } from '../queries';
import { qk } from '../queryKeys';
import type { UpdatePanelBody } from '../types';
import { AutoText } from '../ui/AutoText';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { WandSparkles } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { panelJobs } from './inspectorModel';

export function PromptSection({ pageId, panel, patch }: { pageId: string; panel: Panel; patch(body: UpdatePanelBody): Promise<void> }): JSX.Element {
  const qc = useQueryClient();
  const jobs = useJobs();
  const write = useMutation({
    mutationFn: async () => {
      const { jobId } = await api.post<JobRef>(`/api/panels/${seg(panel.id)}/prompt`);
      void qc.invalidateQueries({ queryKey: qk.jobs() });
      // The job writes panel.prompt.scene itself (its result is `{scene}`); a failure is toasted by the socket handler.
      return waitForJob(jobId);
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: qk.page(pageId) }); },
  });
  const job = panelJobs(jobs.data, panel.id).prompt;
  // A pending job also counts, so the loader survives closing and reopening the inspector.
  const busy = write.isPending || job !== undefined;
  return (
    <section className="insp-section">
      <div className="section-head">
        <h3>Prompt</h3>
        <IconButton icon={WandSparkles} label="Write the prompt with AI" busy={busy} onClick={() => write.mutate()} />
      </div>
      {busy && <StatusLoader label={job ? jobStatusLabel(job) : 'Writing prompt'} />}
      <Field label="Scene">
        <AutoText multiline rows={4} label="Scene prompt" value={panel.prompt.scene} onSave={(scene) => patch({ prompt: { scene, negative: panel.prompt.negative } })} />
      </Field>
      <Field label="Negative">
        <AutoText multiline rows={2} label="Negative prompt" value={panel.prompt.negative} onSave={(negative) => patch({ prompt: { scene: panel.prompt.scene, negative } })} />
      </Field>
    </section>
  );
}
