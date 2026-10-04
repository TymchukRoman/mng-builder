// packages/server/src/workflows/brief/analyze.ts
import type { z } from 'zod';
import {
  AuditAnswerSchema, ExtractAnswerSchema, briefSegments, mergeDirectives, uncoveredSegments,
  type AuditAnswer, type BriefSegment, type Directive, type ExtractAnswer, type Language,
} from '@manga/shared';
import type { JsonRequest, TextEngine } from '../../engines/types.js';
import { LANGUAGE_NAME, contextBlock } from '../episode/context.js';
import { loadSplitPrompt, renderTemplate } from '../episode/prompts.js';

/** What the two reading passes are given about the request. `chapters`: how many chapters the text is for (null: a single chapter). */
export interface BriefInput { language: Language; brief: string; notes?: string; chapters: number | null }

export interface ExtractContext { step: 'brief-extract'; language: Language; chapters: number | null; segments: BriefSegment[] }
export interface AuditContext {
  step: 'brief-audit'; language: Language; chapters: number | null; segments: BriefSegment[];
  directives: Array<Pick<Directive, 'id' | 'text' | 'kind' | 'sources'>>; unreadSegments: BriefSegment[];
}

/** A call a pass makes, without the signal and progress the caller adds. */
export type PassRequest<T> = Pick<JsonRequest<T>, 'name' | 'task' | 'system' | 'prompt' | 'schema'> & { progress: string };

function pass<T>(name: string, template: string, ctx: ExtractContext | AuditContext, schema: z.ZodType<T>, progress: string): PassRequest<T> {
  const t = loadSplitPrompt(template, 'brief');
  const vars = { context: contextBlock(ctx), languageName: LANGUAGE_NAME[ctx.language] };
  return { name, task: 'story', system: renderTemplate(t.system, vars), prompt: renderTemplate(t.user, vars), schema, progress };
}

/** Pass 1: every detail of the text as a directive. */
export function extractRequest(input: BriefInput): { request: PassRequest<ExtractAnswer>; segments: BriefSegment[] } {
  const segments = briefSegments(input.brief, input.notes);
  const ctx: ExtractContext = { step: 'brief-extract', language: input.language, chapters: input.chapters, segments };
  return { request: pass('brief.extract', 'extract', ctx, ExtractAnswerSchema, 'Reading your request…'), segments };
}

/** Pass 2: what the first pass missed, with the sentences nothing was taken from pointed out. */
export function auditRequest(input: BriefInput, segments: BriefSegment[], found: readonly Directive[]): PassRequest<AuditAnswer> {
  const ctx: AuditContext = {
    step: 'brief-audit', language: input.language, chapters: input.chapters, segments,
    directives: found.map(({ id, text, kind, sources }) => ({ id, text, kind, sources })), unreadSegments: uncoveredSegments(segments, found),
  };
  return pass('brief.audit', 'audit', ctx, AuditAnswerSchema, 'Checking nothing was missed…');
}

/** The ledger from the two answers: the first pass's directives, then the second pass's additions, numbered D1, D2, … */
export function ledgerFrom(first: ExtractAnswer, second: AuditAnswer, segmentCount: number): Directive[] {
  const base = mergeDirectives([], first.directives, segmentCount);
  return mergeDirectives(base, second.missing, segmentCount);
}

/** Runs both passes on `engine` and returns the ledger (the plan job and tests; the episode premise runs the same requests as step calls). */
export async function analyzeBrief(
  engine: Pick<TextEngine, 'completeJson'>, input: BriefInput, io: { signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<Directive[]> {
  const { request: first, segments } = extractRequest(input);
  const extracted = await engine.completeJson({ ...first, ...(io.signal ? { signal: io.signal } : {}), ...(io.onProgress ? { onProgress: io.onProgress } : {}) });
  io.onProgress?.(first.progress);
  const found = mergeDirectives([], extracted.directives, segments.length);
  const second = auditRequest(input, segments, found);
  io.onProgress?.(second.progress);
  const audited = await engine.completeJson({ ...second, ...(io.signal ? { signal: io.signal } : {}), ...(io.onProgress ? { onProgress: io.onProgress } : {}) });
  return ledgerFrom(extracted, audited, segments.length);
}
