import type { ExportRenderResult, Job } from '@manga/shared';

export type ExportScope = 'page' | 'chapter';
export type ExportFormat = 'pdf' | 'png';
export interface ExportChoice { scope: ExportScope; format: ExportFormat }
export type ExportTarget = { type: 'page' | 'chapter'; id: string } | null;

export function defaultScope(target: ExportTarget): ExportScope {
  return target?.type === 'chapter' ? 'chapter' : 'page';
}

/** Body of POST /api/export, or null when the chosen scope has nothing to export. */
export function exportRequest(
  choice: ExportChoice, target: ExportTarget, pageId: string | null,
): { target: { type: ExportScope; id: string }; format: ExportFormat } | null {
  if (choice.scope === 'chapter') return target?.type === 'chapter' ? { target, format: choice.format } : null;
  const id = pageId ?? (target?.type === 'page' ? target.id : null);
  return id ? { target: { type: 'page', id }, format: choice.format } : null;
}

export function exportFiles(job: Job | undefined | null): string[] {
  if (!job || job.status !== 'succeeded') return [];
  return (job.result as ExportRenderResult | null)?.files ?? [];
}

/** Why a finished export wrote nothing (null when it succeeded or nothing has finished). */
export function exportProblem(job: Job | undefined | null): string | null {
  if (job?.status === 'failed') return job.error || 'Export failed';
  if (job?.status === 'cancelled') return 'Export cancelled';
  return null;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
