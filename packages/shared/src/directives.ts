import { z } from 'zod';

/**
 * The details of a brief, one by one (the "ledger"). A brief is read in several passes (extract, audit) into atomic
 * directives, each tied to the sentences of the user's text it came from; every later step is handed the directives that
 * concern it, and the plan, the scripts and the prompts are checked against them. Nothing the user wrote is left to the
 * model's memory of a long text.
 *
 * Kinds: `plot` (what happens), `character` (who someone is or looks like), `setting` (where and when), `tone` (mood, genre),
 * `dialogue` (how people talk, language, dialect), `visual` (how it is drawn), `structure` (chapters, pages, panels, pacing,
 * endings), `avoid` (what must not appear), `format` (anything about the book itself), `other`.
 */
export const DIRECTIVE_KINDS = ['plot', 'character', 'setting', 'tone', 'dialogue', 'visual', 'structure', 'avoid', 'format', 'other'] as const;
export const DirectiveKindSchema = z.enum(DIRECTIVE_KINDS);
export type DirectiveKind = z.infer<typeof DirectiveKindSchema>;

/** What the model writes (no id: the code numbers them, so ids never collide across passes). */
export const DirectiveDraftSchema = z.object({
  /** One self-contained requirement, in the language of the brief, naming who or what it is about. */
  text: z.string().trim().min(1),
  kind: DirectiveKindSchema,
  /** Chapters it applies to (1-based); empty: the whole series, or the only chapter. */
  chapters: z.array(z.number().int().min(1)).default([]),
  /** false: a wish ("preferably"), true: a requirement. */
  must: z.boolean().default(true),
  /** The user's own words it comes from. */
  quote: z.string().default(''),
  /** The numbers of the brief's sentences it comes from (see `briefSegments`). */
  sources: z.array(z.number().int().min(1)).default([]),
  /** `visual` only: English Danbooru-style tags for the look, e.g. "simple background, minimal shading". */
  tags: z.string().default(''),
});
export type DirectiveDraft = z.infer<typeof DirectiveDraftSchema>;

export const DirectiveStatusSchema = z.enum(['applied', 'partial', 'unmet']);
export type DirectiveStatus = z.infer<typeof DirectiveStatusSchema>;
export const DirectiveSchema = DirectiveDraftSchema.extend({
  id: z.string().min(1),
  /** What the last check found: set by the plan audit. */
  status: DirectiveStatusSchema.optional(),
  note: z.string().optional(),
});
export type Directive = z.infer<typeof DirectiveSchema>;

export const ExtractAnswerSchema = z.object({ directives: z.array(DirectiveDraftSchema).min(1) });
export type ExtractAnswer = z.infer<typeof ExtractAnswerSchema>;
export const AuditAnswerSchema = z.object({ missing: z.array(DirectiveDraftSchema) });
export type AuditAnswer = z.infer<typeof AuditAnswerSchema>;
/** A check of work against the ledger: the directives it does not satisfy, and what is wrong. */
export const CheckAnswerSchema = z.object({
  unmet: z.array(z.object({ id: z.string().min(1), problem: z.string().min(1), page: z.number().int().min(1).optional() })),
});
export type CheckAnswer = z.infer<typeof CheckAnswerSchema>;

// ---- reading the brief ----

export interface BriefSegment { n: number; text: string }

/**
 * The brief as numbered sentences (and lines), so a directive can say where it comes from and the code can tell which parts of
 * the text no directive touches. `parts` are texts in order (the brief, then extra notes); numbering continues across them.
 */
export function briefSegments(...parts: ReadonlyArray<string | undefined>): BriefSegment[] {
  const out: BriefSegment[] = [];
  for (const part of parts) {
    for (const line of (part ?? '').split(/\r?\n/)) {
      // A sentence ends at . ! ? … (and the closing quote after it) followed by a space; a line break always ends one.
      const pieces = line.split(/(?<=[.!?…]["'»”)]?)\s+/u).map((s) => s.trim()).filter((s) => s !== '');
      for (const text of pieces) out.push({ n: out.length + 1, text });
    }
  }
  return out;
}

/** Segments no directive names as a source: the audit pass is pointed at them first. */
export function uncoveredSegments(segments: readonly BriefSegment[], directives: ReadonlyArray<Pick<DirectiveDraft, 'sources'>>): BriefSegment[] {
  const seen = new Set(directives.flatMap((d) => d.sources));
  return segments.filter((s) => !seen.has(s.n));
}

const normText = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Numbers drafts D1, D2, … after `existing` (kept as they are) and drops a draft whose text repeats one already there. Sources
 * outside `segmentCount` are dropped (a model may invent a number), and a chapter list is sorted and de-duplicated.
 */
export function mergeDirectives(existing: readonly Directive[], drafts: readonly DirectiveDraft[], segmentCount = Number.POSITIVE_INFINITY): Directive[] {
  const out = [...existing];
  const seen = new Set(out.map((d) => normText(d.text)));
  let next = out.reduce((max, d) => Math.max(max, Number(/^D(\d+)$/.exec(d.id)?.[1] ?? 0)), 0) + 1;
  for (const d of drafts) {
    const key = normText(d.text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...d, id: `D${next++}`,
      chapters: [...new Set(d.chapters)].sort((a, b) => a - b),
      sources: [...new Set(d.sources)].filter((n) => n <= segmentCount).sort((a, b) => a - b),
    });
  }
  return out;
}

// ---- which step reads which directives ----

/** The steps (and checks) that read directives, and the kinds each one is handed. */
export type DirectiveReader = 'premise' | 'outline' | 'breakdown' | 'scripts' | 'prompts' | 'plan';
const ALL_KINDS: readonly DirectiveKind[] = DIRECTIVE_KINDS;
export const DIRECTIVE_READERS: Readonly<Record<DirectiveReader, readonly DirectiveKind[]>> = {
  premise: ALL_KINDS,
  plan: ALL_KINDS,
  outline: ['plot', 'character', 'setting', 'tone', 'structure', 'avoid', 'format', 'other'],
  breakdown: ['structure', 'format', 'tone', 'avoid', 'other'],
  scripts: ['plot', 'character', 'setting', 'tone', 'dialogue', 'structure', 'avoid', 'format', 'other'],
  prompts: ['visual', 'setting', 'avoid', 'tone', 'other'],
};

/** The directives of a chapter: those for the whole series and those that name this chapter. */
export function directivesOfChapter(directives: readonly Directive[], chapter: number | null): Directive[] {
  return directives.filter((d) => d.chapters.length === 0 || chapter === null || d.chapters.includes(chapter));
}

/** What one step is handed: its chapter's directives of the kinds it reads. */
export function directivesFor(reader: DirectiveReader, directives: readonly Directive[], chapter: number | null): Directive[] {
  const kinds = DIRECTIVE_READERS[reader];
  return directivesOfChapter(directives, chapter).filter((d) => kinds.includes(d.kind));
}

/** Kinds that become `notes` (what is neither story nor look). */
const NOTE_KINDS: readonly DirectiveKind[] = ['tone', 'dialogue', 'structure', 'avoid', 'format', 'other'];

/** The non-visual wishes as one text, for the stepper and the older `notes` field. */
export function deriveNotes(directives: readonly Directive[]): string {
  return directives.filter((d) => NOTE_KINDS.includes(d.kind)).map((d) => d.text.trim().replace(/[.!]?$/, '.')).join(' ');
}

/**
 * The look as English tags, de-duplicated. `skipSeries`: leave out tags of directives for the whole series (the manga's style
 * prompt already carries them, as the auto-created manga's plan put them there).
 */
export function deriveArtTags(directives: readonly Directive[], opts: { skipSeries?: boolean } = {}): string {
  const tags: string[] = [];
  for (const d of directives) {
    if (d.kind !== 'visual' || (opts.skipSeries === true && d.chapters.length === 0)) continue;
    for (const t of d.tags.split(',').map((x) => x.trim()).filter((x) => x !== '')) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  }
  return tags.join(', ');
}

/** "D3 [must, plot] text", one per line, for a prompt that quotes the directives to a checker. */
export function directiveLines(directives: readonly Directive[]): string {
  return directives.map((d) => `${d.id} [${d.must ? 'must' : 'wish'}, ${d.kind}] ${d.text}`).join('\n');
}
