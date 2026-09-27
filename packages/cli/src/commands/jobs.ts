import type { Command } from 'commander';
import { JobStatusSchema, type Job } from '@manga/shared';
import { parsePositiveInt } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';
import { progressText, streamJobs } from '../wait.js';

const HEADER = ['id', 'kind', 'lane', 'status', 'progress'];

export const jobRow = (job: Job): string[] => [job.id, job.kind, job.lane, job.status, progressText(job)];
export const jobLine = (job: Job): string => jobRow(job).filter((cell) => cell !== '').join('  ');

export function registerJobCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program
    .command('jobs')
    .description('list recent jobs; --watch keeps streaming updates until Ctrl+C')
    .option('--watch', 'stream job updates')
    .option('--status <status>', 'queued, running, succeeded, failed or cancelled')
    .option('--limit <n>', 'how many jobs to list', parsePositiveInt, 20)
    .action(async (opts: { watch?: boolean; status?: string; limit: number }) => {
      if (opts.status !== undefined && !JobStatusSchema.safeParse(opts.status).success) {
        throw new CliError(`status must be one of ${JobStatusSchema.options.join(', ')}, got "${opts.status}"`, 2);
      }
      const c = await ctx();
      const query = new URLSearchParams({ limit: String(opts.limit) });
      if (opts.status !== undefined) query.set('status', opts.status);
      const list = (): Promise<Job[]> => c.api.get<Job[]>(`/api/jobs?${query.toString()}`);
      const render = (jobs: Job[]): string => (jobs.length === 0 ? 'no jobs' : table(jobs.map(jobRow), HEADER));
      if (opts.watch !== true) {
        const jobs = await list();
        c.out(jobs, () => render(jobs));
        return;
      }
      await streamJobs({
        baseUrl: c.baseUrl,
        io: c.io,
        onReady: async () => {
          const jobs = await list();
          c.out(jobs, () => render(jobs));
        },
        onJob: (job) => c.io.stdout(`${c.json ? JSON.stringify(job) : jobLine(job)}\n`),
      });
    });

  program
    .command('cancel')
    .description('cancel a queued or running job')
    .argument('<job>', 'job id')
    .action(async (jobId: string) => {
      const c = await ctx();
      const job = await c.api.post<Job>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`);
      c.out(job, () => `${job.id}  ${job.status}`);
    });
}
