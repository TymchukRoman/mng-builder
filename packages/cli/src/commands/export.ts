import { resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import type { ExportRenderResult, JobRef } from '@manga/shared';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';

export function exportTargetType(ref: string): 'page' | 'chapter' {
  return ref.startsWith('pg_') ? 'page' : 'chapter';
}

function parseFormat(value: string): 'pdf' | 'png' {
  if (value !== 'pdf' && value !== 'png') throw new InvalidArgumentError('expected pdf or png');
  return value;
}

export function registerExportCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program.command('export')
    .description('Export a page or a chapter to PNG or PDF (spec §10)')
    .argument('<target>', 'a page id (pg_…), or a chapter id or <manga>/<number>')
    .option('--format <format>', 'pdf or png', parseFormat, 'pdf')
    .option('--out <dir>', 'output folder (default: <library>/exports/<manga>/<chapter>)')
    .action(async (ref: string, opts: { format: 'pdf' | 'png'; out?: string }) => {
      const c = await ctx();
      const type = exportTargetType(ref);
      const id = type === 'page' ? (await c.resolve.page(ref)).page.id : (await c.resolve.chapter(ref)).id;
      // The server may run elsewhere (auto-started, other cwd): a relative --out means relative to THIS shell.
      const { jobId } = await c.api.post<JobRef>('/api/export', {
        target: { type, id }, format: opts.format, ...(opts.out ? { outDir: resolve(opts.out) } : {}),
      });
      if (!c.wait) {
        c.out({ jobId }, () => `export queued as ${jobId}; add --wait to wait for the files`);
        return;
      }
      const [job] = await c.waitJobs([jobId]);
      if (!job || job.status !== 'succeeded') {
        // M2 ruling F14: a job that did not succeed makes the command exit 1.
        if (c.json && job) c.out({ jobId, status: job.status, error: job.error }, () => '');
        throw new CliError(`export ${job?.status ?? 'failed'}: ${job?.error ?? 'unknown error'}`, 1);
      }
      const { files } = job.result as ExportRenderResult;
      c.out({ jobId, files }, () => files.join('\n'));
    });
}
