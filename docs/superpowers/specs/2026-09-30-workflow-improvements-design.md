# Episode workflow improvements (W1): design

**Date:** 2026-09-30
**Status:** draft, for Roman's approval
**Builds on:** `2026-09-27-manga-builder-design.md` §8 (episode workflow); contracts `docs/superpowers/plans/2026-09-27-00-contracts.md`.

## Goal

Make long, automated episode runs finish reliably and cheaply on a home PC that is also used for other things (games). Roman chose seven improvements (2026-09-30):

- R1: failed panels don't stop the render;
- R2: auto-pause when the GPU is busy;
- R3: cut-off Claude answers;
- Q1: story memory;
- Q2: style preview first;
- C1: pause and resume a render;
- C2: a guard on chapter size.

## Evidence behind them (Roman's library, read-only)
- A 121-panel render made 5 images. The 6th then crawled for 21 minutes at "Sampling 3/8" while Dota 2 held most of the 16 GB of VRAM. The stall watchdog (commit 839e333) now turns this into a transient failure after 3 min without progress. But while the game keeps running, every job would stall and fail in turn.
- Two Claude prompts-step answers of about 1.4 KB ended in `}]` with the final `}` missing. The step failed with "The answer contained no JSON object."
- That chapter had 121 panels, estimated at about 2 h. Nobody saw the estimate before it started.

## Design

### R1 — Failed panels don't stop the render
- In `runRenderStep`, a panel whose generate job fails (after the queue's own retries) is recorded, not fatal. The step still completes.
  - Its output gains `failedPanelIds: string[]`.
  - The progress label ends with "· N failed".
- The step fails only when **every** panel failed. That is systemic (engine down, bad recipe). The error names the first failure.
- Lettering runs as usual. A panel without an image still gets its text frames.
- **Re-render failed panels:**
  - API: `POST /api/chapters/:id/render-missing` → `JobRef[]`. It queues `image.generate` for every story or cover panel of the chapter that has no active image, tagged with the latest run's id when one exists.
  - UI: a "Re-render failed panels (N)" icon button in the episode panel's render step, and in the chapter editor toolbar when any panel lacks an image.
  - CLI: `manga chapter render-missing <chapter> [--wait]`.
- The auto-review rounds skip failed panels.

### R2 — Auto-pause the GPU lane when the GPU is busy
- A job that fails with a GPU stall (the watchdog's `TransientError`, now tagged `GpuBusyError`) does these things:
  - it pauses the `gpu` lane: `queue.pauseLane('gpu', null, 'GPU busy: another app is using GPU memory')`;
  - it is requeued **without consuming an attempt**.
- A GPU monitor then polls ComfyUI `/system_stats` every 30 s while the lane is paused for this reason.
  - It resumes the lane when the VRAM available to ComfyUI is at least `GPU_RESUME_FREE_BYTES`: 8 GB, a named constant covering the largest routed recipe.
  - It also resumes when the ComfyUI process restarts and becomes reachable.
- The same pause triggers **before** submitting: `run()` already reads free VRAM. Below `GPU_PAUSE_FREE_BYTES` (3 GB), the job pauses the lane and requeues itself instead of starting a run that would crawl.
- A manual override is available:
  - UI: "Resume image queue" and "Pause image queue" in the jobs popover, where a status chip shows the reason;
  - API: `POST /api/queue/gpu/pause|resume`;
  - CLI: `manga queue pause|resume gpu`.
  - A manual pause is never auto-resumed.
- The existing `status` event and `/api/status.queue.pausedLanes` carry the reason. The UI top bar shows "Images paused — GPU busy".

### R3 — Cut-off or malformed JSON answers
`extractJson` in `packages/server/src/engines/structured.ts` tries a repair before giving up. This applies to all engines and steps. The repair:
- strips code fences and any text before the first `{`;
- removes trailing commas before `}` or `]`;
- closes an unterminated string at the end;
- appends the missing closing `]` and `}` in the right nesting order (tracked with a bracket stack that ignores brackets inside strings).

Only a repair that then parses is used, and it still goes through schema validation. If repair fails, the existing correction round runs, and its message says the answer was cut off.

### Q1 — Story memory
- **Within a chapter.** Script chunks run in order (≤ 4 pages each). Each chunk's context gains `storySoFar`, a compact English-or-book-language digest of the pages already written in earlier chunks:
  - each page gives its panels' actions, one line each;
  - plus its dialogue lines, as `speaker: text`;
  - capped at ~3,000 characters, keeping the most recent pages.
  - Prompts per page gain `previousPage`, the previous page's actions (≤ 800 chars), for visual continuity.
- **Across chapters.** The premise and outline contexts gain `previousChapters`: the manga's earlier chapters by number, as `{ number, title, synopsis }`, capped at the last 10.
  - The chapter synopsis is already written by the premise step.
  - A new optional field, `chapter.summary`, is written when an episode run finishes. It uses one small extra LLM call on the story task: a 3–5 sentence "what happened", in the book language. When a summary exists, it is used instead of the synopsis.
  - The summary can be edited in the chapter settings.
- Keep G2: small system prompts, with this context in the user/stdin part.

### Q2 — Style preview first
- A new run input `previewFirst: boolean` (default **true**) is set in the AI section as an icon toggle (tooltip "Preview page 1 first") and in the CLI as `--no-preview`.
- With it on, the render step renders the cover panel and page 1 first. The step then goes `awaiting-review` with the output `{ preview: true, remainingPanels, estimateSeconds }`, in **both** review and autopilot mode.
  - The stepper shows the preview label "Page 1 is ready — continue with N panels (~X min)?" with the buttons Continue / Re-run / Cancel. The user checks page 1 in the editor.
  - Continue renders the rest in the same step. Panels rendered after the step's token are skipped, as the retry rule already does.
- A re-run of the render step asks for the preview again.

### C1 — Pause and resume a render
- `POST /api/episodes/:runId/pause` does the following:
  - it cancels the run's **queued** child jobs (generate, review) and lets a running image finish; the outline's queued portraits stay, as for a re-run, because they belong to the characters (W1 final M4);
  - it stops the driver: the render step job ends as `cancelled` without failing the step;
  - it sets the run status `paused` (new) and the step status `paused` (new, keeping its token).
- `POST /api/episodes/:runId/resume` re-dispatches the current step with its token kept (like a retry). Already-rendered panels are skipped.
- UI: Pause and Resume icon buttons in the episode panel while rendering. CLI: `manga episode pause|resume <chapter>`.
- The chapter stays `generating` while paused.
- The editor is usable while paused, and while generating too, as today.
- Server restart: a `paused` run stays paused. `resume()` at boot ignores it.

### C2 — Chapter size guard
- **Before start:** the AI section and `manga episode start` show an estimate from `pages × typical panels/page (4.5) × per-panel seconds for the routed recipes`.
  - Example: "8 pages ≈ 36 panels ≈ 40 min".
  - The estimate uses the existing `estimateSeconds` / `RECIPE_AVG_SECONDS`, including review rounds.
- **Before rendering:** when preview is off and the render estimate exceeds `settings.episode.confirmRenderMinutes` (default 45), the render step stops once at `awaiting-review`. The output is `{ confirm: true, panels, estimateSeconds }`. It stops in both modes, and Continue proceeds.
  - With preview on, the preview stop already shows the estimate for the rest, so there is no second stop.
- **Cap:** the breakdown stays at ≤ 6 panels per page (the preset maximum). The breakdown prompt is told to aim for 3–5 panels per page, so the typical 4.5 holds.

## Out of scope
The other options Roman did not choose: desktop notifications, auto-picking portraits, auto-review on by default, per-panel redo from the stepper, and an engine per step.

## Data and contract changes
- `EpisodeRun.status` and step status gain `paused`.
- `EpisodeInput` gains `previewFirst` (optional, default true).
- The render step output gains `failedPanelIds` and optionally `preview` / `confirm`.
- `Chapter` gains `summary` (optional string), stored as a new column added by a migration, defaulting to `''`.
- `settings.episode.confirmRenderMinutes` is added.
- New routes: `render-missing`, `queue/gpu/pause|resume`, `episodes/:runId/pause|resume`.
- New CLI commands as named above.
- Events: run, chapter and status events as today (G5).

## Testing
- Unit tests for the JSON repair (the real `}]` answers).
- Render driver: failed panels versus all failed; the preview stop; the confirm stop.
- Runner: pause, resume, and restart while paused.
- GPU monitor, with the fake ComfyUI reporting low then high free VRAM: auto-pause and resume.
- Context builders: `storySoFar`, `previousChapters`, `summary`.
- One E2E: preview stop → Continue → done, using the fakes.
