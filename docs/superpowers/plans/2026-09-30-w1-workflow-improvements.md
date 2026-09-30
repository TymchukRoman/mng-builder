# W1 Episode Workflow Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long automated episode runs finish reliably and cheaply on a shared home PC: failed panels no longer stop a render, the image queue pauses itself while a game holds the GPU, cut-off Claude answers are repaired, the story keeps its memory, page 1 is previewed first, a render can be paused and resumed, and a big chapter asks before it renders.

**Architecture:** Every change stays inside the M4 shapes. The episode run row stays the state machine: new `paused` statuses, and a render step can stop at `awaiting-review` with a *gate* output (preview or confirm). Continue re-dispatches the same step with its token, so rendered panels are skipped. The job queue learns one new error (`GpuBusyError`): it pauses the lane and puts the job back, and a small `GpuMonitor` polls ComfyUI to lift the pause. JSON repair sits in `engines/structured.ts`, so every engine and step gets it. Story memory is more context JSON in the stdin part of the prompts, plus one small summary job when a run finishes.

**Tech Stack:** TypeScript 5.9.3 (ESM, strict, `exactOptionalPropertyTypes`), zod 4, Fastify 5, better-sqlite3, React 19 + TanStack Query 5, commander 14, vitest 3.2.7, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-09-30-workflow-improvements-design.md`

## Global Constraints

- Contracts: `docs/superpowers/plans/2026-09-27-00-contracts.md` stays binding. Every changed row emits its entity event exactly once (G5). Claude system prompts stay small, and large context goes in stdin, the `<context>` block of the user part (G2). An LLM call runs on the engine of its job's lane (`engines.forLane(ctx.job.lane)`); the lane is chosen at enqueue time with `engines.laneFor(task)`.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- UI (M3 rulings + Roman's style rules):
  - icon buttons (`IconButton`) with `aria-label` and a matching `data-tip` (the component sets both from `label`), and no visible text beyond what the spec names;
  - token-only CSS, never `--text-3` on readable text;
  - dark and light themes both work;
  - ids in request paths go through `seg()`, and route params through `isId()`;
  - errors render with `ErrorState`, and cached PATCHes use `useOptimisticPatch`;
  - the first field of a dialog has `data-autofocus`.
- UI copy: only the spec's own strings and short tooltips.
- Tests: vitest with fakes: `MANGA_FAKES`, the fake ComfyUI (`test/fakes/fake-comfy.ts` → `src/dev/fake-comfy.ts`), `ScriptedEngine`, `FakeQueue` (`test/helpers/fake-queue.ts`), `startM4TestServer`. E2E is hermetic on port 4399 (`npm run e2e`).
- Named constants, with these values verbatim from the spec:
  - `GPU_RESUME_FREE_BYTES = 8e9` (8 GB);
  - `GPU_PAUSE_FREE_BYTES = 3e9` (3 GB);
  - the monitor polls every 30 s (`GPU_MONITOR_INTERVAL_MS = 30_000`);
  - the stop reason is `'GPU busy: another app is using GPU memory'`;
  - `TYPICAL_PANELS_PER_PAGE = 4.5`;
  - `settings.episode.confirmRenderMinutes` defaults to `45`;
  - `storySoFar` is capped at ~3,000 characters (`STORY_SO_FAR_LIMIT = 3000`), `previousPage` at 800 characters, and `previousChapters` at the last 10.
- Migrations are append-only: add version 2, never edit version 1.
- Run `npm run typecheck` and `npm test` before every commit. Run `npm run e2e` in Task 10 only (Task 4 changes the API default, and Task 10 updates the E2E spec it breaks).

## Review Focus

1. **A pause racing the step's own end.** The render driver may finish while `pause()` runs. Expected: the run stays `paused`, the late result is discarded (`handleStepJob` checks `status === 'running'`), and Resume re-renders nothing and then completes. Pinned in Task 5 ("a result that arrives after the pause is discarded").
2. **Re-render failed panels while the episode is rendering.** Expected: queueing duplicates of the driver's own jobs is refused with 409 while the render step is `running` or `paused`. At the preview stop it is allowed, and Continue then adopts those jobs instead of queueing new ones. Pinned in Task 5.
3. **A manual pause during a GPU-busy pause, or a GPU-busy failure during a manual pause.** Expected: a manual pause is never overwritten by the busy reason and never lifted by the monitor. Pinned in Task 3.
4. **Preview on a chapter whose only story page is page 1.** Expected: nothing is left to preview, so the step does not stop at "continue with 0 panels" and finishes normally. Pinned in Task 4.
5. **A Claude answer cut off inside a key or a string, not only before the last `}`.** Expected: the repair cuts the dangling entry back until the rest parses, or it gives up and the correction round says the answer was cut off. It never crashes and never invents a value. Pinned in Task 1.

## Decisions where the spec was open

- **The `previewFirst` default.** `StartEpisodeSchema` defaults it to `true` for every API, UI and CLI start. A stored input without the key means off, so runs from before W1, and runner tests that call `start()` directly, never stop.
- **The preview in a 1-page chapter.** With nothing left after the cover and page 1, there is no preview stop.
- **R1 "every panel failed".** The rule is judged per render phase: all panels of the preview phase, or of this dispatch. `failedPanelIds` lists the panels without an image among those attempted.
- **Continue after a stop.** It keeps the stop output on the step and re-dispatches with the same token, and the driver sees that output and does not stop again. A render step re-run gets a new token, so page 1 renders again and the preview is asked for again.
- **"ComfyUI restarts and becomes reachable".** The monitor saw ComfyUI unreachable during this busy pause, and now it answers.
- **Pause and resume reasons, and the manual pause.** They are the shared constants `GPU_BUSY_REASON` and `GPU_MANUAL_PAUSE_REASON`. The monitor lifts only the busy reason. A `GpuBusyError` never overwrites a pause that is already there.
- **The pre-submit check.** It throws `GpuBusyError` instead of warning, so the old "GPU memory low" label goes away.
- **The status event.** No `status` event was emitted before this change. The queue now notifies lane listeners, and `api/system.ts` emits the full `ServiceStatus`.
- **Where GPU pauses are shown.** The top bar chip shows GPU pauses. The quota banner keeps the other lanes.
- **Pause scope.** Pause is allowed only while the render step is `running`. At a review or preview stop, Cancel or Continue apply instead.
- **Render-missing.** It is refused (409) only while the render step is running or paused. Its duplicate check covers every unfinished generate job. A `GET` of the same path is added, so the UI can show the count.
- **The toolbar label.** The editor toolbar says "Render panels without an image (N)", which also fits a hand-made chapter. The episode panel keeps the spec's "Re-render failed panels (N)".
- **The chapter summary.** It is written by a separate `llm.step {type:'chapter-summary'}` job on the story lane, queued when the run becomes `done`. That job never fails the run. There is no chapter-settings screen, so the summary is edited from a chapter-row icon and with `manga chapter edit --summary`.
- **`storySoFar` source and scope.** It is built from the earlier chunks' parsed answers, using character names. It covers the scripts step only, and `previousPage` covers the prompts step.
- **The per-panel seconds of the chapter estimate.** They are the mean of the three routed recipes (`noChars`, `oneChar`, `multiChar`). The cover panel is not counted.
- **The breakdown cap.** It stays enforced by the presets (the maximum is 6). Only the prompt text changes; the schema's `max(9)` stays.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/server/src/engines/structured.ts` | 1 | `repairJson`, `CUT_OFF_PROBLEM`, repair inside `parseAgainst` |
| `packages/shared/src/schemas.ts` | 2 | `paused` statuses, `previewFirst`, `Chapter.summary`, `settings.episode` |
| `packages/shared/src/api.ts` | 2 | `StartEpisodeSchema` default, `UpdateChapterSchema.summary`, `QueueLanes`, `MissingPanels` |
| `packages/shared/src/jobs.ts` | 2 | `chapter-summary` payload, GPU pause reasons |
| `packages/shared/src/episode.ts` | 2, 4 | chapter estimate (2); `RenderOutputSchema` gate fields, `renderGate` (4) |
| `packages/server/src/store/{migrations,entities,types,settings}.ts` | 2 | migration 2 (`chapters.summary`), repo column, settings merge |
| `packages/server/src/jobs/{errors,queue}.ts` | 3 | `GpuBusyError`, lane listeners, `pauseOf`, busy requeue |
| `packages/server/src/imaging/comfy.ts` | 3 | pre-submit busy check, watchdog `GpuBusyError`, `availableVram` |
| `packages/server/src/imaging/gpu-monitor.ts` (new) | 3 | polls ComfyUI while the lane is paused as busy |
| `packages/server/src/modules/imaging.ts` | 3 | wires the monitor |
| `packages/server/src/api/{system,jobs}.ts` | 3 | `status` event on lane changes; `/api/queue/gpu/pause|resume` |
| `packages/server/src/workflows/episode/render.ts` | 4 | failed panels, preview stop, confirm stop |
| `packages/server/src/workflows/episode/runner.ts` | 4, 5, 6 | gate handling (4); pause/resume (5); summary job (6) |
| `packages/server/src/workflows/episode/missing.ts` (new) | 5 | `missingPanelIds`, `renderMissing` |
| `packages/server/src/workflows/episode/{routes,module}.ts` | 5, 6 | new routes; summary handler registration |
| `packages/server/src/workflows/episode/{context,requests,llm,prompts}.ts` | 6 | `storySoFar`, `previousPage`, `previousChapters` |
| `packages/server/src/workflows/episode/summary.ts` (new) | 6 | `writeChapterSummary` |
| `packages/server/src/prompts/episode/{premise,outline,breakdown,scripts,prompts,summary}.md` | 6 | prompt rules; the summary prompt is new |
| `packages/server/src/dev/fake-episode.ts` | 6 | `episode.summary` fake |
| `packages/cli/src/commands/{episode,chapters,queue}.ts`, `program.ts` | 7 | new flags and commands |
| `packages/ui/src/episode/episodeView.ts`, `chapter/EpisodePanel.tsx`, `chapter/aiSection.ts`, `chapter/CreateChapterAiSection.tsx`, `editor/{EditorToolbar,ChapterEditor}.tsx`, `queries.ts`, `queryKeys.ts` | 8 | episode UI |
| `packages/ui/src/shell/{engineState.ts,GpuQueueControl.tsx,JobsIndicator.tsx,TopBar.tsx}`, `manga/{ChapterRow.tsx,ChapterSummaryButton.tsx,mangaModel.ts}`, `settings/ReviewSettings.tsx` | 9 | queue controls, summary editor, settings field |
| `e2e/episode-preview.spec.ts` (new), `e2e/episode-export.spec.ts` | 10 | preview E2E; the old spec turns the preview off |

---

### Task 1: R3 — repair cut-off or malformed JSON answers

**Files:**
- Modify: `packages/server/src/engines/structured.ts`
- Test: `packages/server/test/structured.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function repairJson(text: string): string | null`: the repaired JSON object text, or null. The result is always parseable.
  - `export const CUT_OFF_PROBLEM: string`: the `problems` text of an answer that had an unfinished object that could not be repaired.
  - `parseAgainst<T>(raw, schema)`: same signature as today. It repairs before it gives up, and the repaired value still goes through `schema`.
  - `extractJson` keeps its contract: the first balanced object, or null.

- [ ] **Step 1: Write the failing tests** (append to `packages/server/test/structured.test.ts`; add `repairJson` and `CUT_OFF_PROBLEM` to the existing import from `../src/engines/structured.js`, and add `z` from `zod` if it is not imported)

```ts
describe('repairJson (R3)', () => {
  // Roman's two prompts-step answers (~1.4 KB) ended in `}]` with the final `}` missing.
  const cutOff = '{"panels":[{"panelId":"pn_aaaaaaaaaa","scene":"1girl, rain, harbour street"},{"panelId":"pn_bbbbbbbbbb","scene":"cat, box, rain"}]';

  it('appends the missing closing brace of a real cut-off answer', () => {
    expect(JSON.parse(repairJson(cutOff)!)).toEqual({
      panels: [{ panelId: 'pn_aaaaaaaaaa', scene: '1girl, rain, harbour street' }, { panelId: 'pn_bbbbbbbbbb', scene: 'cat, box, rain' }],
    });
  });

  it('strips fences and prose before the first brace', () => {
    expect(repairJson('Sure!\n```json\n{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  it('removes trailing commas before a closer', () => {
    expect(repairJson('{"a":[1,2,],"b":{"c":1,},}')).toBe('{"a":[1,2],"b":{"c":1}}');
  });

  it('closes a string left open at the end, dropping a dangling escape', () => {
    expect(JSON.parse(repairJson('{"scene":"a rainy stre')!)).toEqual({ scene: 'a rainy stre' });
    expect(JSON.parse(repairJson('{"scene":"say \\')!)).toEqual({ scene: 'say ' });
  });

  it('ignores brackets inside strings when it counts what to close', () => {
    expect(JSON.parse(repairJson('{"scene":"a [b {c","x":[1')!)).toEqual({ scene: 'a [b {c', x: [1] });
  });

  it('cuts a dangling key or value back to the last complete entry', () => {
    expect(JSON.parse(repairJson('{"a":1,"b"')!)).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{"a":1,"b":')!)).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{"a":1,"b":{"c"')!)).toEqual({ a: 1 });
  });

  it('keeps a complete object and ignores what follows it', () => {
    expect(repairJson('{"a":1,} and more {"b":2}')).toBe('{"a":1}');
  });

  it('gives up (null) on text without an object, with mismatched closers, or with nothing complete to keep', () => {
    expect(repairJson('no json here')).toBeNull();
    expect(repairJson('{"a":[1}')).toBeNull();
    expect(repairJson('{"ok":tr')).toBeNull(); // the only entry dangles: cutting it back leaves nothing
    expect(repairJson('{')).toBe('{}'); // an empty object is not an invented value; the schema then rejects it
  });
});

describe('parseAgainst with repair (R3)', () => {
  const schema = z.object({ panels: z.array(z.object({ panelId: z.string(), scene: z.string() })).min(1) });

  it('uses a repaired answer that then validates', () => {
    const out = parseAgainst('{"panels":[{"panelId":"pn_a","scene":"rain"}]', schema);
    expect(out).toEqual({ ok: true, data: { panels: [{ panelId: 'pn_a', scene: 'rain' }] } });
  });

  it('still validates a repaired answer against the schema', () => {
    const out = parseAgainst('{"panels":[', schema);
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.problems).toContain('panels');
  });

  it('says the answer was cut off when the repair fails', () => {
    expect(parseAgainst('{"panels":[{"panelId":"pn_a"]', schema)).toEqual({ ok: false, problems: CUT_OFF_PROBLEM });
  });

  it('keeps the old messages for no object at all', () => {
    expect(parseAgainst('no json', schema)).toEqual({ ok: false, problems: 'The answer contained no JSON object.' });
  });
});

describe('completeStructured with repair (R3)', () => {
  it('a cut-off first answer is repaired without a correction round', async () => {
    const schema = z.object({ ok: z.boolean(), items: z.array(z.number()) });
    const prompts: string[] = [];
    const ask = async ({ prompt }: { system: string; prompt: string }): Promise<string> => { prompts.push(prompt); return '{"ok":true,"items":[1,2'; };
    await expect(completeStructured(ask, { name: 't', task: 'story', system: 's', prompt: 'p', schema })).resolves.toEqual({ ok: true, items: [1, 2] });
    expect(prompts).toHaveLength(1);
  });

  it('the correction round tells the model its answer was cut off', async () => {
    const schema = z.object({ ok: z.boolean() });
    const answers = ['{"ok":tr', '{"ok":true}'];
    const prompts: string[] = [];
    const ask = async ({ prompt }: { system: string; prompt: string }): Promise<string> => { prompts.push(prompt); return answers.shift()!; };
    await expect(completeStructured(ask, { name: 't', task: 'story', system: 's', prompt: 'p', schema })).resolves.toEqual({ ok: true });
    expect(prompts[1]).toContain(CUT_OFF_PROBLEM);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/structured.test.ts`
Expected: FAIL. `repairJson` / `CUT_OFF_PROBLEM` is not exported.

- [ ] **Step 3: Implement the repair** in `packages/server/src/engines/structured.ts`. Add it below `extractJson`, then replace `parseAgainst`:

```ts
/** The correction round's message when an answer's JSON object never ended and could not be repaired (R3). */
export const CUT_OFF_PROBLEM =
  'The answer was cut off before its JSON object ended. Answer again with the complete JSON object; keep text fields short if needed.';

interface Level { closer: '}' | ']'; openAt: number; commas: number[] }

const parses = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** `out` without trailing whitespace and a trailing comma, then every open level closed, innermost first. */
function closeAll(out: string, levels: readonly Level[]): string {
  return out.replace(/,\s*$/, '') + levels.map((l) => l.closer).reverse().join('');
}

/**
 * R3: the JSON object of an answer that was cut off or is slightly malformed, repaired; null when no repair parses.
 * - Starts at the first "{" (code fences and prose before it are dropped). A complete object ends the scan; text after it is ignored.
 * - Removes a trailing comma before "}" or "]". Brackets inside strings are ignored (the scan tracks strings and escapes).
 * - At a cut-off end: closes an open string (dropping a dangling backslash), then appends the missing closers in nesting order.
 *   When that does not parse (a dangling key, "key":, or a half-written entry), cuts back to the last comma of the innermost
 *   level, or drops that level's container when it has no comma, and tries again. It never invents a value.
 * Only a result that parses is returned; the caller still validates it against the schema.
 */
export function repairJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let out = '';
  const levels: Level[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' || ch === '[') {
      levels.push({ closer: ch === '{' ? '}' : ']', openAt: out.length, commas: [] });
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (levels.at(-1)?.closer !== ch) return null; // mismatched closer: not a cut-off we can mend
      out = out.replace(/,\s*$/, '') + ch;
      levels.pop();
      if (levels.length === 0) return parses(out) ? out : null;
      continue;
    }
    if (ch === ',') levels.at(-1)!.commas.push(out.length);
    out += ch;
  }
  // Cut off before the object ended.
  if (inString) out = `${escaped ? out.slice(0, -1) : out}"`;
  for (;;) {
    const candidate = closeAll(out, levels);
    if (parses(candidate)) return candidate;
    const top = levels.at(-1);
    if (top === undefined) return null;
    const comma = top.commas.pop();
    if (comma !== undefined) {
      out = out.slice(0, comma); // drop the comma and the dangling entry after it
    } else {
      out = out.slice(0, top.openAt); // drop the innermost container; its key in the parent now dangles
      levels.pop();
      if (levels.length === 0) return null;
    }
  }
}

export function parseAgainst<T>(raw: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(raw);
  let value: unknown;
  let parseProblem: string | null = null;
  if (json !== null) {
    try {
      value = JSON.parse(json);
    } catch (err) {
      parseProblem = `The JSON did not parse: ${(err as Error).message}`;
    }
  }
  if (json === null || parseProblem !== null) {
    // R3: a cut-off or slightly malformed answer is repaired before the correction round is spent on it.
    const repaired = repairJson(raw);
    if (repaired === null) {
      const problems = parseProblem ?? (raw.includes('{') ? CUT_OFF_PROBLEM : 'The answer contained no JSON object.');
      return { ok: false, problems };
    }
    value = JSON.parse(repaired);
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}
```

Check `'{"panels":[{"panelId":"pn_a"]'` against the "cut off" test: `]` closes a `{`, so the closer is mismatched, `repairJson` returns null, and the text contains `{`, so the result is `CUT_OFF_PROBLEM`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/structured.test.ts packages/server/test/claude-engine.test.ts packages/server/test/ollama-engine.test.ts`
Expected: PASS. The existing `extractJson` and `parseAgainst` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engines/structured.ts packages/server/test/structured.test.ts
git commit -m "feat(engines): repair cut-off or malformed JSON answers before the correction round (W1 R3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared contracts, migration 2 and the `paused` status

**Files:**
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/api.ts`, `packages/shared/src/jobs.ts`, `packages/shared/src/episode.ts`
- Modify: `packages/server/src/store/migrations.ts`, `packages/server/src/store/entities.ts:47-56`, `packages/server/src/store/types.ts:9`, `packages/server/src/store/settings.ts:7-15`
- Modify (exhaustiveness only):
  - `packages/ui/src/episode/episodeView.ts` (`STEP_STATUS_TEXT`, `runLabel`, `statusChipClass`)
  - `packages/ui/src/chapter/EpisodePanel.tsx` (`STATUS_ICON`)
  - `packages/ui/src/ui/icons.ts` (add `Pause`, `ImagePlus`)
  - `packages/ui/src/styles/screens.css` (add `.status-chip--paused`)
  - `packages/cli/src/follow.ts` (`isSettled`)
- Test:
  - `packages/shared/test/schemas.test.ts`, `packages/shared/test/episode.test.ts`
  - `packages/server/test/store.test.ts`, `packages/server/test/store-jobs-settings.test.ts`
  - `packages/ui/test/episode-view.test.ts`, `packages/cli/test/episode-format.test.ts`
  - fixture fixes: `packages/ui/test/manga-model.test.ts`, `packages/ui/test/settings-patch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (every later task relies on these names):
  - `StepStatusSchema`: `'pending' | 'running' | 'awaiting-review' | 'done' | 'failed' | 'paused'`.
  - `EpisodeRunStatusSchema`: adds `'paused'`. `EPISODE_ACTIVE_STATUSES` = `running`, `awaiting-review`, `paused`.
  - `EpisodeInputSchema`: adds `previewFirst: z.boolean().optional()`. A stored run without it means "off", so pre-W1 runs never stop.
  - `StartEpisodeSchema.input.previewFirst`: `z.boolean().default(true)`. This is the spec's default, and it applies to every API start.
  - `ChapterSchema`: adds `summary: z.string().default('')`. `UpdateChapterSchema`: adds `summary: z.string()` (partial).
  - `NewChapter = Omit<NewEntity<Chapter>, 'summary'> & { summary?: string }`.
  - `SettingsSchema.episode = { confirmRenderMinutes: number }` (int, 1..1440). `DEFAULT_SETTINGS.episode.confirmRenderMinutes = 45`. `SettingsPatchSchema.episode` is partial.
  - `LlmStepPayload` adds `{ type: 'chapter-summary'; chapterId: string; runId: string }`.
  - `GPU_BUSY_REASON = 'GPU busy: another app is using GPU memory'` and `GPU_MANUAL_PAUSE_REASON = 'Paused by you'`, both in `jobs.ts`.
  - `interface QueueLanes { pausedLanes: ServiceStatus['queue']['pausedLanes'] }` and `interface MissingPanels { panelIds: string[] }`, both in `api.ts`.
  - In `episode.ts`:
    - `TYPICAL_PANELS_PER_PAGE = 4.5`;
    - `estimateChapter(pages: number, settings: Settings): { panels: number; seconds: number }`;
    - `formatChapterEstimate(pages: number, settings: Settings): string`, e.g. `'8 pages ≈ 36 panels ≈ 37 min'`.
  - Migration version 2: `ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/episode.test.ts` (append; import `DEFAULT_SETTINGS`, `TYPICAL_PANELS_PER_PAGE`, `estimateChapter`, `formatChapterEstimate` from `../src/index.js` the way the file already imports):

```ts
describe('chapter estimate (W1 C2)', () => {
  it('is pages × 4.5 panels × the routed recipes, with the review rounds', () => {
    expect(TYPICAL_PANELS_PER_PAGE).toBe(4.5);
    // (anime 30 + anime-ref 32 + klein-ref 17) / 3 per panel; review 2 rounds (estimateReviewSeconds)
    expect(estimateChapter(8, DEFAULT_SETTINGS)).toEqual({ panels: 36, seconds: 2199 });
    expect(formatChapterEstimate(8, DEFAULT_SETTINGS)).toBe('8 pages ≈ 36 panels ≈ 37 min');
  });

  it('leaves the review out when episodes do not review, and says "page" for one', () => {
    const noReview = { ...DEFAULT_SETTINGS, review: { autoInEpisode: false, rounds: 2 } };
    expect(estimateChapter(2, noReview)).toEqual({ panels: 9, seconds: 237 });
    expect(formatChapterEstimate(1, noReview)).toBe('1 page ≈ 5 panels ≈ 2 min');
  });
});
```

(Arithmetic: 9 panels × 26.33 s = 237 s. For 1 page, `Math.round(4.5)` = 5 panels, 5 × 26.33 = 131.7 s, which rounds to "2 min".)

`packages/shared/test/schemas.test.ts` (append):

```ts
describe('W1 schema additions', () => {
  it('a run and a step can be paused; paused runs are live', () => {
    expect(StepStatusSchema.parse('paused')).toBe('paused');
    expect(EpisodeRunStatusSchema.parse('paused')).toBe('paused');
    expect(EPISODE_ACTIVE_STATUSES.has('paused')).toBe(true);
  });

  it('previewFirst: absent on a stored input (off), true by default when a run is started through the API', () => {
    expect(EpisodeInputSchema.parse({ prompt: 'p' }).previewFirst).toBeUndefined();
    expect(StartEpisodeSchema.parse({ input: { prompt: 'p' } }).input.previewFirst).toBe(true);
    expect(StartEpisodeSchema.parse({ input: { prompt: 'p', previewFirst: false } }).input.previewFirst).toBe(false);
  });

  it('a chapter row read before migration 2 gets an empty summary; the summary is patchable', () => {
    const row = { id: 'ch_aaaaaaaaaa', mangaId: 'mg_aaaaaaaaaa', number: 1, title: 'T', synopsis: '', coverPageId: null, status: 'draft', order: 0, createdAt: '', updatedAt: '' };
    expect(ChapterSchema.parse(row).summary).toBe('');
    expect(UpdateChapterSchema.parse({ summary: 'Aiko found the cat.' })).toEqual({ summary: 'Aiko found the cat.' });
  });

  it('settings.episode.confirmRenderMinutes defaults to 45 and is patchable', () => {
    expect(DEFAULT_SETTINGS.episode.confirmRenderMinutes).toBe(45);
    expect(SettingsPatchSchema.parse({ episode: { confirmRenderMinutes: 90 } })).toEqual({ episode: { confirmRenderMinutes: 90 } });
    expect(SettingsSchema.shape.episode.safeParse({ confirmRenderMinutes: 0 }).success).toBe(false);
  });
});
```

`packages/server/test/store.test.ts`: change both `expect(schemaVersion(db)).toBe(1)` lines to `toBe(2)`, and append:

```ts
describe('migration 2 (W1 Q1: chapters.summary)', () => {
  it('adds an empty summary to chapters written before it', () => {
    db.close();
    const file = join(dir.path, 'old.sqlite');
    const old = new Database(file);
    old.exec(MIGRATIONS[0]!.sql);
    old.pragma('user_version = 1');
    old.prepare(`INSERT INTO mangas VALUES ('mg_aaaaaaaaaa','M','','en','bw','rtl','{}','{}',NULL,'t','t')`).run();
    old.prepare(`INSERT INTO chapters VALUES ('ch_aaaaaaaaaa','mg_aaaaaaaaaa',1,'One','',NULL,'draft',0,'t','t')`).run();
    old.close();
    db = openDatabase(file);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare(`SELECT summary FROM chapters WHERE id = 'ch_aaaaaaaaaa'`).get()).toEqual({ summary: '' });
  });

  it('round-trips a summary; a chapter created without one has ""', () => {
    const m = seedManga();
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    expect(ch.summary).toBe('');
    expect(repos.chapters.update(ch.id, { summary: 'Aiko found the cat.' }).summary).toBe('Aiko found the cat.');
    expect(repos.chapters.require(ch.id).summary).toBe('Aiko found the cat.');
  });
});
```

Add `import { MIGRATIONS } from '../src/store/migrations.js';`. `Database` is already imported. The old-row test reads the raw column, so the stub JSON in `mangas` is never decoded.

`packages/server/test/store-jobs-settings.test.ts` (append inside the settings describe):

```ts
it('merges the episode section and reads old stored settings with its default', () => {
  expect(t.store.settings.get().episode).toEqual({ confirmRenderMinutes: 45 });
  expect(t.store.settings.patch({ episode: { confirmRenderMinutes: 20 } }).episode.confirmRenderMinutes).toBe(20);
  expect(t.store.settings.patch({ review: { rounds: 1 } }).episode.confirmRenderMinutes).toBe(20);
});
```

(Use the file's own store variable name; it is `t.store` if the file uses `makeStore`.)

`packages/ui/test/episode-view.test.ts` (append):

```ts
it('a paused run reads "Rendering paused" in a paused chip', () => {
  const r = { ...runAt('render'), status: 'paused' as const };
  expect(runLabel(r)).toBe('Rendering paused');
  expect(statusChipClass('paused')).toBe('status-chip--paused');
  expect(STEP_STATUS_TEXT.paused).toBe('paused');
});
```

(`runAt` stands for the file's existing run fixture helper. If there is none, build a run like `episode-panel-render.test.tsx`'s `run()` does, with `currentStep: 5`.)

`packages/cli/test/episode-format.test.ts` (append; import `isSettled` from `../src/follow.js`):

```ts
it('--wait settles on a paused run (it waits for the user, like a review point)', () => {
  const base = { id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode: 'autopilot' as const, currentStep: 5, steps: [], createdAt: '', updatedAt: '' };
  expect(isSettled({ ...base, status: 'paused' })).toBe(true);
  expect(isSettled({ ...base, status: 'running' })).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/test packages/server/test/store.test.ts packages/server/test/store-jobs-settings.test.ts packages/ui/test/episode-view.test.ts packages/cli/test/episode-format.test.ts`
Expected: FAIL. `'paused'` is not in the enums, `estimateChapter` is undefined, and the schema version is 1.

- [ ] **Step 3: Implement the shared changes**

`packages/shared/src/schemas.ts`:

```ts
// ChapterSchema: add after `synopsis`
  /** W1 Q1: "what happened", written when an episode run finishes; the next chapters' premise and outline read it. */
  summary: z.string().default(''),

// replace
export const StepStatusSchema = z.enum(['pending', 'running', 'awaiting-review', 'done', 'failed', 'paused']);

// EpisodeInputSchema: add
  /** W1 Q2: render the cover and page 1 first, then wait. Absent on runs stored before W1, which means off. */
  previewFirst: z.boolean().optional(),

export const EpisodeRunStatusSchema = z.enum(['running', 'awaiting-review', 'done', 'failed', 'cancelled', 'paused']);
/** ... (keep the doc) W1 C1: a paused run is live too (one live run per chapter), and --wait settles on it. */
export const EPISODE_ACTIVE_STATUSES: ReadonlySet<z.infer<typeof EpisodeRunStatusSchema>> = new Set(['running', 'awaiting-review', 'paused']);

// SettingsSchema: add a section
  episode: z.object({ confirmRenderMinutes: z.number().int().min(1).max(1440) }),
// DEFAULT_SETTINGS: add
  episode: { confirmRenderMinutes: 45 },
// SettingsPatchSchema: add
  episode: SettingsSchema.shape.episode.partial().optional(),
```

`packages/shared/src/api.ts`:

```ts
export const UpdateChapterSchema = z.object({
  title: z.string().min(1), synopsis: z.string(), summary: z.string(), number: z.number().int().min(1), status: ChapterStatusSchema,
}).partial();
/** W1 Q2: an API start previews page 1 unless it says otherwise (the spec's default); a stored input without the key is off. */
export const StartEpisodeSchema = z.object({
  input: EpisodeInputSchema.extend({ previewFirst: z.boolean().default(true) }),
  mode: z.enum(['review', 'autopilot']).default('review'),
});
/** POST /api/queue/gpu/pause|resume (W1 R2). */
export interface QueueLanes { pausedLanes: ServiceStatus['queue']['pausedLanes'] }
/** GET /api/chapters/:id/render-missing (W1 R1): the story and cover panels without an active image, cover last. */
export interface MissingPanels { panelIds: string[] }
```

`packages/shared/src/jobs.ts`:

```ts
export type LlmStepPayload =
  | { type: 'episode'; runId: string; step: EpisodeStepName }
  | { type: 'panel-prompt'; panelId: string }
  | { type: 'appearance'; characterId: string; description: string }
  /** W1 Q1: the chapter's "what happened", queued when an episode run finishes. */
  | { type: 'chapter-summary'; chapterId: string; runId: string };

/** W1 R2: the gpu lane's pause reason when another app holds the GPU memory; only this pause is lifted automatically. */
export const GPU_BUSY_REASON = 'GPU busy: another app is using GPU memory';
/** W1 R2: the gpu lane's pause reason after "Pause image queue"; never lifted automatically. */
export const GPU_MANUAL_PAUSE_REASON = 'Paused by you';
```

`packages/shared/src/episode.ts` (append after `formatEstimate`; add `Settings` to the type import from `./schemas.js`):

```ts
/** W1 C2: the panels a page typically gets (the breakdown prompt aims for 3–5 per page). */
export const TYPICAL_PANELS_PER_PAGE = 4.5;

/**
 * W1 C2: the render time of a chapter not broken down yet: pages × TYPICAL_PANELS_PER_PAGE panels, each at the mean of the
 * three routed recipes (no characters, one, several), plus the review rounds when episodes review their images.
 */
export function estimateChapter(pages: number, settings: Settings): { panels: number; seconds: number } {
  const panels = Math.round(pages * TYPICAL_PANELS_PER_PAGE);
  const { noChars, oneChar, multiChar } = settings.routing;
  const perPanel = estimateSeconds([noChars, oneChar, multiChar]) / 3;
  const render = panels * perPanel;
  const rounds = settings.review.autoInEpisode ? settings.review.rounds : 0;
  return { panels, seconds: Math.round(render + estimateReviewSeconds(render, panels, rounds)) };
}

/** "8 pages ≈ 36 panels ≈ 37 min" (the AI section and `manga episode start`). */
export function formatChapterEstimate(pages: number, settings: Settings): string {
  const { panels, seconds } = estimateChapter(pages, settings);
  return `${pages} ${pages === 1 ? 'page' : 'pages'} ≈ ${panels} panels ≈ ${formatEstimate(seconds).replace(/^~/, '')}`;
}
```

- [ ] **Step 4: Implement the store changes**

`packages/server/src/store/migrations.ts`: append after the version 1 entry:

```ts
  {
    version: 2,
    // W1 Q1: the chapter summary an episode run writes when it finishes; older rows read as "".
    sql: `ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '';`,
  },
```

`packages/server/src/store/entities.ts`: add `summary: 'summary'` to the `ChapterRepo` columns after `synopsis`.

`packages/server/src/store/types.ts`:

```ts
/** `summary` defaults to '' (W1 Q1), so creators that predate it need not pass it. */
export type NewChapter = Omit<NewEntity<Chapter>, 'summary'> & { summary?: string };
```

`packages/server/src/store/settings.ts` `mergeSettings`: add `episode: { ...base.episode, ...patch.episode },`.

- [ ] **Step 5: Keep the UI and CLI exhaustive**

`packages/ui/src/episode/episodeView.ts`:
- `STEP_STATUS_TEXT`: add `paused: 'paused'`.
- `runLabel`: add `case 'paused': return 'Rendering paused';`.
- `statusChipClass`: add `case 'paused': return 'status-chip--paused';`.

`packages/ui/src/ui/icons.ts`: add `ImagePlus` and `Pause` to the lucide export list, in alphabetical order.

`packages/ui/src/chapter/EpisodePanel.tsx`: add `paused: Pause` to `STATUS_ICON`, and add `Pause` to its icon import.

`packages/ui/src/styles/screens.css`: after `.status-chip--failed`, add:

```css
.status-chip--paused { background: color-mix(in oklab, var(--warn) 16%, transparent); color: var(--warn); }
```

`packages/cli/src/follow.ts`:

```ts
/** True when the run has stopped: waiting for review, paused (W1 C1: it waits for the user too), or ended. */
export function isSettled(run: EpisodeRun): boolean {
  return run.status === 'awaiting-review' || run.status === 'paused' || !EPISODE_ACTIVE_STATUSES.has(run.status);
}
```

Fixture fixes that `npm run typecheck` flags:
- `packages/ui/test/manga-model.test.ts`: every `Chapter` literal gains `summary: ''`.
- `packages/ui/test/settings-patch.test.ts` and `packages/server/test/store-jobs-settings.test.ts`: every full `Settings` literal gains `episode: { confirmRenderMinutes: 45 }`, or spreads `DEFAULT_SETTINGS`.

- [ ] **Step 6: Run the checks**

Run: `npm run typecheck`, then `npx vitest run packages/shared packages/server/test/store.test.ts packages/server/test/store-jobs-settings.test.ts packages/ui/test packages/cli/test/episode-format.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/server/src/store packages/server/test/store.test.ts packages/server/test/store-jobs-settings.test.ts packages/ui/src packages/ui/test packages/cli/src/follow.ts packages/cli/test/episode-format.test.ts
git commit -m "feat(shared): W1 contracts: paused runs and steps, previewFirst, chapter summary (migration 2), episode settings, chapter estimate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: R2 — the gpu lane pauses itself while the GPU is busy

**Files:**
- Modify: `packages/server/src/jobs/errors.ts`, `packages/server/src/jobs/queue.ts`
- Modify: `packages/server/src/imaging/comfy.ts` (around lines 79-81, 126-138, 240-246 and 290-296)
- Create: `packages/server/src/imaging/gpu-monitor.ts`
- Modify: `packages/server/src/modules/imaging.ts`, `packages/server/src/api/system.ts`, `packages/server/src/api/jobs.ts`
- Modify: `packages/ui/src/events.ts:146-149` (comment only: the server now emits `status`)
- Test:
  - `packages/server/test/queue.test.ts`, `packages/server/test/comfy-client.test.ts`, `packages/server/test/gpu-stall.test.ts`
  - Create: `packages/server/test/gpu-monitor.test.ts`
  - `packages/server/test/api-jobs.test.ts`

**Interfaces:**
- Consumes: `GPU_BUSY_REASON`, `GPU_MANUAL_PAUSE_REASON` and `QueueLanes` from Task 2.
- Produces:
  - `class GpuBusyError extends TransientError` (in `jobs/errors.ts`).
  - `JobQueue`:
    - `pauseOf(lane: Lane): { until: Date | null; reason: string } | null`;
    - `onLanesChanged(listener: () => void): () => void` (returns the unsubscribe function);
    - `pauseLane` / `resumeLane` / an expired pause each notify the listeners;
    - a `GpuBusyError` pauses the job's lane with `GPU_BUSY_REASON` unless that lane is already paused, then requeues the job at once with `attempts - 1`.
  - `ComfyClient`:
    - `availableVram(signal?: AbortSignal): Promise<number | null>`;
    - `export const GPU_PAUSE_FREE_BYTES = 3e9` (replaces `LOW_VRAM_BYTES`; the constructor option `lowVramBytes` becomes `pauseFreeBytes`);
    - a stalled prompt or low VRAM before submitting throws `GpuBusyError`.
  - `imaging/gpu-monitor.ts`:
    - `GPU_RESUME_FREE_BYTES = 8e9` and `GPU_MONITOR_INTERVAL_MS = 30_000`;
    - `interface GpuProbe { availableVram(): Promise<number | null> }`;
    - `type GpuCheck = 'idle' | 'waiting' | 'resumed'`;
    - `class GpuMonitor { constructor(opts: GpuMonitorOptions); start(): void; stop(): void; check(): Promise<GpuCheck> }`.
  - `api/system.ts`: `export async function serviceStatus(deps: Pick<CoreDeps, 'statusProviders' | 'store' | 'queue'>): Promise<ServiceStatus>`. Every lane change emits `{ type: 'status', status }`.
  - Routes: `POST /api/queue/gpu/pause` and `POST /api/queue/gpu/resume`, both returning `QueueLanes`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/queue.test.ts` (append; import `GpuBusyError` from `../src/jobs/errors.js` and `GPU_BUSY_REASON`, `GPU_MANUAL_PAUSE_REASON` from `@manga/shared`):

```ts
describe('JobQueue — GPU busy (W1 R2)', () => {
  it('pauses the lane and puts the job back without spending an attempt; a resume runs it', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls++;
      if (calls === 1) throw new GpuBusyError('GPU busy: only 1.0 GB of GPU memory free');
      return { ok: true };
    });
    const seen: string[] = [];
    q.onLanesChanged(() => seen.push(q.pauseOf('gpu')?.reason ?? 'running'));
    const job = gpuJob(q);
    q.start();
    await vi.waitFor(() => expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    await sleep(30); // the paused lane claims nothing
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0, error: 'GPU busy: only 1.0 GB of GPU memory free' });
    expect(calls).toBe(1);
    q.resumeLane('gpu');
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(seen).toEqual([GPU_BUSY_REASON, 'running']);
  });

  it('never replaces a manual pause with the busy reason', async () => {
    const q = makeQueue();
    q.register('image.generate', async () => {
      q.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON); // the user paused while the job ran
      throw new GpuBusyError('GPU stalled');
    });
    const job = gpuJob(q);
    q.start();
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('queued'));
    expect(q.pauseOf('gpu')?.reason).toBe(GPU_MANUAL_PAUSE_REASON);
  });

  it('a resume of a lane that is not paused notifies nobody', () => {
    const q = makeQueue();
    const seen: number[] = [];
    const off = q.onLanesChanged(() => seen.push(1));
    q.resumeLane('gpu');
    q.pauseLane('claude', null, 'quota');
    off();
    q.resumeLane('claude');
    expect(seen).toEqual([1]);
    expect(q.pauseOf('claude')).toBeNull();
  });
});
```

`packages/server/test/comfy-client.test.ts`: replace the test "warns in the progress label when little VRAM is left for ComfyUI, and still runs" with the test below. In the stall tests, also assert `expect(err).toBeInstanceOf(GpuBusyError)` (import it from `../src/jobs/errors.js`):

```ts
it('refuses to start a run while another app holds the GPU memory: GpuBusyError, nothing submitted (W1 R2)', async () => {
  fake.vramFree = 1.2e9;
  const rec = recorder();
  const err = await client.run(miniGraph(), { onProgress: rec.onProgress }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GpuBusyError);
  expect((err as Error).message).toBe('GPU busy: only 1.2 GB of GPU memory free (GPU memory is probably full; close games or other GPU apps)');
  expect(fake.calls.some((c) => c.path === '/prompt')).toBe(false);
});
```

`packages/server/test/gpu-stall.test.ts`: replace the single test (import `vi` and `GPU_BUSY_REASON`):

```ts
it('pauses the gpu lane as busy and puts the stalled job back without spending an attempt; a resume runs both jobs', async () => {
  const bus = new EventBus();
  const comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10, firstProgressTimeoutMs: 5_000, stallTimeoutMs: 250 });
  queue = new JobQueue({ store: t.store, bus, gpu: new GpuArbiter(), pollMs: 5, backoffMs: [BACKOFF_MS] });
  const runs: string[] = [];
  queue.register('image.generate', async (ctx) => {
    const name = (ctx.job.payload as { name: string }).name;
    try {
      await comfy.run(graph(name), { signal: ctx.signal, onProgress: ctx.progress });
      runs.push(`${name}:ok`);
    } catch (err) {
      runs.push(`${name}:failed`);
      throw err;
    }
  });
  fake.stallNext = 1;
  const stalled = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'stalled' } });
  const next = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'next' } });
  queue.start();

  await vi.waitFor(() => expect(queue!.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON), { timeout: 5_000 });
  await vi.waitFor(() => expect(t.store.jobs.require(stalled.id)).toMatchObject({ status: 'queued', attempts: 0 }));
  expect(t.store.jobs.require(stalled.id).error).toMatch(/^GPU stalled: no progress for 250 ms/);
  expect(t.store.jobs.require(next.id).status).toBe('queued'); // the lane waits instead of stalling job after job
  const first = fake.promptIds[0]!;
  expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: first } });
  expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);

  queue.resumeLane('gpu');
  const [a, b] = await Promise.all([queue.waitFor(stalled.id), queue.waitFor(next.id)]);
  expect(a).toMatchObject({ status: 'succeeded', attempts: 1 });
  expect(b).toMatchObject({ status: 'succeeded', attempts: 1 });
  expect(runs).toEqual(['stalled:failed', 'stalled:ok', 'next:ok']);
});
```

Create `packages/server/test/gpu-monitor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { GPU_RESUME_FREE_BYTES, GpuMonitor } from '../src/imaging/gpu-monitor.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { JobQueue } from '../src/jobs/queue.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { makeStore, type TestStore } from './helpers/store.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const graph: ComfyGraph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0], seed: 1, steps: 3, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'm' } },
};

let t: TestStore;
let fake: FakeComfy;
let queue: JobQueue | undefined;
let monitor: GpuMonitor | undefined;
beforeEach(async () => { t = makeStore(); fake = await startFakeComfy(); });
afterEach(async () => {
  monitor?.stop();
  await queue?.stop();
  queue = undefined;
  monitor = undefined;
  await fake.close();
  t.close();
});

const newQueue = (): JobQueue => new JobQueue({ store: t.store, bus: new EventBus(), gpu: new GpuArbiter(), pollMs: 5 });

describe('GpuMonitor (W1 R2)', () => {
  it('a low-VRAM job pauses the lane; the monitor resumes it once ComfyUI has room again', async () => {
    fake.vramFree = 1e9;
    const comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 });
    queue = newQueue();
    queue.register('image.generate', async (ctx) => { await comfy.run(graph, { signal: ctx.signal, onProgress: ctx.progress }); });
    monitor = new GpuMonitor({ queue, probe: comfy, intervalMs: 20 });
    monitor.start();
    const job = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    queue.start();
    await vi.waitFor(() => expect(queue!.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await sleep(100);
    expect(queue.pauseOf('gpu')).not.toBeNull(); // still 1 GB free: stays paused
    expect(fake.calls.some((c) => c.path === '/prompt')).toBe(false);
    fake.vramFree = GPU_RESUME_FREE_BYTES + 1e9;
    expect(await queue.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(queue.pauseOf('gpu')).toBeNull();
  });

  it('never lifts a manual pause', async () => {
    queue = newQueue();
    queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => 16e9 }, intervalMs: 10 });
    monitor.start();
    expect(await monitor.check()).toBe('idle');
    await sleep(50);
    expect(queue.pauseOf('gpu')?.reason).toBe(GPU_MANUAL_PAUSE_REASON);
  });

  it('resumes when ComfyUI comes back after being unreachable (a restart), even with little VRAM', async () => {
    queue = newQueue();
    const answers: Array<number | null> = [null, 1e9];
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => answers.shift() ?? 1e9 }, intervalMs: 60_000 });
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    expect(await monitor.check()).toBe('waiting');
    expect(await monitor.check()).toBe('resumed');
    expect(queue.pauseOf('gpu')).toBeNull();
  });

  it('polls only while the lane is paused as busy', async () => {
    queue = newQueue();
    let polls = 0;
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => { polls++; return 1e9; } }, intervalMs: 10 });
    monitor.start();
    await sleep(50);
    expect(polls).toBe(0);
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    await vi.waitFor(() => expect(polls).toBeGreaterThan(1));
    queue.resumeLane('gpu');
    const after = polls;
    await sleep(50);
    expect(polls).toBeLessThanOrEqual(after + 1); // at most one poll that was already in flight
  });
});
```

`packages/server/test/api-jobs.test.ts` (append; follow the file's own server helper; an M4 server is shown here):

```ts
describe('queue lane routes (W1 R2)', () => {
  it('pause and resume the gpu lane; each change reaches the UI as a status event', async () => {
    const s = await startM4TestServer();
    try {
      const statuses: ServiceStatus[] = [];
      s.deps.bus.on((e) => { if (e.type === 'status') statuses.push(e.status); });
      const paused = await s.api<QueueLanes>('POST', '/api/queue/gpu/pause');
      expect(paused.body.pausedLanes).toEqual([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]);
      await s.until(async () => statuses.some((st) => st.queue.pausedLanes.some((p) => p.lane === 'gpu')));
      const resumed = await s.api<QueueLanes>('POST', '/api/queue/gpu/resume');
      expect(resumed.body.pausedLanes).toEqual([]);
      await s.until(async () => statuses.at(-1)?.queue.pausedLanes.length === 0);
      expect((await s.api<ServiceStatus>('GET', '/api/status')).body.queue.pausedLanes).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/queue.test.ts packages/server/test/comfy-client.test.ts packages/server/test/gpu-stall.test.ts packages/server/test/gpu-monitor.test.ts packages/server/test/api-jobs.test.ts`
Expected: FAIL. `GpuBusyError`, `pauseOf`, `GpuMonitor` and the routes are missing.

- [ ] **Step 3: Add the error and the queue changes**

`packages/server/src/jobs/errors.ts` (append):

```ts
/**
 * W1 R2: the GPU has no room for image work (another app, e.g. a game, holds its memory). The queue pauses the job's lane
 * and puts the job back without spending an attempt; the GPU monitor resumes the lane when there is room again.
 */
export class GpuBusyError extends TransientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GpuBusyError';
  }
}
```

`packages/server/src/jobs/queue.ts`:
- Import `GPU_BUSY_REASON` from `@manga/shared` and `GpuBusyError` from `./errors.js`.
- Add a field and the new methods:

```ts
  private readonly laneListeners = new Set<() => void>();

  /** until null = until resumeLane. Notifies the lane listeners (the `status` event, the GPU monitor). */
  pauseLane(lane: Lane, until: Date | null, reason: string): void {
    this.paused.set(lane, { until, reason });
    this.lanesChanged();
  }

  resumeLane(lane: Lane): void {
    const had = this.paused.delete(lane);
    this.kick();
    if (had) this.lanesChanged();
  }

  /** The lane's pause, or null (an expired timed pause is dropped first). */
  pauseOf(lane: Lane): { until: Date | null; reason: string } | null {
    this.expirePauses();
    return this.paused.get(lane) ?? null;
  }

  /** Called after every pause, resume or expiry of a lane. Returns the unsubscribe function. */
  onLanesChanged(listener: () => void): () => void {
    this.laneListeners.add(listener);
    return () => { this.laneListeners.delete(listener); };
  }

  private lanesChanged(): void {
    for (const listener of [...this.laneListeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[manga] job queue: lane listener failed:', error);
      }
    }
  }
```

- Replace `expirePauses` so an expiry notifies too:

```ts
  private expirePauses(): void {
    const now = this.now().getTime();
    let changed = false;
    for (const [lane, pause] of this.paused) {
      if (pause.until !== null && pause.until.getTime() <= now) {
        this.paused.delete(lane);
        changed = true;
      }
    }
    if (changed) this.lanesChanged();
  }
```

- In `finish`, after the `this.stopping && run.controller.signal.aborted` branch, and before the `TransientError` branch:

```ts
    const message = messageOf(outcome.error);
    if (outcome.error instanceof GpuBusyError) {
      // W1 R2: another app holds the GPU. Pause the lane (a pause already there, e.g. the user's, stays as it is) and put
      // the job back at once without spending an attempt: it waits for the lane, not for a backoff.
      if (!this.paused.has(current.lane)) this.pauseLane(current.lane, null, GPU_BUSY_REASON);
      this.publish(this.store.jobs.update(id, {
        status: 'queued', error: message, startedAt: null, nextRunAt: nowIso, attempts: Math.max(0, current.attempts - 1),
      }));
      return;
    }
```

(Move the existing `const message = …` line up to here; the `TransientError` branch below reuses it.)

- [ ] **Step 4: Make the ComfyUI client throw `GpuBusyError`**

In `packages/server/src/imaging/comfy.ts`:
- Import `GpuBusyError` next to `PermanentError, TransientError` from `../jobs/index.js`.
- Replace the `LOW_VRAM_BYTES` constant:

```ts
/** W1 R2: below this much VRAM left for ComfyUI (free plus what it holds itself), a run does not start: another app is
 *  using the GPU, and the run would crawl. The job pauses the gpu lane instead. Generic: every image model family needs more. */
export const GPU_PAUSE_FREE_BYTES = 3e9;
```

- Rename the constructor option `lowVramBytes` to `pauseFreeBytes`, and the field too (`this.pauseFreeBytes = opts.pauseFreeBytes ?? GPU_PAUSE_FREE_BYTES`).
- Remove the `note` variable and its `+ note` uses in the socket handler (`say(stageLabel(classType))`, and `say(classType === 'ImageUpscaleWithModel' ? 'Upscaling' : 'Sampling', d.value, d.max)`).
- Replace the pre-submit block:

```ts
      const room = await this.vramAvailable(signal, 3_000);
      if (room !== null && room < this.pauseFreeBytes) {
        const reason = `GPU busy: only ${(room / 1e9).toFixed(1)} GB of GPU memory free (${STALL_ADVICE})`;
        say(reason);
        throw new GpuBusyError(reason); // nothing submitted: the catch below has no prompt to cancel
      }
      say('Queued');
```

- In `startWatchdog`, change `stalled.abort(new TransientError(reason))` to `stalled.abort(new GpuBusyError(reason))`.
- Add a public method next to `health()`:

```ts
  /** W1 R2 (the GPU monitor): the VRAM ComfyUI could use now, or null when ComfyUI cannot be reached. */
  availableVram(signal?: AbortSignal): Promise<number | null> {
    return this.vramAvailable(signal, 3_000);
  }
```

- [ ] **Step 5: Create the GPU monitor** at `packages/server/src/imaging/gpu-monitor.ts`:

```ts
import { GPU_BUSY_REASON } from '@manga/shared';
import type { JobQueue } from '../jobs/index.js';

/** W1 R2: the gpu lane resumes once ComfyUI could use this much VRAM: enough for the largest routed recipe. */
export const GPU_RESUME_FREE_BYTES = 8e9;
export const GPU_MONITOR_INTERVAL_MS = 30_000;

/** The VRAM ComfyUI could use now, in bytes, or null when ComfyUI cannot be reached (ComfyClient.availableVram). */
export interface GpuProbe { availableVram(): Promise<number | null> }

export interface GpuMonitorOptions {
  queue: Pick<JobQueue, 'pauseOf' | 'resumeLane' | 'onLanesChanged'>;
  probe: GpuProbe;
  intervalMs?: number;
  resumeFreeBytes?: number;
}

export type GpuCheck = 'idle' | 'waiting' | 'resumed';

/**
 * While the gpu lane is paused as busy (GPU_BUSY_REASON), polls ComfyUI every `intervalMs`. It resumes the lane when
 * ComfyUI has `resumeFreeBytes` of VRAM again, or when ComfyUI answers after being unreachable during this pause (it was
 * restarted: the next job's own check pauses the lane again if the memory is still taken). Any other pause (the user's,
 * the Claude quota's) is never touched. Idle, it does not poll at all.
 */
export class GpuMonitor {
  private readonly intervalMs: number;
  private readonly resumeFreeBytes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private sawDown = false;
  private inFlight: Promise<GpuCheck> | null = null;

  constructor(private readonly opts: GpuMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? GPU_MONITOR_INTERVAL_MS;
    this.resumeFreeBytes = opts.resumeFreeBytes ?? GPU_RESUME_FREE_BYTES;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.queue.onLanesChanged(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll (the timer's, or a test's); concurrent calls share it. */
  check(): Promise<GpuCheck> {
    this.inFlight ??= this.poll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private busy(): boolean {
    return this.opts.queue.pauseOf('gpu')?.reason === GPU_BUSY_REASON;
  }

  private sync(): void {
    if (this.busy() && this.timer === null) {
      this.sawDown = false; // a new busy pause: ComfyUI has not been seen down yet
      this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
      this.timer.unref();
    } else if (!this.busy() && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<GpuCheck> {
    if (!this.busy()) return 'idle';
    let free: number | null;
    try {
      free = await this.opts.probe.availableVram();
    } catch {
      free = null;
    }
    if (free === null) {
      this.sawDown = true;
      return 'waiting';
    }
    if (free < this.resumeFreeBytes && !this.sawDown) return 'waiting';
    if (!this.busy()) return 'idle'; // the user paused (or resumed) while the probe ran: theirs wins
    this.opts.queue.resumeLane('gpu');
    return 'resumed';
  }
}
```

- [ ] **Step 6: Wire the monitor, the status event and the routes**

`packages/server/src/modules/imaging.ts`:
- Import `GpuMonitor` from `../imaging/gpu-monitor.js`.
- Add `let monitor: GpuMonitor | null = null;` inside `imagingModule`.
- At the end of `register`, add `monitor = new GpuMonitor({ queue: deps.queue, probe: comfy });`.
- Add `start(): void { monitor?.start(); },` and change `stop` to `monitor?.stop(); await services.fakeComfy?.close();`.

`packages/server/src/api/system.ts`: extract the status builder, and emit it on every lane change:

```ts
/** GET /api/status, and the `status` event (W1 R2). */
export async function serviceStatus(deps: Pick<CoreDeps, 'statusProviders' | 'store' | 'queue'>): Promise<ServiceStatus> {
  const providers = deps.statusProviders;
  const [claude, ollama, comfy] = await Promise.all([
    probe(() => providers.claude()), probe(() => providers.ollama()), probe(() => providers.comfy()),
  ]);
  return { claude, ollama, comfy, queue: { ...deps.store.jobs.counts(), pausedLanes: deps.queue.pausedLanes() } };
}

// inside registerSystemRoutes:
  app.get('/api/status', async (): Promise<ServiceStatus> => serviceStatus(deps));
  // W1 R2: a lane pause, resume or expiry reaches the UI at once (the 30 s poll stays as the fallback).
  deps.queue.onLanesChanged(() => {
    serviceStatus(deps).then(
      (status) => deps.bus.emit({ type: 'status', status }),
      (err: unknown) => console.error('[manga] status event:', err),
    );
  });
```

`packages/server/src/api/jobs.ts`:
- Import `GPU_MANUAL_PAUSE_REASON` and `type QueueLanes` from `@manga/shared`.
- Add these routes inside `registerJobRoutes`:

```ts
  // W1 R2: the manual override. A manual pause is never lifted by the GPU monitor; a resume lifts any gpu pause.
  app.post('/api/queue/gpu/pause', async (): Promise<QueueLanes> => {
    queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    return { pausedLanes: queue.pausedLanes() };
  });
  app.post('/api/queue/gpu/resume', async (): Promise<QueueLanes> => {
    queue.resumeLane('gpu');
    return { pausedLanes: queue.pausedLanes() };
  });
```

`packages/ui/src/events.ts`: in the `status` branch, replace the F10 comment with `// W1 R2: the server emits this on every lane pause, resume or expiry; the 30 s poll in queries.ts is the fallback.`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test` and then `npm run typecheck`
Expected: PASS. Any other test that set `lowVramBytes` now uses `pauseFreeBytes`; typecheck finds them.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src packages/server/test packages/ui/src/events.ts
git commit -m "feat(queue): a GPU stall or low VRAM pauses the image lane and requeues the job; a monitor resumes it when ComfyUI has room (W1 R2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Render step: failed panels, the preview stop and the size stop (R1, Q2, C2)

**Files:**
- Modify: `packages/shared/src/episode.ts` (`RenderOutputSchema`, `renderGate`)
- Modify: `packages/server/src/workflows/episode/render.ts` (`generateAll`, `runRenderStep`; new `renderPanels`)
- Modify: `packages/server/src/workflows/episode/runner.ts` (`approve`, `complete`)
- Test: `packages/shared/test/episode.test.ts`, `packages/server/test/episode-render.test.ts`, `packages/server/test/episode-runner.test.ts`
- Update (the API now defaults `previewFirst` to true): `packages/server/test/episode-autopilot.test.ts` (`setup` input), `packages/server/test/episode-routes.test.ts` (every start that runs past the render step of a 2+ page chapter)

**Interfaces:**
- Consumes (Task 2):
  - `EpisodeInput.previewFirst`;
  - `settings.episode.confirmRenderMinutes`;
  - `estimateRender(store, settings, manga, panels)` (existing, in `render.ts`);
  - `formatEstimate` (existing).
- Produces:
  - `RenderOutputSchema` fields:
    - `failedPanelIds: string[]` (default `[]`);
    - the preview stop: `preview?: true`, `remainingPanels?: number`;
    - the size stop: `confirm?: true`, `panels?: number`;
    - both stops: `estimateSeconds?: number`.
  - `type RenderGate = 'preview' | 'confirm'`.
  - `renderGate(output: unknown): RenderGate | null`: the kind of stop a render output is, or null.
  - `EpisodeRunner.approve(runId)` on a render gate re-dispatches the render step with its token kept, and does not accept it.
  - `EpisodeRunner.complete` pauses at `awaiting-review` for a gate output in both modes.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/episode.test.ts` (append):

```ts
describe('renderGate (W1 Q2, C2)', () => {
  const base = { jobs: [], reviewed: 0, flagged: 0, rounds: 0 };
  it('names the stop of a render output; a finished render and old outputs are none', () => {
    expect(renderGate({ ...base, failedPanelIds: [], preview: true, remainingPanels: 4, estimateSeconds: 120 })).toBe('preview');
    expect(renderGate({ ...base, failedPanelIds: [], confirm: true, panels: 40, estimateSeconds: 4000 })).toBe('confirm');
    expect(renderGate({ ...base, failedPanelIds: ['pn_a'] })).toBeNull();
    expect(renderGate(base)).toBeNull(); // stored before W1: failedPanelIds defaults to []
    expect(RenderOutputSchema.parse(base).failedPanelIds).toEqual([]);
    expect(renderGate(null)).toBeNull();
  });
});
```

`packages/server/test/episode-render.test.ts`:
- Extend `renderWorld` with `opts.previewFirst?: boolean` and `opts.pages?: number`:
  - use `breakdown(opts.pages ?? 2)`;
  - pass `input: { previewFirst: opts.previewFirst }` to `seedRun`, only when `opts.previewFirst !== undefined`, since `exactOptionalPropertyTypes` is on.
- Replace the test "fails the step when a panel render fails, naming the panel".
- Append the tests below. Add `renderGate` and `formatEstimate` to the shared import.

```ts
describe('runRenderStep — failed panels (W1 R1)', () => {
  it('records a failed panel, finishes the step, labels the failure and skips it in review', async () => {
    const { run, panelIds } = renderWorld();
    const broken = panelIds[2]!;
    const progress: string[] = [];
    const out = await render(run, { beforePanel: (id) => { if (id === broken) throw new Error('ComfyUI rejected the graph'); } }, progress);
    expect(out.failedPanelIds).toEqual([broken]);
    expect(lib.store.panels.require(broken).activeImageId).toBeNull();
    expect(progress.some((l) => /^Rendering 5 panels · est\. .+ · 1 failed$/.test(l))).toBe(true);
    const reviewed = queue.jobs('image.review').map((j) => (j.payload as ImageReviewPayload).panelId);
    expect(reviewed).toHaveLength(4);
    expect(reviewed).not.toContain(broken);
  });

  it('fails the step only when every panel failed, naming the first failure', async () => {
    const { run } = renderWorld();
    await expect(render(run, { beforePanel: () => { throw new Error('ComfyUI is not reachable'); } }))
      .rejects.toThrow(/^All 5 panel renders failed \(pn_[a-z2-7]+: ComfyUI is not reachable\)\. Check the image engine, then retry the render step\.$/);
  });
});

describe('runRenderStep — preview first (W1 Q2)', () => {
  it('renders the cover and page 1 first, then stops with the rest and its estimate', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, manga, panelIds } = renderWorld({ previewFirst: true });
    const [p1a, p1b, p2a, p2b, cover] = panelIds;
    const out = await render(run);
    expect(renderGate(out)).toBe('preview');
    const rest = [p2a!, p2b!].map((id) => lib.store.panels.require(id));
    expect(out).toMatchObject({ preview: true, remainingPanels: 2, failedPanelIds: [], estimateSeconds: estimateRender(lib.store, lib.store.settings.get(), manga, rest) });
    expect(queue.jobs('image.generate').map((j) => (j.payload as { panelId: string }).panelId).sort()).toEqual([p1a!, p1b!, cover!].sort());
    expect(rest.every((p) => p.activeImageId === null)).toBe(true);
  });

  it('Continue (the stop kept as the output, same token) renders only the rest and does not stop again', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, panelIds } = renderWorld({ previewFirst: true });
    const first = await render(run);
    const again = lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('render'), { output: first }) });
    const out = await render(again);
    expect(renderGate(out)).toBeNull();
    expect(out.failedPanelIds).toEqual([]);
    expect(queue.jobs('image.generate')).toHaveLength(5); // 3 for the preview + the 2 remaining, none twice
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });

  it('does not stop when page 1 is the only story page', async () => {
    const { run, panelIds } = renderWorld({ previewFirst: true, pages: 1 });
    const out = await render(run);
    expect(renderGate(out)).toBeNull();
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });
});

describe('runRenderStep — size stop (W1 C2)', () => {
  it('stops once before any GPU work when the render would take longer than confirmRenderMinutes', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { run } = renderWorld({ portrait: false, mode: 'autopilot' });
    const out = await render(run);
    expect(renderGate(out)).toBe('confirm');
    expect(out.panels).toBe(5);
    expect(out.estimateSeconds).toBeGreaterThan(60);
    expect(queue.jobs('image.generate')).toEqual([]); // not even a portrait
  });

  it('Continue after the size stop renders without asking again', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 }, review: { autoInEpisode: false } });
    const { run, panelIds } = renderWorld();
    const stop = await render(run);
    const again = lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('render'), { output: stop }) });
    expect(renderGate(await render(again))).toBeNull();
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });

  it('with the preview on, only the preview stops (it shows the estimate for the rest)', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { run } = renderWorld({ previewFirst: true });
    expect(renderGate(await render(run))).toBe('preview');
  });
});
```

`packages/server/test/episode-runner.test.ts` (append; import `stepIndex` from `@manga/shared`):

```ts
describe('EpisodeRunner — render stops (W1 Q2, C2)', () => {
  it('the preview stop waits even in autopilot; Continue renders the rest in the same step and finishes', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, { ...input, previewFirst: true }, 'autopilot');
    await queue.idle();
    let r = runner.get(run.id);
    const render = r.steps[stepIndex('render')]!;
    expect([r.status, r.currentStep, render.status]).toEqual(['awaiting-review', stepIndex('render'), 'awaiting-review']);
    expect(render.output).toMatchObject({ preview: true, remainingPanels: 2 });
    runner.approve(run.id);
    await queue.idle();
    r = runner.get(run.id);
    expect(r.status).toBe('done');
    expect(r.steps[stepIndex('render')]!.startedAt).toBe(render.startedAt);
    expect(queue.jobs('llm.step').filter((j) => (j.payload as { step?: string }).step === 'render')).toHaveLength(2);
    for (const page of storyPages(lib.store, chapter.id)) {
      expect(lib.store.panels.listByPage(page.id).every((p) => p.activeImageId !== null)).toBe(true);
    }
  });

  it('re-running the render step at the preview asks for the preview again, with a new token', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, { ...input, previewFirst: true }, 'autopilot');
    await queue.idle();
    const token = runner.get(run.id).steps[stepIndex('render')]!.startedAt;
    runner.rerun(run.id, 'render', false);
    await queue.idle();
    const step = runner.get(run.id).steps[stepIndex('render')]!;
    expect(step.status).toBe('awaiting-review');
    expect(step.output).toMatchObject({ preview: true });
    expect(step.startedAt).not.toBe(token);
  });

  it('the size stop waits in autopilot too, and Continue finishes', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    expect(runner.get(run.id).steps[stepIndex('render')]!.output).toMatchObject({ confirm: true });
    runner.approve(run.id);
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/test/episode.test.ts packages/server/test/episode-render.test.ts packages/server/test/episode-runner.test.ts`
Expected: FAIL. `renderGate` is missing, and `failedPanelIds` / `preview` are undefined.

- [ ] **Step 3: Extend the render output** in `packages/shared/src/episode.ts` (replace `RenderOutputSchema`):

```ts
export const RenderOutputSchema = z.object({
  jobs: z.array(z.string()), reviewed: z.number().int().min(0), flagged: z.number().int().min(0), rounds: z.number().int().min(0),
  /** W1 R1: panels whose render failed (they have no image); outputs stored before W1 have none. */
  failedPanelIds: z.array(z.string()).default([]),
  /** W1 Q2, the preview stop: the cover and page 1 are rendered; `remainingPanels` wait for Continue. */
  preview: z.literal(true).optional(),
  remainingPanels: z.number().int().min(0).optional(),
  /** W1 C2, the size stop: nothing is rendered yet; `panels` wait for Continue. */
  confirm: z.literal(true).optional(),
  panels: z.number().int().min(0).optional(),
  /** Both stops: the expected seconds of the panels that wait (review rounds included). */
  estimateSeconds: z.number().min(0).optional(),
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;
export type RenderGate = 'preview' | 'confirm';

/** W1 Q2/C2: which stop a render step output is, or null (a finished render, or not a render output at all). */
export function renderGate(output: unknown): RenderGate | null {
  const parsed = RenderOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  if (parsed.data.preview === true) return 'preview';
  return parsed.data.confirm === true ? 'confirm' : null;
}
```

- [ ] **Step 4: Rewrite the render driver** in `packages/server/src/workflows/episode/render.ts`.

Add `renderGate` to the `@manga/shared` import. Replace `generateAll`, and replace `runRenderStep` with the three pieces below. `reviewAll`, `ensurePortraits`, `Leftovers`, `retryPatch` and `estimateRender` stay unchanged.

```ts
interface GenFailure { panelId: string; error: string }

async function generateAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, reqs: GenRequest[], leftovers: Leftovers, jobIds: string[], label: string,
): Promise<{ done: Set<string>; failed: GenFailure[] }> {
  ctx.progress(label, 0, reqs.length); // before queueing, so the estimate is visible first
  const jobs = reqs.map((r) => {
    const adopted = leftovers.takeGenerate(r.panelId);
    if (adopted) return adopted;
    const payload: ImageGeneratePayload = { target: 'panel', panelId: r.panelId, ...r.patch };
    return deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  const done = new Set<string>();
  const failed: GenFailure[] = [];
  let count = 0;
  await Promise.all(jobs.map(async (job, i) => {
    const finished = await waitForJob(deps.queue, job.id, ctx.signal);
    const panelId = reqs[i]!.panelId;
    if (finished.status === 'succeeded' && (finished.result as ImageGenerateResult | null)?.imageId) done.add(panelId);
    else failed.push({ panelId, error: finished.error ?? finished.status });
    count++;
    // W1 R1: a failure is shown in the label and the render goes on.
    ctx.progress(failed.length > 0 ? `${label} · ${failed.length} failed` : label, count, reqs.length);
  }));
  return { done, failed };
}

const NOTHING_RENDERED = { jobs: [] as string[], reviewed: 0, flagged: 0, rounds: 0 };

/**
 * Renders `todo`, then batch review → re-render flagged, for at most settings.review.rounds rounds (spec §8). W1 R1: a failed
 * panel is recorded, not fatal; only a phase in which every panel failed is systemic (engine down, bad recipe) and fails the
 * step. Reviews cover the chapter's unreviewed images, never a panel whose render failed.
 */
async function renderPanels(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, current: () => Panel[], todo: Panel[], leftovers: Leftovers, label: string,
): Promise<Pick<RenderOutput, 'jobs' | 'reviewed' | 'flagged' | 'rounds'>> {
  const { store } = deps;
  const settings = store.settings.get();
  const jobIds: string[] = [];
  const first = await generateAll(deps, ctx, run, todo.map((p) => ({ panelId: p.id })), leftovers, jobIds, label);
  if (todo.length > 0 && first.failed.length === todo.length) {
    const f = first.failed[0]!;
    throw new PermanentError(`All ${todo.length} panel renders failed (${f.panelId}: ${f.error}). Check the image engine, then retry the render step.`);
  }
  const failed = new Set(first.failed.map((f) => f.panelId));
  let reviewed = 0;
  let flagged = 0;
  let rounds = 0;
  if (settings.review.autoInEpisode && settings.review.rounds > 0) {
    const newSeed = deps.newSeed ?? randomSeed;
    let batch = current().filter((p) => !failed.has(p.id) && p.activeImageId !== null && store.images.get(p.activeImageId)?.review == null);
    for (let round = 1; round <= settings.review.rounds && batch.length > 0; round++) {
      const results = await reviewAll(deps, ctx, run, batch, leftovers, jobIds, round);
      reviewed += results.length;
      const bad = results.filter((r) => !r.review.pass);
      if (bad.length === 0) break;
      rounds = round;
      flagged += bad.length;
      const again = await generateAll(
        deps, ctx, run,
        bad.map((b) => ({ panelId: b.panel.id, patch: retryPatch(b.review.issues, settings, newSeed(), retryTarget(store, settings, b.panel)) })),
        leftovers, jobIds, `Re-rendering ${bad.length} flagged panels (round ${round})`,
      );
      batch = current().filter((p) => again.done.has(p.id));
    }
  }
  return { jobs: jobIds, reviewed, flagged, rounds };
}

/**
 * Step 6 (spec §8), with W1's stops. The step's token (startedAt) marks what is done: panels rendered since it are skipped,
 * so a retry, a Continue and a resume all render only what is left.
 * - C2: with the preview off, a render whose estimate exceeds settings.episode.confirmRenderMinutes stops before any GPU
 *   work with `{confirm, panels, estimateSeconds}`.
 * - Q2: with the preview on, the cover and page 1 render first, then the step stops with `{preview, remainingPanels,
 *   estimateSeconds}` (no stop when nothing else is left).
 * A stop is returned as the output; the runner waits at awaiting-review in both modes. Continue keeps that output on the
 * step and dispatches it again, so `stopped` is true and no second stop happens.
 */
export async function runRenderStep(deps: DriverDeps, ctx: JobContext, run: EpisodeRun): Promise<RenderOutput> {
  const { store } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const settings = store.settings.get();
  const step = run.steps[stepIndex('render')];
  const token = step?.startedAt ?? null;
  const entries = chapterPanels(store, chapter.id, manga.readingDirection);
  if (entries.length === 0) throw new PermanentError('Nothing to render: the chapter has no panels yet (the scripts step creates them)');
  const ids = entries.map((e) => e.panel.id);
  const current = (): Panel[] => ids.map((id) => store.panels.require(id));
  const withoutImage = (among?: ReadonlySet<string>): string[] =>
    current().filter((p) => p.activeImageId === null && (among === undefined || among.has(p.id))).map((p) => p.id);
  const pendingWith = (leftovers: Leftovers): Panel[] =>
    current().filter((p) => !renderedSince(store, p, token) || leftovers.hasGenerate(p.id));
  const stopped = renderGate(step?.output) !== null;
  const previewFirst = run.input.previewFirst === true;

  if (!stopped && !previewFirst) {
    const todo = pendingWith(new Leftovers(liveJobs(store, run.id)));
    const estimateSeconds = estimateRender(store, settings, manga, todo);
    if (estimateSeconds > settings.episode.confirmRenderMinutes * 60) {
      return { ...NOTHING_RENDERED, failedPanelIds: [], confirm: true, panels: todo.length, estimateSeconds };
    }
  }

  await ensurePortraits(deps, ctx, run, manga.id, current());
  // Panels rendered since this step started are done; one with an unfinished job of an earlier attempt is adopted (F11).
  const leftovers = new Leftovers(liveJobs(store, run.id));
  const todo = pendingWith(leftovers);
  const label = (panels: Panel[], what: string): string => `${what} · est. ${formatEstimate(estimateRender(store, settings, manga, panels))}`;

  if (!stopped && previewFirst) {
    const first = new Set(entries.filter((e) => e.isCover || e.pageNumber === 1).map((e) => e.panel.id));
    const rest = todo.filter((p) => !first.has(p.id));
    if (rest.length > 0) {
      const now = todo.filter((p) => first.has(p.id));
      const phase = await renderPanels(deps, ctx, run, current, now, leftovers, label(now, `Rendering page 1 and the cover: ${now.length} panels`));
      return {
        ...phase, failedPanelIds: withoutImage(first), preview: true, remainingPanels: rest.length,
        estimateSeconds: estimateRender(store, settings, manga, rest),
      };
    }
  }

  const phase = await renderPanels(deps, ctx, run, current, todo, leftovers, label(todo, `Rendering ${todo.length} panels`));
  return { ...phase, failedPanelIds: withoutImage() };
}
```

The existing tests expect the first label to be `Rendering 5 panels · est. …`, and `label(todo, 'Rendering 5 panels')` produces exactly that.

- [ ] **Step 5: Teach the runner about the stops** in `packages/server/src/workflows/episode/runner.ts`. Add `renderGate` to the shared import, then:

```ts
  approve(runId: string): EpisodeRun {
    const run = this.get(runId);
    const idx = run.currentStep;
    if (run.status !== 'awaiting-review' || run.steps[idx]?.status !== 'awaiting-review') {
      throw new ConflictError('nothing to approve: the run is not waiting for review');
    }
    if (renderGate(run.steps[idx]!.output) !== null) return this.continueRender(run, idx);
    // ... the rest unchanged
  }

  /**
   * W1 Q2/C2: Continue at the preview or size stop. The same step renders the rest: it keeps its token, so the panels
   * rendered so far are skipped, and it keeps the stop as its output, so the driver does not stop again.
   */
  private continueRender(run: EpisodeRun, idx: number): EpisodeRun {
    this.save(run, { status: 'running', steps: patchStep(run.steps, idx, { status: 'pending', finishedAt: null }) });
    this.dispatch(run.id);
    return this.get(run.id);
  }

  private complete(runId: string, idx: number, output: unknown): void {
    const run = this.get(runId);
    // W1 Q2/C2: the render step's preview and size stops wait for the user in both modes.
    const pause = renderGate(output) !== null || (REVIEW_POINTS.has(EPISODE_STEPS[idx]!) && run.mode === 'review');
    const steps = patchStep(run.steps, idx, { status: pause ? 'awaiting-review' : 'done', output, error: null, finishedAt: nowIso() });
    const saved = this.save(run, pause ? { steps, status: 'awaiting-review' } : { steps });
    if (!pause) this.accept(saved, idx);
  }
```

`autopilot(runId)` needs no change. It sets the mode and then calls `approve`, so "Run to end" at the preview continues the render.

- [ ] **Step 6: Update the API-started tests** so they keep running straight through. Starts through the API now preview by default.
- `packages/server/test/episode-autopilot.test.ts` `setup`: add `previewFirst: false` to `input`.
- `packages/server/test/episode-routes.test.ts`: add `previewFirst: false` to any start whose run passes the render step with 2+ pages. The current tests use `pages: 1`, where the preview never stops, so there may be none.
- Run `npx vitest run packages/server/test packages/cli/test` and fix every test that now stops at `awaiting-review` with a preview output, the same way. `cli/test/episode-commands.test.ts` uses `--pages 1`, so it keeps finishing.
- `e2e/episode-export.spec.ts` is fixed in Task 10.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run packages/shared packages/server packages/cli`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared packages/server packages/cli/test
git commit -m "feat(episode): failed panels no longer stop a render; page 1 preview and the long-render confirmation stop the render step (W1 R1, Q2, C2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pause and resume a render (C1), and re-render the panels that have no image (R1)

**Files:**
- Modify: `packages/server/src/workflows/episode/runner.ts` (`pause`, `resumeRun`, `cancel`)
- Create: `packages/server/src/workflows/episode/missing.ts`
- Modify: `packages/server/src/workflows/episode/routes.ts`, `packages/server/src/workflows/episode/module.ts`
- Test: `packages/server/test/episode-runner.test.ts`, create `packages/server/test/episode-missing.test.ts`, `packages/server/test/episode-routes.test.ts`

**Interfaces:**
- Consumes:
  - `paused` statuses, `MissingPanels` and `JobRef` (Task 2);
  - `renderGate` (Task 4);
  - `chapterPanels`.
- Produces:
  - `EpisodeRunner.pause(runId: string): EpisodeRun`. It throws `ConflictError` unless the run is `running` at the render step and that step is `running`.
  - `EpisodeRunner.resumeRun(runId: string): EpisodeRun`. It throws `ConflictError` unless the run is `paused`.
  - `missingPanelIds(store: Store, chapterId: string): string[]`.
  - `renderMissing(store: Store, queue: Pick<JobQueue, 'enqueue'>, chapterId: string): JobRef[]`.
  - Routes:
    - `POST /api/episodes/:id/pause` → `EpisodeRun`;
    - `POST /api/episodes/:id/resume` → `EpisodeRun`;
    - `GET /api/chapters/:id/render-missing` → `MissingPanels`;
    - `POST /api/chapters/:id/render-missing` → `JobRef[]`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/episode-runner.test.ts` (append):

```ts
describe('EpisodeRunner — pause and resume (W1 C1)', () => {
  const RENDER = stepIndex('render');

  /** An autopilot run at the render step with its image jobs queued (imaging off): the driver waits on them. */
  async function rendering() {
    const { chapter, input } = world();
    const r = rig({ imaging: false });
    const run = r.runner.start(chapter.id, input, 'autopilot');
    await vi.waitFor(() => expect(r.runner.get(run.id).steps[RENDER]!.status).toBe('running'));
    await vi.waitFor(() => expect(r.queue.jobs('image.generate').some((j) => j.status === 'queued')).toBe(true));
    return { ...r, chapter, run: r.runner.get(run.id) };
  }
  const renderJobs = (queue: FakeQueue): Job[] => queue.jobs('llm.step').filter((j) => (j.payload as { step?: string }).step === 'render');

  it('pause stops the driver, cancels the queued image jobs and keeps the token; the chapter stays generating', async () => {
    const { runner, queue, run, chapter } = await rendering();
    const token = run.steps[RENDER]!.startedAt;
    const paused = runner.pause(run.id);
    expect(paused.status).toBe('paused');
    expect(paused.steps[RENDER]).toMatchObject({ status: 'paused', startedAt: token, error: null });
    await queue.idle();
    expect(renderJobs(queue).map((j) => j.status)).toEqual(['cancelled']);
    expect(queue.jobs('image.generate').every((j) => j.status === 'cancelled')).toBe(true);
    expect(runner.get(run.id).status).toBe('paused'); // the cancelled step job did not fail the step
    expect(lib.store.chapters.require(chapter.id).status).toBe('generating');
  });

  it('resume re-dispatches the render step with its token', async () => {
    const { runner, queue, run } = await rendering();
    const token = run.steps[RENDER]!.startedAt;
    runner.pause(run.id);
    await queue.idle();
    const resumed = runner.resumeRun(run.id);
    expect(resumed.status).toBe('running');
    expect(resumed.steps[RENDER]).toMatchObject({ status: 'running', startedAt: token });
    expect(renderJobs(queue).map((j) => j.status)).toEqual(['cancelled', expect.stringMatching(/queued|running/)]);
  });

  it('a result that arrives after the pause is discarded; resume then completes the step', async () => {
    const { runner, queue, run } = await rendering();
    const [job] = renderJobs(queue);
    runner.pause(run.id);
    await queue.idle();
    // The driver's own completion racing the pause: handleStepJob sees a paused run and skips.
    expect(await runner.handleStepJob(fakeJobContext(lib.store, bus, queue, job!), job!.payload as LlmStepPayload)).toEqual({ skipped: true });
    expect(runner.get(run.id).steps[RENDER]!.status).toBe('paused');
  });

  it('refuses to pause a run that is not rendering, and to resume one that is not paused', () => {
    const { chapter, input } = world();
    const { runner } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'autopilot'); // premise running
    expect(() => runner.pause(run.id)).toThrow(ConflictError);
    expect(() => runner.resumeRun(run.id)).toThrow(ConflictError);
  });

  it('a restart leaves a paused run paused', async () => {
    const { runner, queue, run, engines } = await rendering();
    runner.pause(run.id);
    await queue.idle();
    const before = queue.jobs('llm.step').length;
    const restarted = new EpisodeRunner({ store: lib.store, bus, queue: queue.asQueue(), engines });
    expect(restarted.resume()).toBe(0);
    expect(queue.jobs('llm.step')).toHaveLength(before);
    expect(restarted.get(run.id).status).toBe('paused');
  });

  it('cancel ends a paused run and marks its paused step Cancelled', async () => {
    const { runner, queue, run, chapter } = await rendering();
    runner.pause(run.id);
    await queue.idle();
    const cancelled = runner.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[RENDER]).toMatchObject({ status: 'failed', error: 'Cancelled' });
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
  });
});
```

Create `packages/server/test/episode-missing.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stepIndex, type ImageGeneratePayload } from '@manga/shared';
import { ConflictError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import { materializeScripts } from '../src/workflows/episode/effects.js';
import { missingPanelIds, renderMissing } from '../src/workflows/episode/missing.js';
import { patchStep } from '../src/workflows/episode/steps.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let queue: FakeQueue;
beforeEach(() => { lib = openTestLibrary(); queue = new FakeQueue(lib.store); });
afterEach(() => { lib.close(); });

/** Two story pages of two panels plus the cover; the first story panel has an image. */
function world() {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  seedCharacter(lib.store, manga.id, 'Aiko');
  const bd = breakdown(2);
  materializeScripts({ store: lib.store, bus: new EventBus() }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
  const ids = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  lib.store.panels.update(ids[0]!, { activeImageId: seedImage(lib.store, manga.id, { type: 'panel', id: ids[0]! }, null).id });
  return { manga, chapter, ids, bd };
}

describe('render-missing (W1 R1)', () => {
  it('lists the story and cover panels without an image, cover last', () => {
    const { chapter, ids } = world();
    expect(missingPanelIds(lib.store, chapter.id)).toEqual(ids.slice(1));
  });

  it('queues one gpu generate job per missing panel, tagged with the latest run', () => {
    const { chapter, ids, bd } = world();
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd }, status: 'failed' });
    const refs = renderMissing(lib.store, queue.asQueue(), chapter.id);
    expect(refs).toHaveLength(4);
    const jobs = queue.jobs('image.generate');
    expect(jobs.map((j) => (j.payload as ImageGeneratePayload & { panelId: string }).panelId)).toEqual(ids.slice(1));
    expect(jobs.every((j) => j.lane === 'gpu' && j.episodeRunId === run.id)).toBe(true);
  });

  it('works without a run (untagged) and skips a panel that already has an unfinished generate job, tagged or not', () => {
    const { chapter, ids } = world();
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4); // no run: untagged
    expect(queue.jobs('image.generate').every((j) => j.episodeRunId === null)).toBe(true);
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toEqual([]); // a second click queues no duplicates
    for (const j of queue.jobs('image.generate')) queue.fail(j.id, 'ComfyUI down');
    const run = seedRun(lib.store, chapter.id, { status: 'failed' });
    queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: ids[1]! }, episodeRunId: run.id });
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(3);
  });

  it('refuses while the episode render step is running or paused; allowed at its preview stop', () => {
    const { chapter } = world();
    const run = seedRun(lib.store, chapter.id, { currentStep: 'render' });
    const at = (status: 'running' | 'paused' | 'awaiting-review') =>
      lib.store.episodes.update(run.id, { status: status === 'awaiting-review' ? 'awaiting-review' : status, steps: patchStep(run.steps, stepIndex('render'), { status }) });
    at('running');
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    at('paused');
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    at('awaiting-review');
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4);
  });
});
```

`packages/server/test/episode-routes.test.ts` (append inside the describe):

```ts
it('render-missing: GET lists the panels without an image, POST queues them and the list empties (W1 R1)', async () => {
  s = await startM4TestServer();
  const { chapter } = await chapterOn(s);
  const page = (await s.api<{ id: string }>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: TWO_PANEL_PRESET })).body;
  const missing = (await s.api<{ panelIds: string[] }>('GET', `/api/chapters/${chapter.id}/render-missing`)).body;
  expect(missing.panelIds).toHaveLength(2);
  const refs = (await s.api<Array<{ jobId: string }>>('POST', `/api/chapters/${chapter.id}/render-missing`)).body;
  expect(refs).toHaveLength(2);
  await s.until(async () => (await s!.api<{ panelIds: string[] }>('GET', `/api/chapters/${chapter.id}/render-missing`)).body.panelIds.length === 0);
  expect(page.id).toMatch(/^pg_/);
});

it('pause and resume answer 409 when the run is not rendering or not paused (W1 C1)', async () => {
  s = await startM4TestServer();
  const { chapter } = await chapterOn(s);
  const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
  await runUntil(s, chapter.id, 'awaiting-review', 1);
  const pause = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/pause`);
  expect([pause.status, pause.body.error.code]).toEqual([409, 'conflict']);
  const resume = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/resume`);
  expect([resume.status, resume.body.error.code]).toEqual([409, 'conflict']);
});
```

(The route test for the pause itself is the CLI test in Task 7, which drives a slow fake ComfyUI.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/episode-runner.test.ts packages/server/test/episode-missing.test.ts packages/server/test/episode-routes.test.ts`
Expected: FAIL. `pause`, `resumeRun` and `missing.js` are missing.

- [ ] **Step 3: Implement pause, resume and cancel** in `runner.ts`:

```ts
  /**
   * W1 C1: pause a rendering run. The step is saved paused first, with its token, so the step job's cancellation below
   * never fails it (failStep only fails a running step). Then the driver's job is cancelled (it ends `cancelled`) and the
   * run's queued image jobs (generate, review, portraits) are dropped; a running image finishes, and resume skips the panel
   * it rendered. The chapter stays `generating`.
   */
  pause(runId: string): EpisodeRun {
    const run = this.get(runId);
    const idx = run.currentStep;
    if (run.status !== 'running' || EPISODE_STEPS[idx] !== 'render' || run.steps[idx]?.status !== 'running') {
      throw new ConflictError('only a run that is rendering images can be paused');
    }
    const saved = this.save(run, { status: 'paused', steps: patchStep(run.steps, idx, { status: 'paused' }) });
    const driver = this.findStepJob(run.id, 'render');
    if (driver) this.deps.queue.cancel(driver.id);
    for (const job of this.deps.store.jobs.listByEpisodeRun(run.id)) {
      if (job.status === 'queued' && job.kind.startsWith('image.')) this.deps.queue.cancel(job.id);
    }
    return saved;
  }

  /** W1 C1: resume a paused run: the render step is dispatched again with its token kept, like a retry. */
  resumeRun(runId: string): EpisodeRun {
    const run = this.get(runId);
    const idx = run.currentStep;
    if (run.status !== 'paused' || run.steps[idx]?.status !== 'paused') throw new ConflictError(`the run is ${run.status}, not paused`);
    this.save(run, { status: 'running', steps: patchStep(run.steps, idx, { status: 'pending', error: null }) });
    this.dispatch(run.id);
    return this.get(run.id);
  }
```

In `cancel`, mark a paused step too:

```ts
    const steps = run.steps.map((s) => (s.status === 'running' || s.status === 'paused'
      ? { ...s, status: 'failed' as const, error: 'Cancelled', finishedAt: nowIso() } : s));
```

`resume()` at boot needs no change. It skips every run whose status is not `running`, so a paused run stays paused. Update its doc comment to say so.

- [ ] **Step 4: Create `packages/server/src/workflows/episode/missing.ts`**

```ts
import { stepIndex, type ImageGeneratePayload, type JobRef } from '@manga/shared';
import { ConflictError } from '../../errors.js';
import { isTerminal, type JobQueue } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';

/** W1 R1: the chapter's story panels and cover panel without an active image, in reading order, the cover last. */
export function missingPanelIds(store: Store, chapterId: string): string[] {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  return chapterPanels(store, chapterId, manga.readingDirection).filter((e) => e.panel.activeImageId === null).map((e) => e.panel.id);
}

/** How many unfinished jobs per status the duplicate check reads (a busy queue holds a few hundred at most). */
const UNFINISHED_SCAN = 500;

/**
 * W1 R1 "Re-render failed panels": one `image.generate` per panel without an image, tagged with the chapter's latest run
 * (so its cancel, pause and the render step's adoption see them). A panel that already has an unfinished generate job
 * (this run's, an earlier click's, or the editor's) is skipped. While the run's render step is running or paused the
 * driver owns those panels: 409.
 */
export function renderMissing(store: Store, queue: Pick<JobQueue, 'enqueue'>, chapterId: string): JobRef[] {
  const missing = missingPanelIds(store, chapterId);
  const run = store.episodes.latestByChapter(chapterId);
  const render = run?.steps[stepIndex('render')];
  if (run && run.currentStep === stepIndex('render') && (render?.status === 'running' || render?.status === 'paused')) {
    throw new ConflictError('the episode is rendering this chapter; resume or wait for it');
  }
  const unfinished = [...store.jobs.list({ status: 'queued', limit: UNFINISHED_SCAN }), ...store.jobs.list({ status: 'running', limit: UNFINISHED_SCAN })];
  const queued = new Set(unfinished
    .filter((j) => j.kind === 'image.generate' && !isTerminal(j.status))
    .map((j) => j.payload as ImageGeneratePayload)
    .flatMap((p) => (p.target === 'panel' ? [p.panelId] : [])));
  return missing.filter((id) => !queued.has(id)).map((panelId) => {
    const payload: ImageGeneratePayload = { target: 'panel', panelId };
    return { jobId: queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run?.id ?? null }).id };
  });
}
```

- [ ] **Step 5: Add the routes**

In `routes.ts`:
- Change the deps to `{ store: Store; bus: EventBus; queue: Pick<JobQueue, 'enqueue'>; runner: EpisodeRunner }`.
- Import `JobQueue` from `../../jobs/index.js`, `missingPanelIds` and `renderMissing` from `./missing.js`, and `type JobRef` and `type MissingPanels` from `@manga/shared`.
- Add:

```ts
  app.post<IdParams>('/api/episodes/:id/pause', async (req): Promise<EpisodeRun> => runner.pause(req.params.id));
  app.post<IdParams>('/api/episodes/:id/resume', async (req): Promise<EpisodeRun> => runner.resumeRun(req.params.id));
  app.get<IdParams>('/api/chapters/:id/render-missing', async (req): Promise<MissingPanels> => ({ panelIds: missingPanelIds(store, req.params.id) }));
  app.post<IdParams>('/api/chapters/:id/render-missing', async (req): Promise<JobRef[]> => renderMissing(store, queue, req.params.id));
```

In `module.ts`, change the call to `registerEpisodeRoutes(app, { store: deps.store, bus: deps.bus, queue: deps.queue, runner })`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run packages/server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(episode): pause and resume a render; re-render the panels without an image (W1 C1, R1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Story memory (Q1) and the panel cap in the breakdown prompt (C2)

**Files:**
- Modify: `packages/server/src/workflows/episode/context.ts`, `requests.ts`, `llm.ts`, `prompts.ts`, `runner.ts`, `module.ts`
- Create: `packages/server/src/workflows/episode/summary.ts`, `packages/server/src/prompts/episode/summary.md`
- Modify: `packages/server/src/prompts/episode/{premise,outline,breakdown,scripts,prompts}.md`
- Modify: `packages/server/src/dev/fake-episode.ts`
- Test:
  - `packages/server/test/episode-prompts.test.ts`, `packages/server/test/episode-requests.test.ts`
  - create `packages/server/test/episode-summary.test.ts`
  - `packages/server/test/episode-runner.test.ts` (the rig's `llm.step` handler, and the autopilot job list)

**Interfaces:**
- Consumes:
  - `Chapter.summary`, the `chapter-summary` payload and `EpisodeInput` (Task 2);
  - `loadPrompt`;
  - `engines.forLane` / `engines.laneFor`.
- Produces (in `context.ts`):
  - the constants `STORY_SO_FAR_LIMIT = 3000`, `PREVIOUS_PAGE_LIMIT = 800` and `PREVIOUS_CHAPTERS_LIMIT = 10`;
  - `storyDigest(pages: ScriptsOutput['pages'], firstPage: number, limit?: number): string`;
  - `pageActions(panels: Array<{ action: string }>, limit?: number): string`;
  - `previousChapters(store: Store, chapter: Chapter): ChapterBrief[]`;
  - `interface ChapterBrief { number: number; title: string; synopsis: string }`.
- Context types:
  - `PremiseContext.previousChapters` and `OutlineContext.previousChapters`: `ChapterBrief[]`;
  - `ScriptsContext.storySoFar?: string`;
  - `PromptsContext.previousPage?: string`;
  - `SummaryContext`, which joins the `StepContext` union.
- `StepRequest.promptFor?: (previous: readonly unknown[]) => string`. When it is set, `executeLlmStep` uses it with the answers so far.
- `loadStepPrompt(step: LlmStepName | 'summary')`.
- In `summary.ts`:
  - `ChapterSummaryAnswerSchema`;
  - `SUMMARY_STORY_LIMIT = 12000`;
  - `writeChapterSummary(deps: { store: Store; bus: EventBus; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: Extract<LlmStepPayload, { type: 'chapter-summary' }>): Promise<{ summary: string } | { skipped: true }>`.
- `EpisodeRunner.handleSummaryJob(ctx, payload)`. The runner queues one `llm.step {type:'chapter-summary'}` job, with `lane: laneFor('story')` and `maxAttempts: 2`, when a run becomes `done`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/episode-prompts.test.ts` (append; import `storyDigest`, `pageActions`, `STORY_SO_FAR_LIMIT`, `PREVIOUS_PAGE_LIMIT` and `buildStepContext` from `../src/workflows/episode/context.js`):

```ts
describe('story memory (W1 Q1)', () => {
  it('storyDigest: each page\'s actions one line each, its dialogue as "speaker: text", the most recent pages kept', () => {
    const sc = scripts(breakdown(2), 'Aiko');
    expect(storyDigest(sc.pages, 1)).toBe([
      'Page 1:', '- Page 1 panel 1', '  Aiko: Line 1.1', '- Page 1 panel 2', '  Aiko: Line 1.2',
      'Page 2:', '- Page 2 panel 1', '  Aiko: Line 2.1', '- Page 2 panel 2', '  Aiko: Line 2.2',
    ].join('\n'));
    expect(storyDigest(scripts(breakdown(1), null).pages, 5)).toContain('  narration: Narration 1.1');
    const long = storyDigest(scripts(breakdown(200), 'Aiko').pages, 1);
    expect(long.length).toBeLessThanOrEqual(STORY_SO_FAR_LIMIT);
    expect(long.endsWith('  Aiko: Line 200.2')).toBe(true);
    expect(long).not.toContain('Page 1:\n');
  });

  it('pageActions joins actions and caps them', () => {
    expect(pageActions([{ action: 'Aiko runs.' }, { action: 'The cat hides.' }])).toBe('Aiko runs. / The cat hides.');
    expect(pageActions([{ action: 'x'.repeat(2000) }]).length).toBe(PREVIOUS_PAGE_LIMIT);
  });

  it('premise and outline see the earlier chapters by number, the summary over the synopsis, at most the last 10', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    lib.store.chapters.update(chapter.id, { number: 12 });
    for (let n = 1; n <= 11; n++) {
      lib.store.chapters.create({ mangaId: manga.id, number: n, title: `C${n}`, synopsis: `syn ${n}`, coverPageId: null, status: 'ready', order: n, summary: n === 11 ? 'what happened in 11' : '' });
    }
    lib.store.chapters.create({ mangaId: manga.id, number: 13, title: 'Later', synopsis: 'later', coverPageId: null, status: 'draft', order: 13 });
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE } });
    for (const step of ['premise', 'outline'] as const) {
      const ctx = buildStepContext(lib.store, run, step) as { previousChapters: Array<{ number: number; title: string; synopsis: string }> };
      expect(ctx.previousChapters.map((c) => c.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(ctx.previousChapters.at(-1)).toEqual({ number: 11, title: 'C11', synopsis: 'what happened in 11' });
      expect(ctx.previousChapters[0]).toEqual({ number: 2, title: 'C2', synopsis: 'syn 2' });
    }
  });
});
```

`packages/server/test/episode-requests.test.ts` (append; import `executeLlmStep` from `../src/workflows/episode/llm.js`, `ScriptedEngine` and `EPISODE_FAKE_RESPONSES`):

```ts
describe('story memory in requests (W1 Q1)', () => {
  it('a later scripts chunk carries storySoFar from the earlier chunks\' answers; the first has none', () => {
    const run = scriptsRun(6);
    const [first, second] = stepRequests(lib.store, run, 'scripts');
    expect(first!.promptFor).toBeUndefined();
    expect(extractContext<ScriptsContext>(first!.prompt).storySoFar).toBeUndefined();
    const answer = { pages: scripts(breakdown(6), 'Aiko').pages.slice(0, 4) };
    const ctx = extractContext<ScriptsContext>(second!.promptFor!([answer]));
    expect(ctx.storySoFar).toContain('Page 4:\n- Page 4 panel 1\n  Aiko: Line 4.1');
    expect(ctx.pages.map((p) => p.page)).toEqual([5, 6]);
  });

  it('executeLlmStep sends each chunk the story written by the chunks before it', async () => {
    const run = scriptsRun(6);
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const ctx = { job: { lane: 'claude' }, signal: new AbortController().signal, progress: () => undefined } as unknown as JobContext;
    await executeLlmStep({ store: lib.store, engines: { forLane: () => engine } }, ctx, run, 'scripts');
    expect(engine.calls).toHaveLength(2);
    expect(extractContext<ScriptsContext>(engine.calls[1]!.prompt).storySoFar).toMatch(/^Page 1:\n/);
  });

  it('a prompts request for page 2 carries page 1\'s actions as previousPage; page 1 and the cover carry none', () => {
    const run = promptsRun(); // the file's existing helper for a materialized 2-page chapter with a cover; else build it as the prompts tests do
    const requests = stepRequests(lib.store, run, 'prompts');
    const contexts = requests.map((r) => extractContext<PromptsContext>(r.prompt));
    expect(contexts[0]!.previousPage).toBeUndefined();
    expect(contexts[1]!.previousPage).toBe('Page 1 panel 1 / Page 1 panel 2');
    expect(contexts.at(-1)!.panels[0]!.isCover).toBe(true);
    expect(contexts.at(-1)!.previousPage).toBeUndefined();
  });

  it('the breakdown prompt aims for 3–5 panels per page and never more than 6', () => {
    const { system } = loadStepPrompt('breakdown');
    expect(system).toContain('3–5 panels');
    expect(system).toContain('never has more than 6 panels');
    expect(system).not.toContain('9');
  });
});
```

(If the file has no `promptsRun` helper, add one: seed a world, `materializeScripts` a 2-page breakdown with `scripts(breakdown(2), 'Aiko')` and `PREMISE`, and `seedRun` with outputs up to scripts.)

Create `packages/server/test/episode-summary.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmStepPayload, ServerEvent } from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { EventBus } from '../src/events/bus.js';
import { extractContext, type SummaryContext } from '../src/workflows/episode/context.js';
import { writeChapterSummary } from '../src/workflows/episode/summary.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => { lib = openTestLibrary(); bus = new EventBus(); events = []; bus.on((e) => { events.push(e); }); });
afterEach(() => { lib.close(); });

function doneRun() {
  const { chapter } = seedEpisodeWorld(lib.store);
  const bd = breakdown(2);
  const run = seedRun(lib.store, chapter.id, {
    outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') }, status: 'done',
  });
  return { chapter, run };
}

const summaryJob = (run: { id: string; chapterId: string }) => {
  const payload: LlmStepPayload = { type: 'chapter-summary', chapterId: run.chapterId, runId: run.id };
  const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'claude', payload, priority: 0, maxAttempts: 2, nextRunAt: new Date().toISOString(), episodeRunId: run.id });
  return { job, payload: payload as Extract<LlmStepPayload, { type: 'chapter-summary' }> };
};

describe('chapter summary (W1 Q1)', () => {
  it('writes chapter.summary with one story call on the job\'s lane engine and emits chapter updated once', async () => {
    const { chapter, run } = doneRun();
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const { job, payload } = summaryJob(run);
    const ctx = fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job);
    const out = await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, ctx, payload);
    expect(out).toMatchObject({ summary: expect.any(String) });
    expect(lib.store.chapters.require(chapter.id).summary).toBe((out as { summary: string }).summary);
    expect(engine.calls.map((c) => [c.name, c.task])).toEqual([['episode.summary', 'story']]);
    const sent = extractContext<SummaryContext>(engine.calls[0]!.prompt);
    expect(sent.story).toContain('Page 1:\n- Page 1 panel 1');
    expect(engine.calls[0]!.system.length).toBeLessThan(1500); // G2: the story goes in the prompt, not the system prompt
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'chapter' && e.id === chapter.id)).toHaveLength(1);
  });

  it('skips a run that is no longer the finished latest one', async () => {
    const { chapter, run } = doneRun();
    lib.store.episodes.update(run.id, { status: 'running' });
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const { job, payload } = summaryJob(run);
    const out = await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job), payload);
    expect(out).toEqual({ skipped: true });
    expect(engine.calls).toEqual([]);
    expect(lib.store.chapters.require(chapter.id).summary).toBe('');
  });
});
```

In `packages/server/test/episode-runner.test.ts`:
- In `rig`, route the summary job: `queue.on('llm.step', (job, signal) => { const p = job.payload as LlmStepPayload; const ctx = fakeJobContext(lib.store, bus, queue, job, signal); return p.type === 'chapter-summary' ? runner.handleSummaryJob(ctx, p) : runner.handleStepJob(ctx, p); })`.
- In the test "autopilot runs every step to the end…", change the job mapper to `(j.payload as { step?: string; type: string }).step ?? (j.payload as { type: string }).type`.
- Append `['chapter-summary', 'claude', 2]` to the expected list, then add `expect(lib.store.chapters.require(chapter.id).summary).not.toBe('');`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/episode-prompts.test.ts packages/server/test/episode-requests.test.ts packages/server/test/episode-summary.test.ts packages/server/test/episode-runner.test.ts`
Expected: FAIL. `storyDigest`, `previousChapters`, `promptFor` and `summary.js` are missing.

- [ ] **Step 3: Extend the contexts** in `packages/server/src/workflows/episode/context.ts`.

Import `ScriptsOutput` and `Chapter` types from `@manga/shared`.

```ts
export const STORY_SO_FAR_LIMIT = 3000;
export const PREVIOUS_PAGE_LIMIT = 800;
export const PREVIOUS_CHAPTERS_LIMIT = 10;

/** W1 Q1: an earlier chapter as the next chapter's premise and outline see it; `synopsis` is its summary when it has one. */
export interface ChapterBrief { number: number; title: string; synopsis: string }

// PremiseContext and OutlineContext: add `previousChapters: ChapterBrief[];`
// ScriptsContext: add `/** W1 Q1: the pages earlier chunks wrote (storyDigest); absent in the first chunk. */ storySoFar?: string;`
// PromptsContext: add `/** W1 Q1: the previous page's actions (pageActions), for visual continuity; absent on page 1 and the cover. */ previousPage?: string;`

/** W1 Q1: the context of the chapter summary call (summary.ts). */
export interface SummaryContext {
  step: 'summary'; language: Language; chapter: { number: number; title: string; synopsis: string }; story: string;
}
export type StepContext = PremiseContext | OutlineContext | BreakdownContext | ScriptsContext | PromptsContext | SummaryContext;

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/**
 * W1 Q1: pages already written, compact. Per page, its panels' actions (one line each) with each panel's dialogue under it as
 * "speaker: text" (narration and sfx name their kind). Whole pages are kept from the most recent back while they fit `limit`;
 * a single page longer than `limit` is clipped.
 */
export function storyDigest(pages: ScriptsOutput['pages'], firstPage: number, limit = STORY_SO_FAR_LIMIT): string {
  const blocks = pages.map((page, i) => [
    `Page ${firstPage + i}:`,
    ...page.panels.flatMap((p) => [`- ${p.action}`, ...p.dialogue.map((d) => `  ${d.speaker ?? d.kind}: ${d.text}`)]),
  ].join('\n'));
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const cost = block.length + (kept.length > 0 ? 1 : 0);
    if (size + cost > limit) {
      if (kept.length === 0) kept.push(clip(block, limit));
      break;
    }
    kept.unshift(block);
    size += cost;
  }
  return kept.join('\n');
}

/** W1 Q1: a page's panel actions on one line, capped (the prompts step's `previousPage`). */
export function pageActions(panels: ReadonlyArray<{ action: string }>, limit = PREVIOUS_PAGE_LIMIT): string {
  return clip(panels.map((p) => p.action.trim()).filter((a) => a !== '').join(' / '), limit);
}

/** W1 Q1: the manga's chapters numbered before `chapter`, oldest first, the last PREVIOUS_CHAPTERS_LIMIT. */
export function previousChapters(store: Store, chapter: Chapter): ChapterBrief[] {
  return store.chapters.listByManga(chapter.mangaId)
    .filter((c) => c.number < chapter.number)
    .sort((a, b) => a.number - b.number)
    .slice(-PREVIOUS_CHAPTERS_LIMIT)
    .map((c) => ({ number: c.number, title: c.title, synopsis: c.summary.trim() !== '' ? c.summary : c.synopsis }));
}
```

In `buildStepContext`:
- `premise` and `outline` both add `previousChapters: previousChapters(store, chapter)`.
- `scripts` stays as it is; the chunks add `storySoFar` in `requests.ts`.

`templateVars` is unchanged. `summary.ts` builds its own vars.

- [ ] **Step 4: Chunk prompts that see the earlier answers**

In `requests.ts`, add to `StepRequest`:

```ts
  /**
   * W1 Q1 (scripts chunks after the first): this call's prompt given the answers of the calls before it, whose pages
   * become the context's `storySoFar`. `prompt` is the same prompt without it. executeLlmStep uses this when set.
   */
  promptFor?: (previous: readonly unknown[]) => string;
```

Inside `stepRequests`, factor the user prompt out as `const userPrompt = (c: StepContext): string => renderTemplate(template.user, templateVars(store, run, c));` and use it in `request`. Change the scripts loop body to:

```ts
      const chunk: ScriptsContext = { ...ctx, pages, pageRange: { first, last, total } };
      const req = request(chunk, scriptsSchemaFor({ panelCounts: pages.map((p) => p.panelCount), knownNames: names, lenient: true, pageOffset: at }),
        total <= SCRIPTS_PAGES_PER_CALL ? STEP_PROGRESS.scripts : `Writing scripts (pages ${first}–${last} of ${total})…`);
      out.push(at === 0 ? req : {
        ...req,
        promptFor: (previous) => {
          const written = previous.flatMap((a) => ScriptsOutputSchema.parse(a).pages);
          return userPrompt({ ...chunk, storySoFar: storyDigest(written, 1) });
        },
      });
```

In the prompts branch, give each story page after the first `previousPage`:

```ts
    return groups.map((panels, g) => {
      const before = groups[g - 1];
      const previousPage = !panels[0]!.isCover && before !== undefined && !before[0]!.isCover ? pageActions(before) : '';
      const c: PromptsContext = { ...ctx, panels, ...(previousPage !== '' ? { previousPage } : {}) };
      return request(c, /* the schemas and progress as today */);
    });
```

(`PromptsPanelBrief` has `action`, so `pageActions(before)` type-checks. Import `storyDigest`, `pageActions` and `ScriptsContext` from `./context.js`.)

In `llm.ts`, in the request loop, change the destructuring to include `promptFor`, compute `const sent = promptFor ? promptFor(answers) : prompt;`, and pass `prompt: sent` to `completeJson`.

In `prompts.ts`, change `loadStepPrompt(step: LlmStepName | 'summary')`.

- [ ] **Step 5: The chapter summary**

Create `packages/server/src/prompts/episode/summary.md`:

```md
<!-- system -->
You summarise one chapter of a manga for the writer of the next chapter.

Rules:
- Write 3–5 sentences in {{languageName}}: what happened, who took part, and how the chapter ends. Name open threads.
- Use the characters' names exactly as they appear. No commentary and no quotes from the dialogue.

Reply with only a JSON object of exactly this shape, with no prose and no code fences:
{"summary": string}
<!-- user -->
The chapter, page by page, as data:
{{context}}
```

Create `packages/server/src/workflows/episode/summary.ts`:

```ts
import { z } from 'zod';
import { ScriptsOutputSchema, type LlmStepPayload } from '@manga/shared';
import type { Engines } from '../../engines/resolve.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { LANGUAGE_NAME, contextBlock, storyDigest, type SummaryContext } from './context.js';
import { loadStepPrompt, renderTemplate } from './prompts.js';
import { requireOutput } from './steps.js';

export const ChapterSummaryAnswerSchema = z.object({ summary: z.string().trim().min(1).max(1500) });
/** The story the summary call reads: much more than storySoFar, still a small call. */
export const SUMMARY_STORY_LIMIT = 12_000;

type SummaryPayload = Extract<LlmStepPayload, { type: 'chapter-summary' }>;

/**
 * W1 Q1: one small story-task call when an episode run finishes: 3–5 sentences of "what happened", in the book language,
 * written to chapter.summary (later chapters read it instead of the synopsis). Runs on the engine of the job's lane (I1);
 * the story is in the prompt's <context>, the system prompt stays small (G2). A run that is no longer the chapter's finished
 * latest run, or a chapter that is gone, is skipped. Emits `chapter updated` once.
 */
export async function writeChapterSummary(
  deps: { store: Store; bus: EventBus; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: SummaryPayload,
): Promise<{ summary: string } | { skipped: true }> {
  const { store, bus } = deps;
  const current = (): boolean => {
    const run = store.episodes.get(payload.runId);
    return run !== null && run.status === 'done' && store.chapters.get(payload.chapterId) !== null
      && store.episodes.latestByChapter(payload.chapterId)?.id === run.id;
  };
  if (!current()) return { skipped: true };
  const run = store.episodes.require(payload.runId);
  const chapter = store.chapters.require(payload.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const data: SummaryContext = {
    step: 'summary', language: manga.language,
    chapter: { number: chapter.number, title: chapter.title, synopsis: chapter.synopsis },
    story: storyDigest(requireOutput(run, 'scripts', ScriptsOutputSchema).pages, 1, SUMMARY_STORY_LIMIT),
  };
  const template = loadStepPrompt('summary');
  const vars = { context: contextBlock(data), languageName: LANGUAGE_NAME[manga.language] };
  ctx.progress('Summarising the chapter…');
  const { summary } = await deps.engines.forLane(ctx.job.lane).completeJson({
    name: 'episode.summary', task: 'story', system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
    schema: ChapterSummaryAnswerSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
  });
  if (ctx.signal.aborted || !current()) return { skipped: true };
  const updated = store.chapters.update(chapter.id, { summary });
  emitEntity(bus, 'chapter', updated.id, 'updated', updated.mangaId);
  return { summary };
}
```

Changes in `runner.ts`:
- Import `writeChapterSummary`.
- In `accept`, in the final-step branch, call `this.enqueueSummary(run);` right after `this.setChapterStatus(run.chapterId, 'ready');`.
- Add:

```ts
  /** The `llm.step {type:'chapter-summary'}` handler (W1 Q1). */
  handleSummaryJob(ctx: JobContext, payload: LlmStepPayload): Promise<unknown> {
    if (payload.type !== 'chapter-summary') throw new PermanentError(`not a chapter summary: ${payload.type}`);
    return writeChapterSummary({ store: this.deps.store, bus: this.deps.bus, engines: this.deps.engines }, ctx, payload);
  }

  /** W1 Q1: the finished run's chapter summary, on the story task's lane. A failure to queue never fails the finished run. */
  private enqueueSummary(run: EpisodeRun): void {
    try {
      const payload: LlmStepPayload = { type: 'chapter-summary', chapterId: run.chapterId, runId: run.id };
      this.deps.queue.enqueue({ kind: 'llm.step', lane: this.deps.engines.laneFor('story'), payload, episodeRunId: run.id, maxAttempts: 2 });
    } catch (err) {
      console.error('[manga] episode runner: could not queue the chapter summary', err);
    }
  }
```

In `module.ts`, add `registerLlmStep('chapter-summary', (ctx, payload) => runner.handleSummaryJob(ctx, payload));`.

In `packages/server/src/dev/fake-episode.ts`, add:

```ts
  'episode.summary': (req): { summary: string } => {
    const c = extractContext<SummaryContext>(req.prompt);
    return c.language === 'uk'
      ? { summary: `Розділ ${c.chapter.number}: ${c.chapter.title}. Айко знаходить кота під дощем і забирає його додому.` }
      : { summary: `Chapter ${c.chapter.number}: ${c.chapter.title}. Aiko finds a cat in the rain and takes it home.` };
  },
```

(Import `SummaryContext` in that file's existing context import.)

- [ ] **Step 6: Prompt rules**. The context is JSON, so these files gain rules and no new placeholders:
- `premise.md` and `outline.md`, under `Rules:`: `- "previousChapters" (may be empty) are this manga's earlier chapters, oldest first. This chapter follows them: keep names, facts and open threads consistent, and do not retell them.`
- `scripts.md`: `- "storySoFar", when present, is what the earlier pages of this chapter already showed and said. Continue from it; do not repeat it.`
- `prompts.md`: `- "previousPage", when present, is what the page before showed. Keep places, light and clothing consistent with it.`
- `breakdown.md`: replace the `"panelCount"` rule and the "one page never has more than 9 panels" clause:

```
- "panelCount": how many panels the page has (1–6). Aim for 3–5 panels per page: quiet dialogue pages 4–5, action pages 3–4; a big reveal or the final beat may use 1–2.
- If the request asks for a panel count or a layout, follow it; it overrides the guidance above. A panel count in the request is per page unless the request says otherwise (for example "12 panels in the whole chapter": spread them over the pages), and one page never has more than 6 panels.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run packages/server`
Expected: PASS. If another server test lists every `llm.step` job of a finished run, it now also sees the summary job. Filter those by `payload.type === 'episode'`.

- [ ] **Step 8: Commit**

```bash
git add packages/server
git commit -m "feat(episode): story memory: storySoFar across script chunks, previousPage, previousChapters and a chapter summary when a run finishes; breakdown aims for 3–5 panels (W1 Q1, C2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: CLI — `--no-preview`, the estimate, pause/resume, render-missing, queue pause/resume, `--summary`

**Files:**
- Modify: `packages/cli/src/commands/episode.ts`, `packages/cli/src/commands/chapters.ts`
- Create: `packages/cli/src/commands/queue.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/episode-commands.test.ts`

**Interfaces:**
- Consumes:
  - `formatChapterEstimate`, `QueueLanes` and `GPU_MANUAL_PAUSE_REASON` (Task 2);
  - the routes of Tasks 3 and 5;
  - `jobLine(job)` from `packages/cli/src/commands/jobs.ts`;
  - `CliContext.wait` and `CliContext.waitJobs`.
- Produces:
  - `manga episode start … [--no-preview]`: it sends `previewFirst`, and prints the chapter estimate to stderr unless `--json`;
  - `manga episode pause <chapter>` and `manga episode resume <chapter>`;
  - `manga chapter render-missing <chapter> [--wait]`;
  - `manga chapter edit <chapter> --summary <text>`;
  - `manga queue pause <lane>` and `manga queue resume <lane>`, where the lane must be `gpu`;
  - `registerQueueCommands(program: Command, ctx: () => Promise<CliContext>): void`.

- [ ] **Step 1: Write the failing tests** (append to `packages/cli/test/episode-commands.test.ts`).

In `manga()`, register `registerChapterCommands(root, async () => ctx)` and `registerQueueCommands(root, async () => ctx)`.

```ts
describe('manga W1 commands', { timeout: 90_000 }, () => {
  beforeEach(() => serve());

  it('episode start previews by default, --no-preview turns it off, and the estimate goes to stderr', async () => {
    const a = await world();
    await run(['episode', 'start', a.chapter.id, '--prompt', 'A cat', '--pages', '8']);
    expect(last<EpisodeRun>().input.previewFirst).toBe(true);
    expect(stderr[0]).toBe('8 pages ≈ 36 panels ≈ 37 min\n');
    const b = await world();
    await run(['episode', 'start', b.chapter.id, '--prompt', 'A cat', '--no-preview']);
    expect(last<EpisodeRun>().input.previewFirst).toBe(false);
  });

  it('episode pause and resume a rendering run', async () => {
    s.fake.loadDelayMs = 1_500; // each image takes a while: the render step is caught running
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '2', '--autopilot', '--no-preview']);
    await s.until(async () => {
      const r = await latest(chapter.id);
      return r?.status === 'running' && r.currentStep === 5 && r.steps[5]!.status === 'running';
    });
    await run(['episode', 'pause', chapter.id]);
    expect(last<EpisodeRun>().status).toBe('paused');
    await run(['episode', 'resume', chapter.id]);
    expect(last<EpisodeRun>().status).toBe('running');
    await run(['episode', 'cancel', chapter.id]);
  });

  it('chapter render-missing --wait renders the panels without an image; a second call has nothing to do', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    await run(['chapter', 'render-missing', chapter.id], true);
    expect(last<Job[]>().map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    await run(['chapter', 'render-missing', chapter.id], true);
    expect(last<Job[]>()).toEqual([]);
  });

  it('chapter edit --summary patches the summary', async () => {
    const { chapter } = await world();
    await run(['chapter', 'edit', chapter.id, '--summary', 'Aiko found the cat.']);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.summary).toBe('Aiko found the cat.');
  });

  it('queue pause|resume gpu; another lane is refused', async () => {
    await run(['queue', 'pause', 'gpu']);
    expect(last<QueueLanes>().pausedLanes).toEqual([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]);
    await run(['queue', 'resume', 'gpu']);
    expect(last<QueueLanes>().pausedLanes).toEqual([]);
    await expect(run(['queue', 'pause', 'cpu'])).rejects.toThrow(/only the gpu lane/);
  });
});
```

(Imports: `registerChapterCommands`, `registerQueueCommands`, and `GPU_MANUAL_PAUSE_REASON` / `QueueLanes` from `@manga/shared`. If `s.fake` is not on `M4TestServer`, use the field it exposes for the fake ComfyUI. The helper has `fake: FakeComfy`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/episode-commands.test.ts`
Expected: FAIL. The flags and commands are unknown.

- [ ] **Step 3: Implement**

In `packages/cli/src/commands/episode.ts`:
- Import `formatChapterEstimate` and `type Settings` from `@manga/shared`.
- Change `start`:

```ts
    .option('--no-preview', 'render everything at once instead of stopping after page 1 (W1 Q2)')
    .action(async (chapterRef: string, opts: { prompt: string; pages: number; chars?: string[]; tone: string; autopilot?: boolean; preview: boolean }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const characterIds: string[] = [];
      for (const ref of opts.chars ?? []) characterIds.push((await c.resolve.character(ref, chapter.mangaId)).id);
      // W1 C2: the size of what is about to start, before it starts.
      if (!c.json) c.io.stderr(`${formatChapterEstimate(opts.pages, await c.api.get<Settings>('/api/settings'))}\n`);
      const run = await c.api.post<EpisodeRun>(`/api/chapters/${enc(chapter.id)}/episode`, {
        input: { prompt: opts.prompt, pages: opts.pages, characterIds, tone: opts.tone, previewFirst: opts.preview },
        mode: opts.autopilot ? 'autopilot' : 'review',
      });
      await show(c, chapter.id, run);
    });
```

- Add `pause` and `resume` next to `cancel`:

```ts
  for (const [name, description] of [['pause', 'Pause a rendering run (a running image finishes)'], ['resume', 'Resume a paused run']] as const) {
    episode.command(name)
      .description(description)
      .argument('<chapter>', 'chapter id or <manga>/<number>')
      .action(async (chapterRef: string) => {
        const c = await ctx();
        const chapter = await c.resolve.chapter(chapterRef);
        const run = await latestRun(c, chapter.id);
        await show(c, chapter.id, await c.api.post<EpisodeRun>(`/api/episodes/${enc(run.id)}/${name}`));
      });
  }
```

In `packages/cli/src/commands/chapters.ts`:
- `edit` gains `.option('--summary <text>', 'summary (later chapters read it)')` and `if (opts.summary !== undefined) patch['summary'] = opts.summary;` (add `summary?: string` to the opts type).
- Add a new command (import `jobLine` from `./jobs.js` and `type JobRef` from `@manga/shared`). It reads `--wait` from `c.wait`, as `episode` does, so the tests' context drives it:

```ts
  chapter
    .command('render-missing')
    .description('render every panel of the chapter that has no image (W1 R1); --wait waits for the jobs')
    .argument('<chapter>', 'id or <manga>/<number>')
    .action(async (ref: string) => {
      const c = await ctx();
      const target = await c.resolve.chapter(ref);
      const refs = await c.api.post<JobRef[]>(`/api/chapters/${encodeURIComponent(target.id)}/render-missing`);
      const jobIds = refs.map((r) => r.jobId);
      const none = 'no panels without an image';
      if (!c.wait) {
        c.out({ jobIds }, () => (jobIds.length === 0 ? none : jobIds.join('\n')));
        return;
      }
      const jobs = await c.waitJobs(jobIds); // [] at once when nothing was queued
      c.out(jobs, () => (jobs.length === 0 ? none : jobs.map(jobLine).join('\n')));
      const failed = jobs.filter((j) => j.status !== 'succeeded');
      if (failed.length > 0) throw new CliError(`${failed.length} job(s) did not succeed`, 1);
    });
```

Create `packages/cli/src/commands/queue.ts`:

```ts
import { InvalidArgumentError, type Command } from 'commander';
import type { QueueLanes } from '@manga/shared';
import type { CliContext } from '../context.js';

function gpuOnly(value: string): 'gpu' {
  if (value !== 'gpu') throw new InvalidArgumentError('only the gpu lane can be paused or resumed by hand');
  return 'gpu';
}

const describe = (lanes: QueueLanes): string =>
  lanes.pausedLanes.length === 0 ? 'no lane is paused' : lanes.pausedLanes.map((p) => `${p.lane} paused: ${p.reason}`).join('\n');

/** W1 R2: `manga queue pause|resume gpu`. A manual pause is never lifted automatically. */
export function registerQueueCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const queue = program.command('queue').description('pause or resume the image queue');
  for (const action of ['pause', 'resume'] as const) {
    queue.command(action)
      .description(action === 'pause' ? 'pause the image queue until you resume it' : 'resume the image queue')
      .argument('<lane>', 'gpu', gpuOnly)
      .action(async (lane: 'gpu') => {
        const c = await ctx();
        const lanes = await c.api.post<QueueLanes>(`/api/queue/${lane}/${action}`);
        c.out(lanes, () => describe(lanes));
      });
  }
}
```

Commander wraps an `InvalidArgumentError` as a `CommanderError` whose message contains the text. In the test, `exitOverride()` makes `parseAsync` reject with it, so `rejects.toThrow(/only the gpu lane/)` holds.

In `packages/cli/src/program.ts`, import `registerQueueCommands` and add `registerQueueCommands(program, ctx);` after `registerJobCommands(program, ctx);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run packages/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): episode --no-preview and estimate, episode pause/resume, chapter render-missing and --summary, queue pause/resume gpu (W1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: UI — the episode panel, the AI section and the editor toolbar

**Files:**
- Modify: `packages/ui/src/episode/episodeView.ts`, `packages/ui/src/chapter/EpisodePanel.tsx`
- Modify: `packages/ui/src/chapter/aiSection.ts`, `packages/ui/src/chapter/CreateChapterAiSection.tsx`, `packages/ui/src/episode/episode.css`
- Modify: `packages/ui/src/queries.ts`, `packages/ui/src/queryKeys.ts`
- Modify: `packages/ui/src/editor/EditorToolbar.tsx`, `packages/ui/src/editor/ChapterEditor.tsx`
- Test:
  - `packages/ui/test/episode-view.test.ts`, `packages/ui/test/episode-panel-render.test.tsx`
  - `packages/ui/test/ai-section.test.ts`, `packages/ui/test/ai-section-render.test.tsx`
  - `packages/ui/test/query-keys.test.ts`, `packages/ui/test/editor-toolbar-render.test.tsx`

**Interfaces:**
- Consumes:
  - `renderGate`, `formatEstimate`, `formatChapterEstimate`, `MissingPanels`, `JobRef` and `stepIndex` from `@manga/shared`;
  - the routes of Task 5;
  - the icons `Pause` and `ImagePlus` (Task 2).
- Produces:
  - `gateLabel(run: EpisodeRun): string | null`;
  - `renderBusy(run: EpisodeRun | null | undefined): boolean`, which is true while the render step is `running` or `paused`;
  - `StepActions` gains `pause: boolean` and `resume: boolean`;
  - `qk.missingPanels(chapterId)` → `['missingPanels', chapterId]`, invalidated by `panel` and `page` events;
  - `useMissingPanels(chapterId: string | undefined)`;
  - `AiChapterInput.previewFirst: boolean`, default `true`;
  - `EditorToolbarProps` gains `missingImages: number | null`, `renderingMissing: boolean`, `renderMissingBlocked: boolean` and `onRenderMissing(): void`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/episode-view.test.ts` (append; reuse the file's run fixture helper):

```ts
describe('W1 episode view', () => {
  const gateRun = (output: unknown): EpisodeRun => {
    const r = runAt('render'); // status awaiting-review at the render step
    r.status = 'awaiting-review';
    r.steps[5] = { ...r.steps[5]!, status: 'awaiting-review', output };
    return r;
  };

  it('the preview and size stops have their own status text', () => {
    const base = { jobs: [], reviewed: 0, flagged: 0, rounds: 0, failedPanelIds: [] };
    expect(runLabel(gateRun({ ...base, preview: true, remainingPanels: 34, estimateSeconds: 1800 }))).toBe('Page 1 is ready — continue with 34 panels (~30 min)?');
    expect(runLabel(gateRun({ ...base, confirm: true, panels: 40, estimateSeconds: 3600 }))).toBe('Render 40 panels (~1 h)?');
    expect(gateLabel(gateRun(base))).toBeNull();
    expect(runLabel(gateRun(base))).toBe('Review: images');
  });

  it('pause while the render step runs; resume while paused; renderBusy covers both', () => {
    const r = runAt('render');
    r.status = 'running';
    r.steps[5] = { ...r.steps[5]!, status: 'running' };
    expect(stepActions(r, 'render')).toMatchObject({ pause: true, resume: false });
    expect(renderBusy(r)).toBe(true);
    const p = { ...r, status: 'paused' as const, steps: r.steps.map((s, i) => (i === 5 ? { ...s, status: 'paused' as const } : s)) };
    expect(stepActions(p, 'render')).toMatchObject({ pause: false, resume: true, approve: false });
    expect(renderBusy(p)).toBe(true);
    expect(renderBusy(null)).toBe(false);
  });
});
```

(Existing `stepActions(...)` `toEqual` expectations gain `pause: false, resume: false`.)

`packages/ui/test/episode-panel-render.test.tsx` (append):

```ts
it('a rendering run shows Pause; a paused one shows Resume instead of Continue (W1 C1)', () => {
  const rendering = run('running', 5, 'running');
  expect(enabled(render(rendering), 'Pause rendering')).toBe(true);
  const paused = { ...run('paused', 5, 'paused'), status: 'paused' as const };
  const html = render(paused);
  expect(enabled(html, 'Resume rendering')).toBe(true);
  expect(html).not.toContain('aria-label="Continue"');
  expect(statusText(html)).toBe('Rendering paused');
});

it('the render step offers "Re-render failed panels (N)" when panels have no image (W1 R1)', () => {
  const r = run('failed', 6, 'failed', 'x');
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.episode('ch_1'), { ...r, steps: r.steps.map((s) => (s.name === 'render' ? { ...s, status: 'done' as const } : s)) });
  qc.setQueryData(qk.missingPanels('ch_1'), { panelIds: ['pn_a', 'pn_b'] });
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter><EpisodePanel chapterId="ch_1" initialStep="render" /></MemoryRouter></QueryClientProvider>);
  expect(enabled(html, 'Re-render failed panels \\(2\\)')).toBe(true);
});
```

(`initialStep` is a new optional prop of `EpisodePanel` that seeds `picked`. It exists so a test can select a tab without a DOM. The chapter page does not pass it.)

`packages/ui/test/ai-section.test.ts` (append):

```ts
it('previewFirst is on by default and goes into the start body (W1 Q2)', () => {
  const v = { ...EMPTY_AI_INPUT, open: true, prompt: 'A cat' };
  expect(EMPTY_AI_INPUT.previewFirst).toBe(true);
  expect(toStartEpisode(v)?.input.previewFirst).toBe(true);
  expect(toStartEpisode({ ...v, previewFirst: false })?.input.previewFirst).toBe(false);
});
```

`packages/ui/test/ai-section-render.test.tsx` (append, following the file's render helper):

```ts
it('shows the preview toggle (on) and the chapter estimate', () => {
  // with qc.setQueryData(qk.settings(), DEFAULT_SETTINGS) and the section open with 8 pages
  const html = renderOpen(); // the file's helper that renders the section open
  expect(html).toMatch(/aria-label="Preview page 1 first"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Preview page 1 first"/);
  expect(html).toContain('8 pages ≈ 36 panels ≈ 37 min');
});
```

(If the render helper cannot open the section statically, export the section body as `AiSectionBody` and test that. Keep `CreateChapterAiSection` as the stateful wrapper.)

`packages/ui/test/query-keys.test.ts`: panel and page events now also return `['missingPanels']`. Update the existing expectations. For example, the panel created with no lookup becomes `[['page'], ['panelImages', 'pn_x'], ['missingPanels']]`, and the page deleted becomes `[['page', 'pg_1'], ['pages'], ['missingPanels']]`.

`packages/ui/test/editor-toolbar-render.test.tsx` (append; use the file's props builder):

```ts
it('chapter mode offers "Render panels without an image (N)" only when some are missing (W1 R1)', () => {
  expect(renderToolbar({ missingImages: 0 })).not.toContain('Render panels without an image');
  const html = renderToolbar({ missingImages: 3 });
  expect(html).toContain('aria-label="Render panels without an image (3)"');
  const blocked = renderToolbar({ missingImages: 3, renderMissingBlocked: true });
  expect(blocked).toMatch(/aria-label="Render panels without an image: the episode is rendering"[^>]*aria-disabled="true"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/ui/test`
Expected: FAIL.

- [ ] **Step 3: Implement the view model** in `episodeView.ts` (import `formatEstimate`, `renderGate`, `stepIndex` and `RenderOutputSchema`):

```ts
/** W1 Q2/C2: the status text of a render step stopped at its preview or size check, or null. */
export function gateLabel(run: EpisodeRun): string | null {
  const step = run.steps[stepIndex('render')];
  if (run.status !== 'awaiting-review' || run.currentStep !== stepIndex('render') || !step) return null;
  const gate = renderGate(step.output);
  if (gate === null) return null;
  const out = RenderOutputSchema.parse(step.output);
  const est = formatEstimate(out.estimateSeconds ?? 0);
  return gate === 'preview'
    ? `Page 1 is ready — continue with ${out.remainingPanels ?? 0} panels (${est})?`
    : `Render ${out.panels ?? 0} panels (${est})?`;
}

/** W1 R1/C1: the render step is working (or paused): re-rendering the missing panels would duplicate its jobs. */
export function renderBusy(run: EpisodeRun | null | undefined): boolean {
  const s = run?.steps[stepIndex('render')]?.status;
  return run !== null && run !== undefined && run.currentStep === stepIndex('render') && (s === 'running' || s === 'paused');
}
```

- In `runLabel`: `case 'awaiting-review': return gateLabel(run) ?? \`Review: ${STEP_LABEL[step].toLowerCase()}\`;`
- `StepActions` gets `pause` and `resume`.
- In `stepActions`, add `pause: run.status === 'running' && run.currentStep === stepIndex('render') && run.steps[stepIndex('render')]?.status === 'running'` and `resume: run.status === 'paused'`.

- [ ] **Step 4: Queries and keys**

In `queryKeys.ts`:
- Add `missingPanels: (chapterId: string) => ['missingPanels', chapterId] as const`.
- In `keysForEntity`, `case 'page': return [qk.page(e.id), ['pages'], ['missingPanels']];`.
- The panel case appends `['missingPanels']`.

In `queries.ts`:

```ts
export const useMissingPanels = (chapterId: string | undefined) =>
  useQuery({ queryKey: qk.missingPanels(chapterId ?? ''), queryFn: () => api.get<MissingPanels>(`/api/chapters/${seg(chapterId)}/render-missing`), enabled: !!chapterId });
```

- [ ] **Step 5: The episode panel** (`EpisodePanel.tsx`):
- Add the prop `initialStep?: EpisodeStepName` and use `useState<EpisodeStepName | null>(initialStep ?? null)` for `picked`.
- `ActKind` gains `'pause' | 'resume'`.
- Import `Pause`, `ImagePlus`, `useMissingPanels`, `renderBusy`, `JobRef` and `useMutation` (already imported).
- In the header actions:

```tsx
            {run.status === 'paused'
              ? <IconButton icon={Play} size="sm" tone="primary" label="Resume rendering" disabled={!actions.resume || busy} busy={busyOn('resume')}
                  onClick={() => act.mutate({ kind: 'resume', call: () => api.post<EpisodeRun>(`${runPath}/resume`) })} />
              : <IconButton icon={Play} size="sm" tone="primary" label={saveFirst ? 'Save and continue' : 'Continue'} disabled={!actions.approve || busy} busy={busyOn('approve')}
                  onClick={() => act.mutate({ kind: 'approve', call: moveOn('/approve') })} />}
            {actions.pause && (
              <IconButton icon={Pause} size="sm" label="Pause rendering" disabled={busy} busy={busyOn('pause')}
                onClick={() => act.mutate({ kind: 'pause', call: () => api.post<EpisodeRun>(`${runPath}/pause`) })} />
            )}
```

- In `episode__tools`, when `selected === 'render'`:

```tsx
              {selected === 'render' && missingCount > 0 && (
                <IconButton icon={ImagePlus} size="sm" label={`Re-render failed panels (${missingCount})`} badge={missingCount}
                  disabled={renderBusy(run) || renderMissing.isPending} busy={renderMissing.isPending} onClick={() => renderMissing.mutate()} />
              )}
```

- Define these above the early return:

```tsx
  const missing = useMissingPanels(chapterId);
  const missingCount = missing.data?.panelIds.length ?? 0;
  // Rejections are toasted by the MutationCache; the jobs indicator shows the queued renders.
  const renderMissing = useMutation({
    mutationFn: () => api.post<JobRef[]>(`/api/chapters/${seg(chapterId)}/render-missing`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.missingPanels(chapterId) }); },
  });
```

- [ ] **Step 6: The AI section**

In `aiSection.ts`:
- `AiChapterInput` gains `previewFirst: boolean`.
- `EMPTY_AI_INPUT` gets `previewFirst: true`.
- `toStartEpisode` sends `previewFirst: v.previewFirst` inside `input`.

In `CreateChapterAiSection.tsx`:
- Import `ScanEye` and `useSettings`, and `formatChapterEstimate` from `@manga/shared`.
- After the Autopilot button, add:

```tsx
            <IconButton icon={ScanEye} size="sm" active={value.previewFirst} tipSide="top" label="Preview page 1 first"
              onClick={() => set({ previewFirst: !value.previewFirst })} />
```

- Below the row, add:

```tsx
          {settings.data && <span className="ai-section__estimate" data-testid="ai-estimate">{formatChapterEstimate(value.pages, settings.data)}</span>}
```

In `episode.css`, add `.ai-section__estimate { font-size: var(--fs-xs); color: var(--text-2); }`. Readable text uses `--text-2`, never `--text-3`.

- [ ] **Step 7: The editor toolbar**

In `EditorToolbar.tsx`, after the Generate button (import `ImagePlus`):

```tsx
      {p.mode === 'chapter' && p.missingImages !== null && p.missingImages > 0 && (
        <IconButton icon={ImagePlus}
          label={p.renderMissingBlocked ? 'Render panels without an image: the episode is rendering' : `Render panels without an image (${p.missingImages})`}
          badge={p.missingImages} disabled={p.renderMissingBlocked} busy={p.renderingMissing} onClick={p.onRenderMissing} />
      )}
```

In `ChapterEditor.tsx` (chapter mode only):
- Read `const missing = useMissingPanels(mode === 'chapter' ? chapterId : undefined);` and `const episode = useEpisode(mode === 'chapter' ? chapterId : undefined);`.
- Add a `useMutation` that POSTs `render-missing`, as in Step 5.
- Pass the props:
  - `missingImages={mode === 'chapter' ? missing.data?.panelIds.length ?? null : null}`;
  - `renderingMissing={renderMissing.isPending}`;
  - `renderMissingBlocked={renderBusy(episode.data)}`;
  - `onRenderMissing={() => renderMissing.mutate()}`.
- Use the component's real `chapterId` prop; ids go through `seg`.

- [ ] **Step 8: Run the checks**

Run: `npm run typecheck && npx vitest run packages/ui`
Expected: PASS. Check the section, toolbar and panel visually in both themes with `npm run dev`: the badge, the new icons, and the estimate text colour.

- [ ] **Step 9: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): episode preview and size stops, pause/resume, re-render failed panels, preview toggle and chapter estimate (W1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: UI — image queue controls, the chapter summary editor and the confirm setting

**Files:**
- Modify: `packages/ui/src/shell/engineState.ts`
- Create: `packages/ui/src/shell/GpuQueueControl.tsx`
- Modify: `packages/ui/src/shell/JobsIndicator.tsx`, `packages/ui/src/shell/TopBar.tsx`, `packages/ui/src/shell/shell.css`
- Create: `packages/ui/src/manga/ChapterSummaryButton.tsx`
- Modify: `packages/ui/src/manga/ChapterRow.tsx`, `packages/ui/src/manga/mangaModel.ts`
- Modify: `packages/ui/src/settings/ReviewSettings.tsx`
- Test: `packages/ui/test/engine-state.test.ts`, create `packages/ui/test/gpu-queue-render.test.tsx`, `packages/ui/test/manga-model.test.ts`

**Interfaces:**
- Consumes:
  - `GPU_BUSY_REASON`, `GPU_MANUAL_PAUSE_REASON` and `QueueLanes` (Task 2);
  - the routes of Task 3;
  - `useOptimisticPatch`;
  - `Chapter.summary`.
- Produces:
  - `gpuPause(status: ServiceStatus | undefined): { reason: string } | null`;
  - `gpuPauseLabel(p: { reason: string }): string`, which returns `'Images paused — GPU busy'` for the busy reason and `'Images paused'` otherwise;
  - `pausedBanner` now leaves the gpu lane out, because the top bar chip shows it;
  - `GpuQueueControl` (in the jobs popover) and `GpuPausedChip` (in the top bar);
  - `applyChapterPatch(list: Chapter[], id: string, patch: Partial<Chapter>): Chapter[]`;
  - `ChapterSummaryButton({ chapter }: { chapter: Chapter })`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/engine-state.test.ts` (append; import `GPU_BUSY_REASON`, `GPU_MANUAL_PAUSE_REASON`, `gpuPause` and `gpuPauseLabel`):

```ts
describe('gpu lane pause (W1 R2)', () => {
  const status = (pausedLanes: ServiceStatus['queue']['pausedLanes']): ServiceStatus => ({
    claude: { ok: true, detail: '' }, ollama: { ok: true, detail: '' }, comfy: { ok: true, detail: '' }, queue: { queued: 0, running: 0, pausedLanes },
  });

  it('names the busy pause and a manual one', () => {
    expect(gpuPause(status([]))).toBeNull();
    const busy = gpuPause(status([{ lane: 'gpu', until: null, reason: GPU_BUSY_REASON }]))!;
    expect(gpuPauseLabel(busy)).toBe('Images paused — GPU busy');
    expect(gpuPauseLabel(gpuPause(status([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]))!)).toBe('Images paused');
  });

  it('the banner leaves the gpu lane to the top bar chip', () => {
    expect(pausedBanner(status([{ lane: 'gpu', until: null, reason: GPU_BUSY_REASON }]))).toBeNull();
    expect(pausedBanner(status([{ lane: 'claude', until: null, reason: 'quota' }]))).toBe('Claude jobs paused: quota');
  });
});
```

Create `packages/ui/test/gpu-queue-render.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GPU_BUSY_REASON, type ServiceStatus } from '@manga/shared';
import { qk } from '../src/queryKeys';
import { GpuPausedChip, GpuQueueControl } from '../src/shell/GpuQueueControl';

function html(pausedLanes: ServiceStatus['queue']['pausedLanes'], node: 'control' | 'chip'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.status(), {
    claude: { ok: true, detail: '' }, ollama: { ok: true, detail: '' }, comfy: { ok: true, detail: '' }, queue: { queued: 0, running: 0, pausedLanes },
  } satisfies ServiceStatus);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node === 'control' ? <GpuQueueControl /> : <GpuPausedChip />}</QueryClientProvider>);
}

describe('image queue controls (W1 R2)', () => {
  it('running: a Pause button and no chip', () => {
    expect(html([], 'control')).toContain('aria-label="Pause image queue"');
    expect(html([], 'chip')).toBe('');
  });

  it('busy: the chip says why (tooltip: the reason) and the button resumes', () => {
    const paused = [{ lane: 'gpu' as const, until: null, reason: GPU_BUSY_REASON }];
    const control = html(paused, 'control');
    expect(control).toContain('aria-label="Resume image queue"');
    expect(control).toContain('>Images paused — GPU busy<');
    expect(html(paused, 'chip')).toMatch(/role="status"[^>]*data-tip="GPU busy: another app is using GPU memory"[^>]*>Images paused — GPU busy</);
  });
});
```

`packages/ui/test/manga-model.test.ts` (append):

```ts
it('applyChapterPatch replaces one chapter in the list', () => {
  const a = { ...chapterFixture('ch_a'), summary: '' };
  const b = { ...chapterFixture('ch_b'), summary: '' };
  expect(applyChapterPatch([a, b], 'ch_b', { summary: 'S.' })).toEqual([a, { ...b, summary: 'S.' }]);
});
```

(`chapterFixture` stands for the file's existing Chapter literal. Factor it into a helper if it is inline.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/ui/test/engine-state.test.ts packages/ui/test/gpu-queue-render.test.tsx packages/ui/test/manga-model.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `engineState.ts`:

```ts
/** W1 R2: the gpu lane's pause, if any. */
export function gpuPause(status: ServiceStatus | undefined): { reason: string } | null {
  const p = status?.queue.pausedLanes.find((l) => l.lane === 'gpu');
  return p ? { reason: p.reason } : null;
}

export function gpuPauseLabel(p: { reason: string }): string {
  return p.reason === GPU_BUSY_REASON ? 'Images paused — GPU busy' : 'Images paused';
}
```

`pausedBanner` then filters its lanes with `.filter((p) => p.lane !== 'gpu')` before it checks for an empty list.

Create `packages/ui/src/shell/GpuQueueControl.tsx`:

```tsx
import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueueLanes, ServiceStatus } from '@manga/shared';
import { api } from '../api';
import { useStatus } from '../queries';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { Pause, Play } from '../ui/icons';
import { gpuPause, gpuPauseLabel } from './engineState';

/** The top bar chip while the image queue is paused (W1 R2); its tooltip is the reason. */
export function GpuPausedChip(): JSX.Element | null {
  const paused = gpuPause(useStatus().data);
  if (!paused) return null;
  return <span className="status-chip status-chip--paused topbar__gpu" role="status" data-tip={paused.reason}>{gpuPauseLabel(paused)}</span>;
}

/** The jobs popover's image queue row (W1 R2): the pause chip, and Pause or Resume. A manual pause is never lifted automatically. */
export function GpuQueueControl(): JSX.Element | null {
  const status = useStatus();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api.post<QueueLanes>(`/api/queue/gpu/${action}`),
    onSuccess: (lanes) => qc.setQueryData<ServiceStatus>(qk.status(), (prev) => (prev ? { ...prev, queue: { ...prev.queue, pausedLanes: lanes.pausedLanes } } : prev)),
  });
  if (!status.data) return null;
  const paused = gpuPause(status.data);
  return (
    <div className="gpu-queue" data-testid="gpu-queue">
      {paused && <span className="status-chip status-chip--paused" data-tip={paused.reason}>{gpuPauseLabel(paused)}</span>}
      <span className="spacer" />
      <IconButton icon={paused ? Play : Pause} size="sm" label={paused ? 'Resume image queue' : 'Pause image queue'} busy={toggle.isPending}
        onClick={() => toggle.mutate(paused ? 'resume' : 'pause')} />
    </div>
  );
}
```

- `JobsIndicator.tsx`: render `<GpuQueueControl />` as the first child of the `Popover`.
- `TopBar.tsx`: render `<GpuPausedChip />` before `<EngineSwitch />`.
- `shell.css`: add `.gpu-queue { display: flex; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); margin-bottom: var(--sp-2); border-bottom: 1px solid var(--border-1); }` and `.topbar__gpu { margin-right: var(--sp-2); }`.

In `mangaModel.ts`:

```ts
export function applyChapterPatch(list: Chapter[], id: string, patch: Partial<Chapter>): Chapter[] {
  return list.map((c) => (c.id === id ? { ...c, ...patch } : c));
}
```

Create `packages/ui/src/manga/ChapterSummaryButton.tsx`:

```tsx
import { useState, type JSX } from 'react';
import type { Chapter } from '@manga/shared';
import { api, seg } from '../api';
import { useOptimisticPatch } from '../lib/optimisticPatch';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { Check, FileText, X } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { applyChapterPatch } from './mangaModel';

/** W1 Q1: the chapter's "what happened" (an episode run writes it; later chapters' premise and outline read it). */
export function ChapterSummaryButton({ chapter }: { chapter: Chapter }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(chapter.summary);
  const patch = useOptimisticPatch<Chapter[], { summary: string }, Chapter>({
    queryKey: qk.chapters(chapter.mangaId),
    mutationKey: ['chapters', chapter.mangaId, 'patch'],
    send: (body) => api.patch<Chapter>(`/api/chapters/${seg(chapter.id)}`, body),
    apply: (prev, body) => applyChapterPatch(prev, chapter.id, body),
    alsoInvalidate: [qk.chapter(chapter.id)],
  });
  const next = text.trim();
  return (
    <>
      <IconButton icon={FileText} label={chapter.summary ? 'Edit chapter summary' : 'Add chapter summary'} onClick={() => { setText(chapter.summary); setOpen(true); }} />
      <Modal open={open} onClose={() => setOpen(false)} title="Chapter summary">
        <textarea className="textarea" rows={5} aria-label="Chapter summary" data-autofocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="form-actions">
          <IconButton icon={X} label="Discard changes" onClick={() => setOpen(false)} />
          <IconButton icon={Check} tone="primary" label="Save summary" disabled={next === chapter.summary}
            onClick={() => { patch.mutate({ summary: next }); setOpen(false); }} />
        </div>
      </Modal>
    </>
  );
}
```

In `ChapterRow.tsx`, render `<ChapterSummaryButton chapter={chapter} />` before the cover button.

In `ReviewSettings.tsx`, add after "Retry rounds":

```tsx
      <Field label="Confirm renders over (min)" inline>
        <NumberField label="Confirm renders over (min)" value={settings.episode.confirmRenderMinutes} min={1} max={1440} integer
          onSave={(confirmRenderMinutes) => save({ episode: { confirmRenderMinutes } })} />
      </Field>
```

- [ ] **Step 4: Run the checks**

Run: `npm run typecheck && npx vitest run packages/ui`
Expected: PASS. Check the jobs popover, the top bar chip and the summary dialog in both themes (`npm run dev`, then `POST /api/queue/gpu/pause`).

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): image queue pause/resume with the GPU-busy chip, chapter summary editor, render confirmation setting (W1 R2, Q1, C2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: E2E — preview stop → Continue → done

**Files:**
- Create: `e2e/episode-preview.spec.ts`
- Modify: `e2e/episode-export.spec.ts` (turn the preview off in the AI section, so its autopilot run still goes straight through)

**Interfaces:**
- Consumes:
  - the preview behaviour (Tasks 4 and 8);
  - the `episode-status` test id, whose text is `runLabel`;
  - the Continue button;
  - `collectErrors`.
- Produces: nothing.

- [ ] **Step 1: Write the spec** (`e2e/episode-preview.spec.ts`):

```ts
import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

// W1 Q2 through the real server and UI (fakes): a 2-page autopilot run stops after the cover and page 1, even in
// autopilot; Continue renders page 2 in the same step and the chapter becomes ready.
test('preview first: the run stops at page 1, Continue renders the rest and the chapter is ready', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const manga = (await (await request.post('/api/mangas', { data: { title: `E2E Preview ${Date.now()}` } })).json()) as { id: string };
  const aiko = (await (await request.post(`/api/mangas/${manga.id}/characters`, { data: { name: 'Aiko', appearanceTags: '1girl, short black hair' } })).json()) as { id: string };
  const chapter = (await (await request.post(`/api/mangas/${manga.id}/chapters`, { data: { title: 'Preview' } })).json()) as { id: string };
  const started = await request.post(`/api/chapters/${chapter.id}/episode`, {
    data: { input: { prompt: 'Aiko finds a lost cat in the rain', pages: 2, characterIds: [aiko.id] }, mode: 'autopilot' },
  });
  expect(started.ok()).toBe(true);
  expect(((await started.json()) as { input: { previewFirst?: boolean } }).input.previewFirst).toBe(true); // the API default

  await page.goto(`/m/${manga.id}/c/${chapter.id}`);
  const status = page.getByTestId('episode-status');
  await expect(status).toHaveText(/^Page 1 is ready — continue with 2 panels \(~\d+ (s|min)\)\?$/, { timeout: 120_000 });

  type Detail = { panels: Array<{ activeImageId: string | null }> };
  const storyPages = (await (await request.get(`/api/chapters/${chapter.id}/pages`)).json()) as Array<{ id: string }>;
  const detail = async (id: string): Promise<Detail> => (await (await request.get(`/api/pages/${id}`)).json()) as Detail;
  expect(storyPages).toHaveLength(2);
  expect((await detail(storyPages[0]!.id)).panels.every((p) => p.activeImageId !== null)).toBe(true);
  expect((await detail(storyPages[1]!.id)).panels.every((p) => p.activeImageId === null)).toBe(true);

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(status).toHaveText('Chapter ready', { timeout: 120_000 });
  expect((await detail(storyPages[1]!.id)).panels.every((p) => p.activeImageId !== null)).toBe(true);
  await expect(page.getByTestId('episode-step-error')).toHaveCount(0);
  expect(errors.all()).toEqual([]);
});
```

- [ ] **Step 2: Keep `episode-export.spec.ts` uninterrupted.** After the autopilot toggle lines, add:

```ts
  const preview = page.getByRole('button', { name: 'Preview page 1 first', exact: true });
  await expect(preview).toHaveAttribute('aria-pressed', 'true'); // on by default (W1 Q2)
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');
```

- [ ] **Step 3: Run the E2E suite**

Run: `npm run e2e`
Expected: every spec passes, including `episode-preview.spec.ts`, `episode-export.spec.ts` and `episode-review.spec.ts`. The review spec starts through the API with `pages: 1`, so it has no preview stop.

- [ ] **Step 4: Run the whole suite once more**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): the preview stop, Continue and a ready chapter; the export journey turns the preview off (W1 Q2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| R1: a failed panel is recorded, not fatal; `failedPanelIds`; the "· N failed" label | 4 |
| R1: the step fails only when every panel failed, naming the first failure | 4 |
| R1: lettering runs as usual; a panel without an image still gets its text frames | 4 (lettering is unchanged; `letterPage` never reads images) |
| R1: `POST /api/chapters/:id/render-missing` → `JobRef[]`, tagged with the latest run | 5 |
| R1: the "Re-render failed panels (N)" button in the render step and the editor toolbar | 8 |
| R1: `manga chapter render-missing <chapter> [--wait]` | 7 |
| R1: the auto-review rounds skip failed panels | 4 |
| R2: a GPU stall is tagged `GpuBusyError`, pauses the gpu lane with the reason, and requeues without an attempt | 3 |
| R2: the monitor polls `/system_stats` every 30 s while paused; resumes at ≥ 8 GB or after a ComfyUI restart | 3 |
| R2: before submitting, below 3 GB the job pauses the lane and requeues itself | 3 |
| R2: a manual override (UI popover, `POST /api/queue/gpu/pause|resume`, `manga queue pause|resume gpu`); a manual pause is never auto-resumed | 3, 7, 9 |
| R2: the `status` event and `pausedLanes` carry the reason; the top bar shows "Images paused — GPU busy" | 3, 9 |
| R3: repair (fences and prefix, trailing commas, an open string, missing closers via a bracket stack), then schema validation | 1 |
| R3: a failed repair leads to a correction round that says the answer was cut off | 1 |
| Q1: `storySoFar` (actions and `speaker: text`, ~3,000 chars, most recent pages) | 6 |
| Q1: `previousPage` (≤ 800 chars) | 6 |
| Q1: `previousChapters` (the last 10, `{number, title, synopsis}`, the summary over the synopsis) | 6 |
| Q1: `chapter.summary`: migration, written on finish by one story-task call, editable in the chapter settings | 2, 6, 7, 9 |
| Q1: G2 (small system prompts, context in the user part) | 6 |
| Q2: the `previewFirst` input (default true); the AI section toggle; CLI `--no-preview` | 2, 7, 8 |
| Q2: the cover and page 1 first; `awaiting-review` with `{preview, remainingPanels, estimateSeconds}` in both modes | 4 |
| Q2: the stepper label and Continue / Re-run / Cancel; Continue renders the rest in the same step | 4, 8 |
| Q2: a re-run asks for the preview again | 4 |
| C1: `POST /api/episodes/:runId/pause`: cancels queued children, stops the driver, run and step `paused` with the token | 5 |
| C1: `resume` re-dispatches with the token; rendered panels are skipped | 5 |
| C1: UI Pause/Resume; CLI `episode pause|resume` | 7, 8 |
| C1: the chapter stays `generating`; a restart keeps the run paused | 5 |
| C2: the estimate before start (AI section, `manga episode start`) | 2, 7, 8 |
| C2: the confirm stop over `settings.episode.confirmRenderMinutes` (default 45) when the preview is off; no second stop with the preview on | 2, 4, 9 |
| C2: the breakdown stays ≤ 6 panels per page and is told to aim for 3–5 | 6 |
| Data: `paused` statuses, `previewFirst`, the render output fields, `Chapter.summary`, `settings.episode`, the new routes and CLI commands, G5 events | 2–7 |
| Testing: the JSON repair, driver failures and stops, runner pause/resume/restart, the GPU monitor with the fake ComfyUI, the context builders, one E2E | 1, 3, 4, 5, 6, 10 |
