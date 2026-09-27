# M4 — Episode Workflow, Auto-Lettering and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a one-line prompt into a finished, lettered chapter (premise → outline → breakdown → scripts → prompts → render → lettering, with review points or autopilot), and export pages/chapters to PNG and PDF from the UI and the CLI.

**Architecture:** A durable state machine (`EpisodeRunner`) persists every step in `EpisodeRun.steps`; each step executes as an `llm.step {type:'episode'}` job (LLM steps on `engines.laneFor(task)`, the render/lettering drivers on lane `cpu`) so progress, cancel and resume reuse M1's queue. Pure logic (step schemas with refined validation, auto-letter placement, slugs) lives in `@manga/shared` / small server modules with unit tests; export drives Playwright Chromium against the M3 print route and merges PDFs with pdf-lib.

**Tech Stack:** TypeScript 5.9.3 (ESM, NodeNext), zod 4, Fastify 5, better-sqlite3, vitest 3.2.4, Playwright 1.62.1, pdf-lib, React 19 + TanStack Query + lucide-react, commander 14.

**Spec:** `docs/superpowers/specs/2026-09-27-manga-builder-design.md` (§8 episode workflow, §9.3 auto-placement, §10 export, §12 CLI, §13 errors, §14 tests).
**Contracts (binding):** `docs/superpowers/plans/2026-09-27-00-contracts.md`. This is milestone **M4**; it builds on M1–M3 exactly as the contract specifies.

## Global Constraints

(Copied verbatim from the contracts file, "Global constraints (all milestones)".)

- **Runtime and language:**
  - Node ≥ 22 (the machine has 25.2.1).
  - TypeScript **5.9.3**, ESM only (`"type": "module"`), `module/moduleResolution: NodeNext`.
- **Compiler settings.** Every package extends this `tsconfig.base.json`:

  ```json
  {"compilerOptions":{"target":"ES2023","lib":["ES2023"],"module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true,"noImplicitOverride":true,"noFallthroughCasesInSwitch":true,"verbatimModuleSyntax":true,"isolatedModules":true,"declaration":true,"declarationMap":true,"sourceMap":true,"composite":true,"skipLibCheck":true}}
  ```

  - The UI package overrides `lib` with `DOM`, `jsx: react-jsx`, `module: ESNext`, `moduleResolution: Bundler`, and sets `noEmit`.
- **Pinned versions:**

  | Package | Version |
  |---|---|
  | `zod` | `^4.1.12` |
  | `fastify` | `^5.6.1` |
  | `@fastify/websocket` | `^11.2.0` |
  | `@fastify/static` | `^8.3.0` |
  | `@fastify/multipart` | `^9.0.3` |
  | `better-sqlite3` | `^12.4.1` |
  | `@types/better-sqlite3` | `^7.6.13` |
  | `@types/node` | `24.10.1` |
  | `vitest` | `3.2.4` |
  | `playwright` / `@playwright/test` | `1.62.1` |
  | `react` / `react-dom` | `19.2.0` |
  | `vite` | `7.2.1` |
  | `@vitejs/plugin-react` | `5.1.1` |
  | `commander` | `^14.0.0` |
  | `ws` | `^8.18.3` |
  | `pdf-lib` | `^1.17.1` |
  | `lucide-react` | `^0.546.0` |
  | `react-router` | `^7.9.4` |
  | `@tanstack/react-query` | `^5.90.5` |

  If a caret range fails to resolve, pin the newest available and note it in the commit.
- **Package names:** `@manga/shared`, `@manga/server`, `@manga/cli`, `@manga/ui`. The workspaces live in `packages/*`.
- **Tests:**
  - `packages/<pkg>/test/**/*.test.ts(x)`.
  - Root `vitest.config.ts` includes `packages/*/test/**/*.test.ts?(x)`, `environment: 'node'`, `testTimeout: 30_000`.
  - E2E specs live in `e2e/*.spec.ts` with a root `playwright.config.ts` (created in M3).
- **Root scripts:**
  - `build` (`tsc --build` + UI vite build)
  - `typecheck`
  - `test` (`vitest run`)
  - `dev`
  - `start` (`node packages/server/dist/main.js`)
  - `e2e`
  - `smoke`
  - `link-cli` (`npm link --workspace @manga/cli`)
- **Network:** the server binds **127.0.0.1 only**, default port **4317**.
- **Library folder:** default `%USERPROFILE%\MangaBuilder` (`path.join(os.homedir(), 'MangaBuilder')`). Layout:

  ```
  <library>/library.sqlite
  <library>/server.json                         {pid, port, startedAt}
  <library>/mangas/<mangaId>/images/<imageId>.png
  <library>/exports/<mangaSlug>/<chapterSlug>/...
  <library>/.claude-cwd/                         empty dir, cwd for `claude -p`
  <library>/tmp/                                 multipart upload staging
  ```

- **Config file:** `path.join(os.homedir(), '.manga-builder', 'config.json')` → `AppConfig` (below). A missing file means defaults. The env var `MANGA_LIBRARY` overrides `libraryPath`, and `MANGA_PORT` overrides `port`; tests use both.
- **Model files:** never copied into this repo; never written anywhere except `claude-image-gen/models` (by P1).
- **Commits:** end every commit message with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **UI style rules:**
  - No unnecessary text (use tooltips).
  - Icon buttons instead of labelled ones.
  - Loaders that show a status.
  - Compact layout with consistent spacing.
  - Nothing neon or fancy; clean and tool-like.
  - Neutral colours.
  - Light and dark themes.


**M4 environment notes:** Windows 11, Git Bash for every command below; Node 25.2.1. Run every command from the repo root `C:\Users\roman\Dev\Exalink\manga-builder`. Commits use `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (the second `-m` produces the required blank line + trailer). The root `vitest.config.ts` aliases `@manga/shared` and `@manga/server` to `src/`, so tests never need a build first.

## Review Focus

1. **Starting an episode in a chapter that already has pages** (the user added a page by hand, then opened the AI section) → 409 `conflict`, nothing deleted; pages are only ever replaced through `rerun … confirm=true`. Pinned in Task 9 (`start refuses a chapter that already has pages`).
2. **The LLM spells a character name differently** ("aiko ", "AIKO" for "Aiko") → accepted and mapped to the right id; a name matching nobody fails validation (so the engine's correction round can fix it) and never produces a panel pointing at a missing character. Pinned in Task 2 (`scripts schema matches names case-insensitively`) and Task 6 (`materialize maps names case-insensitively`).
3. **A crowded panel** (Ukrainian dialogue runs ~20 % longer than English; four long lines in a small panel) → every frame box and tail stays inside the panel even when the frames cannot all fit without overlapping. Pinned in Task 3 (`crowded panel keeps every box and tail inside the panel`).
4. **Server restart in the middle of a run** → the run resumes from `currentStep` without a second LLM call when the step's job is still queued, and a late result from a superseded job (step re-run meanwhile) is discarded. Pinned in Task 9 (`resume re-attaches to a queued step job`, `a late result of a superseded job is discarded`).
5. **Titles that are Cyrillic, punctuation-only or duplicated** ("Розділ 1", "!!!", two chapters called "Rain") → export folders are ASCII, never empty and never collide. Pinned in Task 12 (`slugify falls back`, `chapter dirs never collide`).

---

## Cross-milestone assumptions and proposed contract changes

Read this before Task 1. Every name below is either an exact contract name, a name fixed by the finished M1/M2 plans (`2026-09-27-m1-foundation.md`, `2026-09-27-m2-ai-imaging.md`), or a **PROPOSED CONTRACT CHANGE** this plan is written against. Task 1 imports every consumed server symbol in one preflight test, so drift shows up there first.

**Consumed M1 names:** `openStore`, `Store`, `NotFoundError` (`store/index.js`); `TransientError`, `PermanentError`, `GpuArbiter`, `JobQueue`, `JobContext`, `JobHandler`, `EnqueueInput` (`jobs/index.js`); `EventBus` (`events/bus.js`); `startServer`, `CoreDeps`, `AppModule` (`app.js`); `createPage`, `createCoverPage`, `pageDetail`, `NeedsConfirmError` (`domain/pages.js`); `createFrame` (`domain/frames.js`); `deletePage` (`domain/delete.js`); `chapterPages` (`domain/order.js` — story pages only, ordered); `createCharacter` (`domain/characters.js` — random seed when omitted); `randomSeed` (`domain/seed.js`); `ConflictError`, `ValidationError` (`errors.js` — `HttpError` subclasses that M1's error handler maps to `ApiErrorBody`; a thrown `ZodError` becomes 400 `validation`).

**Consumed M2 names:** `servicesFor(deps)` → `.engines` (`modules/services.js`); `aiModule`, `imagingModule` (`modules/ai.js`, `modules/imaging.js`); `Engines` (`engines/resolve.js`); `ScriptedEngine` (`engines/scripted.js`); `JsonRequest` (`engines/types.js`); `InvalidOutputError` (`engines/errors.js`, carries `raw`); `FAKE_RESPONSES` (`dev/fake-responses.js`); `registerLlmStep` (`jobs/llm-step.js`); `routeRecipe`, `promptStyleFor` (`imaging/route.js`). M2 test helpers reused: `openTestLibrary` (`test/helpers/library.js`), `seedCharacter`, `seedImage`, `giveRefs`, `updatePanel` (`test/helpers/seed.js`), `startFakeComfy` (`test/fakes/fake-comfy.js`); also `ComfyClient` (`src/imaging/comfy.js`) and `encodeSolidPng` (`src/dev/png.js`) in tests. M2 behaviour relied on: `image.generate {target:'panel'}` sets the new image active and resolves `{imageId}`; portraits are character-owned images with `role:'portrait'` that are **not** auto-picked; `image.review` writes `Image.review`; `image.upscale` creates `source:'upscaled'`, `parentImageId` = the input, same owner.

**Consumed M3 names (`2026-09-27-m3-ui-editor.md`):** `api`, `ApiError` (`src/api.ts`, Task 1; bodyless POSTs send no body); `qk.episode(chapterId)`, `qk.page(id)` (`src/queryKeys.ts`, Task 5; `episodeRun` events invalidate `['episode']`, `page` events `['page', id]`); `useCharacters(mangaId)`, `useManga`, `useJobs()` (`src/queries.ts`); `waitForJob(id)` (`src/events.ts`); `TERMINAL` (`src/jobs/jobView.ts`); `IconButton {icon,label,active?,busy?,disabled?,tone?,size?,ref}`, `Popover {anchor,open,onClose,label,align?,className?}`, `StatusLoader {label,value?,max?}`, `Segmented {value,options,onChange,label}` (options render as `role="radio"` with `aria-label`), `Field {label,inline?,children}` (a `<label>`), `errorText(err)`, `pushToast(kind,text)` (`src/ui/*`); `cx` (`src/lib/cx.ts`); lucide icons are imported only through `src/ui/icons.ts`; CSS tokens (`--sp-*`, `--r-*`, `--fs-*`, `--surface*`, `--border-*`, `--text-*`, `--accent*`, `--ok`, `--danger*`) and classes (`.row`, `.stack`, `.spacer`, `.input`, `.textarea`, `.muted`, `.error-text`, `.status-chip`, `.spin`). The print route `src/render/RenderPage.tsx` (Task 12) sets `window.__MANGA_RENDER_READY__`, or `window.__MANGA_RENDER_ERROR__` (a string) on failure. The three M4 slots, with M3's exact props: `EpisodePanel({ chapterId })` (Task 15; rendered unconditionally as the chapter editor's `aside`, returns `null` without a run), `CreateChapterAiSection({ mangaId, onChange(start | null) })` (Task 15; `CreateChapterModal` awaits `start(chapter.id)` after creating the chapter, before navigating), `ExportButton({ target })` (Task 18; `target` is the chapter in the chapter editor, the cover page in the cover editor). E2E: M3's `playwright.config.ts` and `e2e/helpers.ts` (Task 19).

**Contract changes / clarifications** (copied into the contracts file during planning; Task 22 Step 6 verifies):

- **C-1 — print-resolution images.** New Contract B row `GET /api/pages/:id/print` → `PageDetail` (M4): like `GET /api/pages/:id`, except a panel whose active image has an `upscaled` child (`parentImageId === activeImageId`, same panel owner, widest wins) reports that child as `activeImageId`, and `images` contains it. Contract E addition: `/render/page/:pageId?hires=1` fetches `/api/pages/:id/print` instead of `/api/pages/:id` (Task 17). PageView is unchanged: it renders `images[panel.activeImageId]`.
- **C-2 — step job lanes.** Every step runs as `llm.step {type:'episode', runId, step}`. LLM steps use `engines.laneFor(STEP_TASK[step])`; `render` and `lettering` are orchestration drivers on lane `cpu` with `maxAttempts: 1` (they wait on `gpu`/review jobs, so they must never hold the `gpu` lane).
- **C-3 — start conflicts.** `POST /api/chapters/:id/episode` answers 409 `conflict` when the chapter already has story pages, or already has a run in `running`/`awaiting-review`.
- **C-4 — shared index.** `@manga/shared` also re-exports `letter` (Contract A says M4 adds `episode`).
- **C-5 — `ExportButton` gets an optional `pageId`.** M3's slot only receives `target` (the chapter), but the export popover offers "current page" too, so `EditorToolbar` passes `pageId={p.detail?.page.id ?? null}` (one-line change in Task 20) and renders M4's `AutoLetterButton` after the add-frame buttons. The other two slots keep M3's props exactly.
- **C-6 — CLI.** M4 adds `manga text auto <page>` to the existing `text` group (spec §12) and `manga episode autopilot <chapter>` ("run to end", so every UI action has a CLI twin, spec §1.5), next to `episode …` and `export …`.
- **C-7 — exporter and the print route.** The exporter waits for `__MANGA_RENDER_READY__` **or** `__MANGA_RENDER_ERROR__` and fails the job at once with that error (M3 contract note C5).

---

## File Structure

**`packages/shared/src/`**
- `episode.ts` (create) — per-step output schemas, refined validators (`breakdownSchemaFor`, `scriptsSchemaFor`, `promptsSchemaFor`), `STEP_TASK`, `EDITABLE_STEPS`, `stepIndex`, `sameName`, render-time estimate helpers.
- `letter.ts` (create) — pure `autoLetter` placement (§9.3) and text-box estimate.
- `index.ts` (modify) — re-export `episode` and `letter`.

**`packages/server/src/`**
- `workflows/emit.ts` (create) — `emitEntity()` for the M4 modules.
- `workflows/episode/prompts/{premise,outline,breakdown,scripts,prompts}.md` (create) — the LLM prompts.
- `workflows/episode/prompts.ts` — prompt loader + `{{placeholder}}` renderer.
- `workflows/episode/steps.ts` — step-array helpers, `LlmStepName`, `requireOutput`, `STEP_PROGRESS`.
- `workflows/episode/chapter.ts` — `chapterPanels` (story panels in reading order, then the cover panel).
- `workflows/episode/context.ts` — per-step LLM context objects, `<context>` block encode/decode.
- `workflows/episode/validation.ts` — `validationSchema(store, run, step)`.
- `workflows/episode/effects.ts` — premise → chapter, outline → characters, scripts → pages/panels/cover, prompts → panels.
- `workflows/episode/llm.ts` — `executeLlmStep`.
- `workflows/episode/render.ts` — render driver, review rounds, `retryPatch`, estimate.
- `workflows/episode/lettering.ts` — lettering driver.
- `workflows/episode/runner.ts` — `EpisodeRunner` state machine.
- `workflows/episode/routes.ts` — episode routes + `POST /api/pages/:id/auto-letter`.
- `workflows/episode/module.ts` — `episodeModule`.
- `domain/lettering.ts` (create) — `letterPage(store, pageId)`.
- `dev/fake-episode.ts` (create) — `EPISODE_FAKE_RESPONSES`; `dev/fake-responses.ts` (modify) spreads it.
- `export/slug.ts`, `export/paths.ts`, `export/hires.ts`, `export/pdf.ts`, `export/browser.ts`, `export/job.ts`, `export/routes.ts`, `export/module.ts` (create).
- `all-modules.ts` (create) — `defaultModules(d, services?)`: every module of the app on one M2 service set; `main.ts` (modify) uses it.

**`packages/cli/src/`** — `episode-format.ts`, `follow.ts`, `commands/episode.ts`, `commands/export.ts`, `commands/text-auto.ts` (create); `program.ts` (modify).

**`packages/ui/src/`** — `render/printDetail.ts` (create), `render/RenderPage.tsx` (modify); `episode/episodeView.ts`, `episode/JsonForm.tsx`, `episode/episode.css` (create); `chapter/EpisodePanel.tsx`, `chapter/CreateChapterAiSection.tsx` (replace the M3 stubs, same props); `chapter/aiSection.ts` (create); `editor/exportView.ts`, `editor/AutoLetterButton.tsx` (create); `editor/ExportButton.tsx` (replace the M3 stub); `editor/EditorToolbar.tsx` (modify: two lines); `ui/icons.ts` (modify).

**Root** — `scripts/smoke.mjs` (create), `package.json` (`smoke` script), `e2e/episode-export.spec.ts` (create; runs under M3's `playwright.config.ts`).

**Tests** — `packages/shared/test/{episode,letter}.test.ts`; `packages/server/test/helpers/{fake-queue,episode-fixtures,m4-server}.ts`; `packages/server/test/{m4-preflight,episode-prompts,fake-episode,episode-effects,lettering-domain,episode-render,episode-runner,episode-routes,episode-autopilot,export-paths,export-hires,export-job,export-render}.test.ts`; `packages/cli/test/{episode-format,episode-commands}.test.ts`; `packages/ui/test/{print-detail,episode-view,ai-section,export-view}.test.ts`; `e2e/episode-export.spec.ts`.

## Task list

1. Preflight: dependencies and consumed-symbol check
2. Shared: episode step schemas
3. Shared: `autoLetter` placement
4. Server: episode prompts, contexts and validation
5. Server: fake `episode.*` responses
6. Server: step effects (chapter, characters, pages, prompts)
7. Server: `letterPage` domain service
8. Server: render and lettering drivers
9. Server: `EpisodeRunner` state machine and LLM steps
10. Server: episode routes, `episodeModule`, `defaultModules`
11. Server: full autopilot integration test
12. Server: export slugs and paths
13. Server: print-resolution planning and `/api/pages/:id/print`
14. Server: export job, Playwright renderer, PDF merge, `POST /api/export`
15. Server: real-browser export test
16. CLI: `episode`, `export`, `text auto`
17. UI: print route uses print-resolution images
18. UI: `EpisodePanel` stepper
19. UI: `CreateChapterAiSection`
20. UI: export popover and auto-letter button
21. E2E: autopilot chapter → PDF
22. Live smoke test and contract update

---

### Task 1: Preflight — dependencies and consumed-symbol check

**Files:**
- Modify: `packages/server/package.json` (dependencies `playwright`, `pdf-lib`)
- Test: `packages/server/test/m4-preflight.test.ts`

**Interfaces:**
- Consumes: every M1/M2 symbol listed under "Cross-milestone assumptions".
- Produces: `playwright@1.62.1` and `pdf-lib@^1.17.1` as `@manga/server` dependencies; a Chromium build for Playwright.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/m4-preflight.test.ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';
import { startServer } from '../src/app.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createCharacter } from '../src/domain/characters.js';
import { deletePage } from '../src/domain/delete.js';
import { createFrame } from '../src/domain/frames.js';
import { chapterPages } from '../src/domain/order.js';
import { createCoverPage, createPage, NeedsConfirmError, pageDetail } from '../src/domain/pages.js';
import { randomSeed } from '../src/domain/seed.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { Engines } from '../src/engines/resolve.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { promptStyleFor, routeRecipe } from '../src/imaging/route.js';
import { GpuArbiter, JobQueue, PermanentError, TransientError } from '../src/jobs/index.js';
import { registerLlmStep } from '../src/jobs/llm-step.js';
import { aiModule } from '../src/modules/ai.js';
import { imagingModule } from '../src/modules/imaging.js';
import { servicesFor } from '../src/modules/services.js';
import { NotFoundError, openStore } from '../src/store/index.js';

describe('M4 preflight', () => {
  it('finds every M1/M2 function M4 consumes', () => {
    const fns = [
      startServer, createCharacter, deletePage, createFrame, chapterPages, createCoverPage, createPage, pageDetail, randomSeed,
      promptStyleFor, routeRecipe, registerLlmStep, aiModule, imagingModule, servicesFor, openStore,
    ];
    for (const fn of fns) expect(typeof fn).toBe('function');
  });

  it('finds every M1/M2 class M4 consumes', () => {
    const classes = [NeedsConfirmError, Engines, ScriptedEngine, InvalidOutputError, ConflictError, ValidationError, EventBus, GpuArbiter, JobQueue, PermanentError, TransientError, NotFoundError];
    for (const cls of classes) expect(typeof cls).toBe('function');
    expect(typeof FAKE_RESPONSES).toBe('object');
  });

  it('has playwright, a Chromium build and pdf-lib available to the server', () => {
    expect(typeof PDFDocument.create).toBe('function');
    expect(existsSync(chromium.executablePath())).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/m4-preflight.test.ts`
Expected: FAIL — `Failed to load url pdf-lib` (or `playwright`). If instead an import under `../src/` fails, M1/M2 exported that name from a different file: find it with `grep -rn "export .*<Name>" packages/server/src` and fix the specifier in this test **and** in the "Consumed" list at the top of this plan before continuing.

- [ ] **Step 3: Install the dependencies and the browser**

```bash
npm install playwright@1.62.1 pdf-lib@^1.17.1 --workspace @manga/server
npx playwright install chromium
```

Expected: `packages/server/package.json` now lists `"playwright": "1.62.1"` and `"pdf-lib": "^1.17.1"` under `dependencies`; the second command prints `Chromium … downloaded` or nothing (already installed by M3's E2E setup).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/m4-preflight.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/test/m4-preflight.test.ts
git commit -m "chore(server): add playwright and pdf-lib; preflight check of M1/M2 symbols used by M4" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared — episode step schemas

**Files:**
- Create: `packages/shared/src/episode.ts`
- Modify: `packages/shared/src/index.ts` (append one export line)
- Test: `packages/shared/test/episode.test.ts`

**Interfaces:**
- Consumes: `PRESET_NAMES`, `presetPanelCount` (`./layout/index.js`); `AngleSchema`, `CharacterRoleSchema`, `DialogueKindSchema`, `EPISODE_STEPS`, `ShotSchema`, `StagePositionSchema`, `EpisodeStepName`, `Task` (`./schemas.js`).
- Produces (all exported from `@manga/shared`):
  - `PremiseOutputSchema` / `PremiseOutput` `{title, synopsis, tone, setting}`
  - `OutlineSceneSchema` / `OutlineScene`, `NewCharacterDraftSchema` / `NewCharacterDraft`, `OutlineOutputSchema` / `OutlineOutput` `{scenes, newCharacters}`
  - `BreakdownPageSchema` / `BreakdownPage`, `BreakdownOutputSchema` / `BreakdownOutput`, `interface BreakdownRules { pages: number; sceneCount: number }`, `breakdownSchemaFor(rules): z.ZodType<BreakdownOutput>`
  - `PanelCharacterDraftSchema`, `DialogueDraftSchema`, `PanelScriptDraftSchema` / `PanelScriptDraft`, `ScriptsOutputSchema` / `ScriptsOutput`, `interface ScriptsRules { panelCounts: number[]; knownNames: string[] }`, `scriptsSchemaFor(rules): z.ZodType<ScriptsOutput>`
  - `PromptsOutputSchema` / `PromptsOutput`, `interface PromptsRules { panelIds: string[] }`, `promptsSchemaFor(rules): z.ZodType<PromptsOutput>`
  - `RenderOutputSchema` / `RenderOutput` `{jobs, reviewed, flagged, rounds}`, `LetteringOutputSchema` / `LetteringOutput` `{frames}`
  - `STEP_OUTPUT_SCHEMAS: Record<EpisodeStepName, z.ZodType>`, `STEP_TASK: Record<EpisodeStepName, Task | null>`, `EDITABLE_STEPS: ReadonlySet<EpisodeStepName>`, `stepIndex(name): number`, `sameName(a, b): boolean`
  - `RECIPE_AVG_SECONDS: Record<string, number>`, `DEFAULT_RECIPE_SECONDS = 20`, `estimateSeconds(recipes: Array<string | null>): number`, `formatEstimate(seconds): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/episode.test.ts
import { describe, expect, it } from 'vitest';
import {
  EDITABLE_STEPS, OutlineOutputSchema, PremiseOutputSchema, RenderOutputSchema, STEP_OUTPUT_SCHEMAS, STEP_TASK,
  breakdownSchemaFor, estimateSeconds, formatEstimate, promptsSchemaFor, sameName, scriptsSchemaFor, stepIndex,
  type PanelScriptDraft,
} from '../src/episode.js';
import { PRESET_NAMES, presetPanelCount } from '../src/layout/index.js';

const TWO = PRESET_NAMES.find((n) => presetPanelCount(n) === 2)!;
const THREE = PRESET_NAMES.find((n) => presetPanelCount(n) === 3)!;
const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

const panel = (over: Partial<PanelScriptDraft> = {}): PanelScriptDraft => ({
  action: 'Aiko opens the door', shot: 'medium', angle: 'eye',
  characters: [{ name: 'Aiko', pose: 'standing', expression: 'surprised', position: 'left' }],
  background: 'hallway', dialogue: [{ speaker: 'Aiko', kind: 'speech', text: 'Who is there?' }], ...over,
});

describe('premise and outline', () => {
  it('accepts a complete premise and rejects an empty title', () => {
    expect(PremiseOutputSchema.safeParse({ title: 'Rain', synopsis: 'A cat.', tone: 'soft', setting: 'Kyiv' }).success).toBe(true);
    expect(PremiseOutputSchema.safeParse({ title: '', synopsis: 'A cat.', tone: '', setting: '' }).success).toBe(false);
  });

  it('needs at least one scene and a valid role for new characters', () => {
    expect(OutlineOutputSchema.safeParse({ scenes: [], newCharacters: [] }).success).toBe(false);
    const scene = { summary: 'They meet', purpose: 'setup', location: 'street', characterNames: ['Aiko'] };
    expect(OutlineOutputSchema.safeParse({ scenes: [scene], newCharacters: [] }).success).toBe(true);
    const bad = { name: 'Mika', role: 'hero', personality: '', speechStyle: '', appearanceTags: '1girl' };
    expect(OutlineOutputSchema.safeParse({ scenes: [scene], newCharacters: [bad] }).success).toBe(false);
  });
});

describe('breakdownSchemaFor', () => {
  const schema = breakdownSchemaFor({ pages: 2, sceneCount: 2 });
  const page = (layoutPreset: string, panelCount: number, sceneIdx = [0]) => ({ sceneIdx, panelCount, pacing: 'steady', layoutPreset });

  it('accepts presets whose panel count matches', () => {
    expect(schema.safeParse({ pages: [page(TWO, 2), page(THREE, 3, [1])] }).success).toBe(true);
  });

  it('rejects an unknown preset and names the valid ones', () => {
    const r = schema.safeParse({ pages: [page('nope', 2), page(TWO, 2)] });
    expect(issuesOf(r)[0]).toMatch(/^pages\.0\.layoutPreset: unknown layout preset "nope"; use one of: /);
  });

  it('rejects a preset whose panel count differs', () => {
    const r = schema.safeParse({ pages: [page(TWO, 3), page(TWO, 2)] });
    expect(issuesOf(r)).toEqual([`pages.0.panelCount: layout "${TWO}" has 2 panels but panelCount is 3`]);
  });

  it('rejects the wrong number of pages and out-of-range scene indexes', () => {
    const r = schema.safeParse({ pages: [page(TWO, 2, [0, 5])] });
    expect(issuesOf(r)).toEqual([
      'pages: expected exactly 2 pages, got 1',
      'pages.0.sceneIdx.1: scene index 5 does not exist (the outline has 2 scenes, numbered from 0)',
    ]);
  });
});

describe('scriptsSchemaFor', () => {
  const schema = scriptsSchemaFor({ panelCounts: [2], knownNames: ['Aiko', 'Ren'] });

  it('accepts known names and null speakers', () => {
    const narration = panel({ dialogue: [{ speaker: null, kind: 'narration', text: 'Night.' }] });
    expect(schema.safeParse({ pages: [{ panels: [panel(), narration] }] }).success).toBe(true);
  });

  it('scripts schema matches names case-insensitively', () => {
    const odd = panel({
      characters: [{ name: '  aiko ', pose: '', expression: '', position: 'center' }],
      dialogue: [{ speaker: 'REN', kind: 'shout', text: 'Wait!' }],
    });
    expect(schema.safeParse({ pages: [{ panels: [odd, panel()] }] }).success).toBe(true);
  });

  it('rejects unknown characters and speakers with the valid names listed', () => {
    const stranger = panel({ dialogue: [{ speaker: 'Mika', kind: 'speech', text: 'Hi' }] });
    const r = schema.safeParse({ pages: [{ panels: [stranger, panel()] }] });
    expect(issuesOf(r)).toEqual(['pages.0.panels.0.dialogue.0.speaker: unknown character "Mika"; use one of: Aiko, Ren']);
  });

  it('rejects a page whose panel count differs from the breakdown', () => {
    const r = schema.safeParse({ pages: [{ panels: [panel()] }] });
    expect(issuesOf(r)).toEqual(['pages.0.panels: page 1 needs exactly 2 panels (from the breakdown), got 1']);
  });
});

describe('promptsSchemaFor', () => {
  const schema = promptsSchemaFor({ panelIds: ['pn_a', 'pn_b'] });

  it('accepts exactly one entry per panel id', () => {
    expect(schema.safeParse({ panels: [{ panelId: 'pn_b', scene: 'rain' }, { panelId: 'pn_a', scene: 'sun', negative: 'blur' }] }).success).toBe(true);
  });

  it('rejects unknown, duplicate and missing ids', () => {
    const r = schema.safeParse({ panels: [{ panelId: 'pn_a', scene: 'x' }, { panelId: 'pn_a', scene: 'y' }, { panelId: 'pn_zz', scene: 'z' }] });
    expect(issuesOf(r)).toEqual([
      'panels.1.panelId: duplicate panelId "pn_a"',
      'panels.2.panelId: unknown panelId "pn_zz"',
      'panels: missing panelIds: pn_b',
    ]);
  });
});

describe('step tables and estimates', () => {
  it('maps steps to tasks, editability and indexes', () => {
    expect(STEP_TASK).toEqual({ premise: 'story', outline: 'story', breakdown: 'story', scripts: 'story', prompts: 'prompts', render: null, lettering: null });
    expect([...EDITABLE_STEPS]).toEqual(['premise', 'outline', 'breakdown', 'scripts', 'prompts']);
    expect(stepIndex('scripts')).toBe(3);
    expect(STEP_OUTPUT_SCHEMAS.render).toBe(RenderOutputSchema);
  });

  it('compares names loosely', () => {
    expect(sameName(' Aiko  Tanaka', 'aiko tanaka')).toBe(true);
    expect(sameName('Олена', 'ОЛЕНА')).toBe(true);
    expect(sameName('Aiko', 'Aika')).toBe(false);
  });

  it('estimates render time from recipe averages', () => {
    expect(estimateSeconds(['anime', 'qwen-edit-ref', null, 'mystery'])).toBe(110);
    expect(formatEstimate(45)).toBe('~45 s');
    expect(formatEstimate(110)).toBe('~2 min');
    expect(formatEstimate(3900)).toBe('~1 h 5 min');
    expect(formatEstimate(7200)).toBe('~2 h');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/shared/test/episode.test.ts`
Expected: FAIL — `Failed to load url ../src/episode.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/episode.ts
import { z } from 'zod';
import { PRESET_NAMES, presetPanelCount } from './layout/index.js';
import {
  AngleSchema, CharacterRoleSchema, DialogueKindSchema, EPISODE_STEPS, ShotSchema, StagePositionSchema,
  type EpisodeStepName, type Task,
} from './schemas.js';

/** Trim, collapse inner whitespace, lower-case (works for Cyrillic). */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

export function stepIndex(name: EpisodeStepName): number {
  return EPISODE_STEPS.indexOf(name);
}

// ---- 1. premise ----
export const PremiseOutputSchema = z.object({
  title: z.string().min(1), synopsis: z.string().min(1), tone: z.string(), setting: z.string(),
});
export type PremiseOutput = z.infer<typeof PremiseOutputSchema>;

// ---- 2. outline ----
export const OutlineSceneSchema = z.object({
  summary: z.string().min(1), purpose: z.string(), location: z.string(), characterNames: z.array(z.string().min(1)),
});
export type OutlineScene = z.infer<typeof OutlineSceneSchema>;
export const NewCharacterDraftSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema, personality: z.string(), speechStyle: z.string(), appearanceTags: z.string().min(1),
});
export type NewCharacterDraft = z.infer<typeof NewCharacterDraftSchema>;
export const OutlineOutputSchema = z.object({
  scenes: z.array(OutlineSceneSchema).min(1), newCharacters: z.array(NewCharacterDraftSchema).max(5),
});
export type OutlineOutput = z.infer<typeof OutlineOutputSchema>;

// ---- 3. breakdown ----
export const BreakdownPageSchema = z.object({
  sceneIdx: z.array(z.number().int().min(0)).min(1),
  panelCount: z.number().int().min(1).max(9),
  pacing: z.string(),
  layoutPreset: z.string().min(1),
});
export type BreakdownPage = z.infer<typeof BreakdownPageSchema>;
export const BreakdownOutputSchema = z.object({ pages: z.array(BreakdownPageSchema).min(1).max(30) });
export type BreakdownOutput = z.infer<typeof BreakdownOutputSchema>;
export interface BreakdownRules { pages: number; sceneCount: number }

/** Refined so a violation goes through the engine's correction round (spec §8: preset must exist and match panelCount). */
export function breakdownSchemaFor(rules: BreakdownRules): z.ZodType<BreakdownOutput> {
  return BreakdownOutputSchema.superRefine((value, ctx) => {
    if (value.pages.length !== rules.pages) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `expected exactly ${rules.pages} pages, got ${value.pages.length}` });
    }
    value.pages.forEach((page, i) => {
      if (!PRESET_NAMES.includes(page.layoutPreset)) {
        ctx.addIssue({
          code: 'custom', path: ['pages', i, 'layoutPreset'],
          message: `unknown layout preset "${page.layoutPreset}"; use one of: ${PRESET_NAMES.join(', ')}`,
        });
      } else {
        const count = presetPanelCount(page.layoutPreset);
        if (count !== page.panelCount) {
          ctx.addIssue({
            code: 'custom', path: ['pages', i, 'panelCount'],
            message: `layout "${page.layoutPreset}" has ${count} panels but panelCount is ${page.panelCount}`,
          });
        }
      }
      page.sceneIdx.forEach((s, j) => {
        if (s >= rules.sceneCount) {
          ctx.addIssue({
            code: 'custom', path: ['pages', i, 'sceneIdx', j],
            message: `scene index ${s} does not exist (the outline has ${rules.sceneCount} scenes, numbered from 0)`,
          });
        }
      });
    });
  });
}

// ---- 4. scripts (names, not ids; mapped to ids on materialization) ----
export const PanelCharacterDraftSchema = z.object({
  name: z.string().min(1), pose: z.string(), expression: z.string(), position: StagePositionSchema,
});
export const DialogueDraftSchema = z.object({ speaker: z.string().min(1).nullable(), kind: DialogueKindSchema, text: z.string().min(1) });
export const PanelScriptDraftSchema = z.object({
  action: z.string().min(1), shot: ShotSchema, angle: AngleSchema,
  characters: z.array(PanelCharacterDraftSchema).max(4), background: z.string(), dialogue: z.array(DialogueDraftSchema).max(6),
});
export type PanelScriptDraft = z.infer<typeof PanelScriptDraftSchema>;
export const ScriptsOutputSchema = z.object({ pages: z.array(z.object({ panels: z.array(PanelScriptDraftSchema).min(1) })).min(1) });
export type ScriptsOutput = z.infer<typeof ScriptsOutputSchema>;
export interface ScriptsRules { panelCounts: number[]; knownNames: string[] }

export function scriptsSchemaFor(rules: ScriptsRules): z.ZodType<ScriptsOutput> {
  const known = (name: string): boolean => rules.knownNames.some((k) => sameName(k, name));
  const valid = rules.knownNames.join(', ') || '(none — this manga has no characters, so use no characters and null speakers)';
  return ScriptsOutputSchema.superRefine((value, ctx) => {
    if (value.pages.length !== rules.panelCounts.length) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `expected exactly ${rules.panelCounts.length} pages (from the breakdown), got ${value.pages.length}` });
    }
    value.pages.forEach((page, i) => {
      const want = rules.panelCounts[i];
      if (want !== undefined && page.panels.length !== want) {
        ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels'], message: `page ${i + 1} needs exactly ${want} panels (from the breakdown), got ${page.panels.length}` });
      }
      page.panels.forEach((p, j) => {
        p.characters.forEach((c, k) => {
          if (!known(c.name)) ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels', j, 'characters', k, 'name'], message: `unknown character "${c.name}"; use one of: ${valid}` });
        });
        p.dialogue.forEach((d, k) => {
          if (d.speaker !== null && !known(d.speaker)) {
            ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels', j, 'dialogue', k, 'speaker'], message: `unknown character "${d.speaker}"; use one of: ${valid}` });
          }
        });
      });
    });
  });
}

// ---- 5. prompts ----
export const PromptsOutputSchema = z.object({
  panels: z.array(z.object({ panelId: z.string().min(3), scene: z.string().min(1), negative: z.string().optional() })).min(1),
});
export type PromptsOutput = z.infer<typeof PromptsOutputSchema>;
export interface PromptsRules { panelIds: string[] }

export function promptsSchemaFor(rules: PromptsRules): z.ZodType<PromptsOutput> {
  const allowed = new Set(rules.panelIds);
  return PromptsOutputSchema.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.panels.forEach((p, i) => {
      if (seen.has(p.panelId)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'panelId'], message: `duplicate panelId "${p.panelId}"` });
      else if (!allowed.has(p.panelId)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'panelId'], message: `unknown panelId "${p.panelId}"` });
      seen.add(p.panelId);
    });
    const missing = rules.panelIds.filter((id) => !seen.has(id));
    if (missing.length > 0) ctx.addIssue({ code: 'custom', path: ['panels'], message: `missing panelIds: ${missing.join(', ')}` });
  });
}

// ---- 6. render, 7. lettering (informational outputs) ----
export const RenderOutputSchema = z.object({
  jobs: z.array(z.string()), reviewed: z.number().int().min(0), flagged: z.number().int().min(0), rounds: z.number().int().min(0),
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;
export const LetteringOutputSchema = z.object({ frames: z.number().int().min(0) });
export type LetteringOutput = z.infer<typeof LetteringOutputSchema>;

/** Base (unrefined) schema per step: what the UI can check locally. The server validates edits with the refined ones. */
export const STEP_OUTPUT_SCHEMAS: Record<EpisodeStepName, z.ZodType> = {
  premise: PremiseOutputSchema, outline: OutlineOutputSchema, breakdown: BreakdownOutputSchema, scripts: ScriptsOutputSchema,
  prompts: PromptsOutputSchema, render: RenderOutputSchema, lettering: LetteringOutputSchema,
};

/** Spec §8 "Task(s)". scripts writes dialogue in the same call, so it runs as 'story'. render/lettering are not LLM steps. */
export const STEP_TASK: Record<EpisodeStepName, Task | null> = {
  premise: 'story', outline: 'story', breakdown: 'story', scripts: 'story', prompts: 'prompts', render: null, lettering: null,
};

export const EDITABLE_STEPS: ReadonlySet<EpisodeStepName> = new Set<EpisodeStepName>(['premise', 'outline', 'breakdown', 'scripts', 'prompts']);

// ---- render-time estimate (spec §8: "panels × recipe average") ----
export const RECIPE_AVG_SECONDS: Record<string, number> = {
  anime: 10, 'anime-ref': 12, 'anime-pose': 12, 'anime-refine': 6, 'qwen-edit-ref': 60, 'klein-ref': 10, anima: 20, 'anima-turbo': 8, upscale: 8,
};
export const DEFAULT_RECIPE_SECONDS = 20;

export function estimateSeconds(recipes: Array<string | null>): number {
  return recipes.reduce((sum, r) => sum + (r !== null ? RECIPE_AVG_SECONDS[r] ?? DEFAULT_RECIPE_SECONDS : DEFAULT_RECIPE_SECONDS), 0);
}

export function formatEstimate(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './episode.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/episode.test.ts`
Expected: PASS — `Tests  15 passed (15)`.

Run: `npx tsc --build packages/shared/tsconfig.json`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/episode.ts packages/shared/src/index.ts packages/shared/test/episode.test.ts
git commit -m "feat(shared): episode step output schemas with refined breakdown/scripts/prompts validation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared — `autoLetter` placement

**Files:**
- Create: `packages/shared/src/letter.ts`
- Modify: `packages/shared/src/index.ts` (append one export line)
- Test: `packages/shared/test/letter.test.ts`

**Interfaces:**
- Consumes: `FONT_FOR_KIND`, `DEFAULT_FONT_SIZE` (`./fonts.js`); `readingOrder`, `Rect` (`./layout/index.js`); `Box`, `DialogueLine`, `FrameKind`, `LayoutNode`, `PageFormat`, `PanelScript`, `ReadingDirection` (`./schemas.js`).
- Produces (exported from `@manga/shared`):
  - `PT_TO_MM`, `TAIL_Y = 0.4`
  - `interface LetterPanel { id: string; rect: Rect; script: PanelScript }`
  - `interface ExistingFrame { panelId: string | null; text: string; box: Box; order: number }`
  - `interface AutoLetterInput { layout: LayoutNode; format: PageFormat; direction: ReadingDirection; panels: LetterPanel[]; existingFrames: ExistingFrame[] }`
  - `interface LetterFrame { panelId; kind: FrameKind; text; speakerId: string | null; box: Box; tail: {x,y} | null; rotation; font; fontSize; align: 'left'|'center'|'right'; order }`
  - `wrapText(text, charsPerLine): string[]`, `estimateTextBoxMm(text, fontSizePt, maxWidthMm): { w; h; lines }`, `autoLetter(input): LetterFrame[]`

Placement rules (spec §9.3), all in page-normalized units: a 2 mm inset inside the panel and a 1.5 mm gap between frames; frames of one panel are placed narration first, then speech/thought/shout in dialogue order, then SFX; bubbles fill a row along the top from the reading-start side (right for RTL, left for LTR), and when a row has no room they drop below the lowest blocking frame; if the panel is full the frame is clamped into the panel's bottom reading-start corner (it may overlap — autoFit and the user fix it). Box size comes from a chars-per-line estimate (0.55 em per character, 1.2 em per line) — speech ×1.42 for the ellipse, thought ×1.5, shout ×1.6, narration +4/+3 mm padding, SFX one line. A line whose exact text already exists as a frame in that panel is skipped, and existing frames count as obstacles.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/letter.test.ts
import { describe, expect, it } from 'vitest';
import { autoLetter, estimateTextBoxMm, wrapText, type ExistingFrame, type LetterFrame } from '../src/letter.js';
import { DEFAULT_FONT_SIZE, FONT_FOR_KIND } from '../src/fonts.js';
import type { Rect } from '../src/layout/index.js';
import { DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, type Box, type DialogueLine, type LayoutNode, type PanelScript, type ReadingDirection } from '../src/schemas.js';

const F = DEFAULT_PAGE_FORMAT;
const IX = 2 / F.widthMm;
const IY = 2 / F.heightMm;
const AIKO = 'cr_aiko00001';
const REN = 'cr_ren000001';
const CAST: PanelScript['characters'] = [
  { characterId: AIKO, pose: '', expression: '', position: 'left' },
  { characterId: REN, pose: '', expression: '', position: 'right' },
];
const WIDE: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.5 };
const script = (dialogue: DialogueLine[], characters = CAST): PanelScript => ({ ...EMPTY_SCRIPT, characters, dialogue });
const speech = (text: string, speakerId: string | null = AIKO): DialogueLine => ({ speakerId, kind: 'speech', text });
const one = (rect: Rect, s: PanelScript, direction: ReadingDirection = 'ltr', existingFrames: ExistingFrame[] = []): LetterFrame[] =>
  autoLetter({ layout: { type: 'panel', id: 'pn_1' }, format: F, direction, panels: [{ id: 'pn_1', rect, script: s }], existingFrames });
const inside = (b: Box, r: Rect): boolean =>
  b.x >= r.x - 1e-9 && b.y >= r.y - 1e-9 && b.x + b.w <= r.x + r.w + 1e-9 && b.y + b.h <= r.y + r.h + 1e-9;
const pointInside = (p: { x: number; y: number }, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
const noOverlaps = (frames: LetterFrame[]): boolean =>
  frames.every((a, i) => frames.every((b, j) => j <= i || a.panelId !== b.panelId || !overlap(a.box, b.box)));

describe('text box estimate', () => {
  it('wraps on words and hard-splits words longer than a line', () => {
    expect(wrapText('a verylongwordhere b', 5)).toEqual(['a', 'veryl', 'ongwo', 'rdher', 'e b']);
  });

  it('grows taller with longer text', () => {
    const short = estimateTextBoxMm('Hi!', 9, 40);
    const long = estimateTextBoxMm('This is a much longer line of dialogue that must wrap onto several lines', 9, 40);
    expect(short.lines).toBe(1);
    expect(long.lines).toBeGreaterThan(2);
    expect(long.h).toBeGreaterThan(short.h);
  });
});

describe('autoLetter', () => {
  it('LTR: the first bubble starts at the top-left inside the panel', () => {
    const [f] = one(WIDE, script([speech('Hello there!')]), 'ltr');
    expect(f!.box.x).toBeCloseTo(WIDE.x + IX, 9);
    expect(f!.box.y).toBeCloseTo(WIDE.y + IY, 9);
    expect(f).toMatchObject({ panelId: 'pn_1', kind: 'speech', text: 'Hello there!', speakerId: AIKO, rotation: 0, align: 'center', order: 0 });
  });

  it('RTL: the first bubble starts at the top-right inside the panel', () => {
    const [f] = one(WIDE, script([speech('Hello there!')]), 'rtl');
    expect(f!.box.x + f!.box.w).toBeCloseTo(WIDE.x + WIDE.w - IX, 9);
    expect(f!.box.y).toBeCloseTo(WIDE.y + IY, 9);
  });

  it('continues toward the reading end on the same row', () => {
    const rtl = one(WIDE, script([speech('First.'), speech('Second.', REN)]), 'rtl');
    expect(rtl[1]!.box.y).toBeCloseTo(rtl[0]!.box.y, 9);
    expect(rtl[1]!.box.x + rtl[1]!.box.w).toBeLessThanOrEqual(rtl[0]!.box.x);
    const ltr = one(WIDE, script([speech('First.'), speech('Second.', REN)]), 'ltr');
    expect(ltr[1]!.box.x).toBeGreaterThanOrEqual(ltr[0]!.box.x + ltr[0]!.box.w);
  });

  it('stacks down into new rows when a row is full, without overlaps', () => {
    const lines = [0, 1, 2, 3, 4].map((i) => speech(`Line ${i}: where did you put the umbrella?`, i % 2 ? REN : AIKO));
    const frames = one(WIDE, script(lines), 'rtl');
    expect(frames).toHaveLength(5);
    expect(new Set(frames.map((f) => f.box.y.toFixed(6))).size).toBeGreaterThanOrEqual(3);
    expect(noOverlaps(frames)).toBe(true);
    for (const f of frames) expect(inside(f.box, WIDE)).toBe(true);
  });

  it('crowded panel keeps every box and tail inside the panel', () => {
    const small: Rect = { x: 0.1, y: 0.1, w: 0.25, h: 0.12 };
    const long = 'Я не знаю, куди ми йдемо, але якщо ти залишишся тут, то я теж залишуся, бо сама я туди не піду.';
    const frames = one(small, script([speech(long), speech(long, REN), speech(long), { speakerId: null, kind: 'narration', text: long }]), 'rtl');
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect(inside(f.box, small)).toBe(true);
      if (f.tail) expect(pointInside(f.tail, small)).toBe(true);
    }
  });

  it('points the tail at the speaker position at 40% of the panel height', () => {
    const [a, r] = one(WIDE, script([speech('Left!', AIKO), speech('Right!', REN)]), 'ltr');
    expect(a!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.2, 9);
    expect(r!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.8, 9);
    expect(a!.tail!.y).toBeCloseTo(WIDE.y + WIDE.h * 0.4, 9);
  });

  it('pushes the tail below a bubble that reaches past 40% of the panel', () => {
    const flat: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.06 };
    const [f] = one(flat, script([speech('Hello there!')]), 'ltr');
    expect(f!.tail!.y).toBeGreaterThan(f!.box.y + f!.box.h);
    expect(f!.tail!.y).toBeLessThanOrEqual(flat.y + flat.h);
  });

  it('points to the panel centre when the speaker is not in the panel', () => {
    const [f] = one(WIDE, script([speech('Who said that?', 'cr_offscreen1')]), 'ltr');
    expect(f!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.5, 9);
  });

  it('puts narration first, in the reading-start top corner, without a tail', () => {
    const frames = one(WIDE, script([speech('Hi.'), { speakerId: null, kind: 'narration', text: 'Meanwhile, in Kyiv.' }]), 'rtl');
    const n = frames[0]!;
    expect(n).toMatchObject({ kind: 'narration', tail: null, align: 'left', order: 0, font: FONT_FOR_KIND.narration });
    expect(n.box.x + n.box.w).toBeCloseTo(WIDE.x + WIDE.w - IX, 9);
    expect(n.box.y).toBeCloseTo(WIDE.y + IY, 9);
    expect(frames[1]).toMatchObject({ kind: 'speech', order: 1 });
  });

  it('centres SFX, rotates it −10° and keeps it clear of the bubbles', () => {
    const frames = one(WIDE, script([{ speakerId: null, kind: 'sfx', text: 'BANG' }, speech('What was that?')]), 'ltr');
    const sfx = frames.find((f) => f.kind === 'sfx')!;
    expect(sfx).toMatchObject({ rotation: -10, tail: null, font: FONT_FOR_KIND.sfx, fontSize: DEFAULT_FONT_SIZE.sfx });
    expect(sfx.box.x + sfx.box.w / 2).toBeCloseTo(WIDE.x + WIDE.w / 2, 9);
    expect(sfx.order).toBe(1);
    expect(noOverlaps(frames)).toBe(true);
  });

  it('uses the font and size of the kind', () => {
    const frames = one(WIDE, script([speech('Hey.'), { speakerId: REN, kind: 'shout', text: 'RUN!' }, { speakerId: AIKO, kind: 'thought', text: 'Hmm.' }]), 'ltr');
    expect(frames.map((f) => [f.kind, f.font, f.fontSize])).toEqual([
      ['speech', FONT_FOR_KIND.speech, DEFAULT_FONT_SIZE.speech],
      ['shout', FONT_FOR_KIND.shout, DEFAULT_FONT_SIZE.shout],
      ['thought', FONT_FOR_KIND.thought, DEFAULT_FONT_SIZE.thought],
    ]);
  });

  it('follows the reading order of panels and continues existing order numbers', () => {
    const layout: LayoutNode = { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } };
    const frames = autoLetter({
      layout, format: F, direction: 'rtl',
      panels: [
        { id: 'pn_a', rect: { x: 0.05, y: 0.05, w: 0.43, h: 0.9 }, script: script([speech('Left panel.')]) },
        { id: 'pn_b', rect: { x: 0.52, y: 0.05, w: 0.43, h: 0.9 }, script: script([speech('Right panel.')]) },
      ],
      existingFrames: [{ panelId: null, text: 'page note', box: { x: 0, y: 0.97, w: 0.2, h: 0.02 }, order: 4 }],
    });
    expect(frames.map((f) => [f.panelId, f.order])).toEqual([['pn_b', 5], ['pn_a', 6]]);
  });

  it('skips lines already lettered in the panel and avoids their boxes', () => {
    const existing: ExistingFrame = { panelId: 'pn_1', text: 'Hello', box: { x: WIDE.x + IX, y: WIDE.y + IY, w: 0.2, h: 0.03 }, order: 0 };
    const frames = one(WIDE, script([speech('Hello'), speech('Second line')]), 'ltr', [existing]);
    expect(frames.map((f) => f.text)).toEqual(['Second line']);
    expect(overlap(frames[0]!.box, existing.box)).toBe(false);
    expect(frames[0]!.order).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/shared/test/letter.test.ts`
Expected: FAIL — `Failed to load url ../src/letter.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/letter.ts
import { DEFAULT_FONT_SIZE, FONT_FOR_KIND } from './fonts.js';
import { readingOrder, type Rect } from './layout/index.js';
import type { Box, DialogueLine, FrameKind, LayoutNode, PageFormat, PanelScript, ReadingDirection } from './schemas.js';

export const PT_TO_MM = 25.4 / 72;
/** Spec §9.3: the tail tip points at the speaker, 40 % down the panel. */
export const TAIL_Y = 0.4;
const CHAR_W_EM = 0.55;
const LINE_H_EM = 1.2;
const INSET_MM = 2;
const GAP_MM = 1.5;
const EPS = 1e-9;
const POSITION_X = { left: 0.2, center: 0.5, right: 0.8 } as const;

export interface LetterPanel { id: string; rect: Rect; script: PanelScript }
export interface ExistingFrame { panelId: string | null; text: string; box: Box; order: number }
export interface AutoLetterInput {
  layout: LayoutNode; format: PageFormat; direction: ReadingDirection; panels: LetterPanel[]; existingFrames: ExistingFrame[];
}
export interface LetterFrame {
  panelId: string; kind: FrameKind; text: string; speakerId: string | null; box: Box; tail: { x: number; y: number } | null;
  rotation: number; font: string; fontSize: number; align: 'left' | 'center' | 'right'; order: number;
}

interface Area { left: number; right: number; top: number; bottom: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Greedy word wrap by character count; words longer than a line are hard-split. */
export function wrapText(text: string, charsPerLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.trim().split(/\s+/).filter(Boolean)) {
    while (word.length > charsPerLine) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, charsPerLine));
      word = word.slice(charsPerLine);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= charsPerLine) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/** Size of the text block in mm (the UI's auto-fit shrinks the font later if this is off). */
export function estimateTextBoxMm(text: string, fontSizePt: number, maxWidthMm: number): { w: number; h: number; lines: number } {
  const em = fontSizePt * PT_TO_MM;
  const perLine = Math.max(4, Math.floor(maxWidthMm / (em * CHAR_W_EM)));
  const lines = wrapText(text, perLine);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { w: longest * em * CHAR_W_EM, h: lines.length * em * LINE_H_EM, lines: lines.length };
}

function frameSizeMm(kind: FrameKind, text: string, fontSize: number, panelWidthMm: number): { w: number; h: number } {
  if (kind === 'narration') {
    const t = estimateTextBoxMm(text, fontSize, Math.min(panelWidthMm * 0.5, 50));
    return { w: t.w + 4, h: t.h + 3 };
  }
  if (kind === 'sfx') {
    const em = fontSize * PT_TO_MM;
    return { w: text.length * em * CHAR_W_EM * 1.1 + 2, h: em * LINE_H_EM + 2 };
  }
  const t = estimateTextBoxMm(text, fontSize, Math.min(panelWidthMm * 0.42, 42));
  const k = kind === 'shout' ? 1.6 : kind === 'thought' ? 1.5 : 1.42; // text box inscribed in the ellipse/cloud/burst
  return { w: t.w * k + 2, h: t.h * k + 2 };
}

/** True when a and b are closer than the gap (EPS keeps "exactly one gap apart" from counting as a hit). */
function tooClose(a: Box, b: Box, gx: number, gy: number): boolean {
  return a.x < b.x + b.w + gx - EPS && b.x < a.x + a.w + gx - EPS && a.y < b.y + b.h + gy - EPS && b.y < a.y + a.h + gy - EPS;
}

function placeBubble(w: number, h: number, area: Area, dir: ReadingDirection, occupied: Box[], gx: number, gy: number): Box {
  let y = area.top;
  for (let row = 0; row < 500 && y + h <= area.bottom + EPS; row++) {
    let x = dir === 'rtl' ? area.right - w : area.left;
    for (let step = 0; step < 500 && x >= area.left - EPS && x + w <= area.right + EPS; step++) {
      const cand: Box = { x, y, w, h };
      const hit = occupied.find((o) => tooClose(cand, o, gx, gy));
      if (!hit) return cand;
      x = dir === 'rtl' ? hit.x - gx - w : hit.x + hit.w + gx;
    }
    const blockers = occupied.filter((o) => o.y < y + h + gy - EPS && y < o.y + o.h + gy - EPS).map((o) => o.y + o.h + gy);
    const next = blockers.length > 0 ? Math.min(...blockers) : y + gy;
    y = next > y + EPS ? next : y + gy;
  }
  // No room left: clamp into the bottom reading-start corner (may overlap; the user adjusts).
  return { x: dir === 'rtl' ? area.right - w : area.left, y: Math.max(area.top, area.bottom - h), w, h };
}

function placeSfx(w: number, h: number, area: Area, occupied: Box[], gy: number): Box {
  const x = (area.left + area.right) / 2 - w / 2;
  const centred = (area.top + area.bottom) / 2 - h / 2;
  const lowest = occupied.reduce((m, o) => Math.max(m, o.y + o.h + gy), area.top);
  let y = Math.max(centred, lowest);
  if (y + h > area.bottom) y = Math.max(area.top, area.bottom - h);
  return { x, y, w, h };
}

function tailTip(panel: LetterPanel, line: DialogueLine, box: Box, area: Area): { x: number; y: number } {
  const speaker = line.speakerId === null ? undefined : panel.script.characters.find((c) => c.characterId === line.speakerId);
  const r = panel.rect;
  const x = r.x + r.w * POSITION_X[speaker?.position ?? 'center'];
  let y = r.y + r.h * TAIL_Y;
  const bottom = box.y + box.h;
  if (y < bottom + r.h * 0.05) y = bottom + r.h * 0.08;
  return { x: clamp(x, area.left, area.right), y: clamp(y, area.top, area.bottom) };
}

/** Frames to create for every not-yet-lettered dialogue line, panels in reading order (spec §9.3). Pure. */
export function autoLetter(input: AutoLetterInput): LetterFrame[] {
  const { format, direction } = input;
  const byId = new Map(input.panels.map((p) => [p.id, p]));
  const gx = GAP_MM / format.widthMm;
  const gy = GAP_MM / format.heightMm;
  const ix = INSET_MM / format.widthMm;
  const iy = INSET_MM / format.heightMm;
  let order = input.existingFrames.reduce((m, f) => Math.max(m, f.order), -1) + 1;
  const out: LetterFrame[] = [];

  for (const id of readingOrder(input.layout, direction)) {
    const panel = byId.get(id);
    if (!panel) continue;
    const r = panel.rect;
    const area: Area = { left: r.x + ix, right: r.x + r.w - ix, top: r.y + iy, bottom: r.y + r.h - iy };
    const existing = input.existingFrames.filter((f) => f.panelId === id);
    const occupied: Box[] = existing.map((f) => f.box);
    const todo = panel.script.dialogue.filter((l) => !existing.some((f) => f.text === l.text));
    const sorted = [
      ...todo.filter((l) => l.kind === 'narration'),
      ...todo.filter((l) => l.kind !== 'narration' && l.kind !== 'sfx'),
      ...todo.filter((l) => l.kind === 'sfx'),
    ];
    for (const line of sorted) {
      const kind: FrameKind = line.kind;
      const fontSize = DEFAULT_FONT_SIZE[kind];
      const mm = frameSizeMm(kind, line.text, fontSize, r.w * format.widthMm);
      const w = Math.min(mm.w / format.widthMm, area.right - area.left);
      const h = Math.min(mm.h / format.heightMm, area.bottom - area.top);
      const box = kind === 'sfx' ? placeSfx(w, h, area, occupied, gy) : placeBubble(w, h, area, direction, occupied, gx, gy);
      const tail = kind === 'sfx' || kind === 'narration' ? null : tailTip(panel, line, box, area);
      occupied.push(box);
      out.push({
        panelId: id, kind, text: line.text, speakerId: line.speakerId, box, tail, rotation: kind === 'sfx' ? -10 : 0,
        font: FONT_FOR_KIND[kind], fontSize, align: kind === 'narration' ? 'left' : 'center', order: order++,
      });
    }
  }
  return out;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './letter.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/letter.test.ts`
Expected: PASS — `Tests  15 passed (15)`.

Run: `npx tsc --build packages/shared/tsconfig.json`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/letter.ts packages/shared/src/index.ts packages/shared/test/letter.test.ts
git commit -m "feat(shared): autoLetter frame placement with reading-direction rows, tails and SFX" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Server — episode prompts, contexts and validation

**Files:**
- Create: `packages/server/src/workflows/episode/prompts/premise.md`, `outline.md`, `breakdown.md`, `scripts.md`, `prompts.md`
- Create: `packages/server/src/workflows/episode/prompts.ts`, `steps.ts`, `chapter.ts`, `context.ts`, `validation.ts`
- Create: `packages/server/test/helpers/episode-fixtures.ts`
- Test: `packages/server/test/episode-prompts.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas and `stepIndex`; `chapterPages` (`../../domain/order.js`); `ConflictError` (`../../errors.js`); `promptStyleFor`, `PromptStyle` (`../../imaging/route.js`); `Store` (`../../store/index.js`); test helpers `openTestLibrary`, `seedCharacter` (M2).
- Produces:
  - `steps.ts`: `type LlmStepName`, `LLM_STEPS`, `isLlmStep(name)`, `STEP_PROGRESS: Record<EpisodeStepName, string>`, `nowIso()`, `monotonicIso()` (strictly increasing, used for step tokens), `freshStep(name)`, `freshSteps()`, `patchStep(steps, index, patch)`, `requireOutput<T>(run, name, schema): T` (throws `ConflictError`)
  - `chapter.ts`: `interface ChapterPanel { page: Page; panel: Panel; pageNumber: number; isCover: boolean }`, `storyPages(store, chapterId): Page[]`, `chapterPanels(store, chapterId, dir): ChapterPanel[]` (story pages in order, panels in reading order, then the chapter cover's panel with `pageNumber: 0`)
  - `prompts.ts`: `interface StepPrompt { system: string; user: string }`, `loadStepPrompt(step: LlmStepName): StepPrompt`, `renderTemplate(template, vars): string`
  - `context.ts`: `LANGUAGE_NAME`, `CharacterBrief`, `PremiseContext`, `OutlineContext`, `BreakdownContext`, `ScriptsContext`, `PromptsPanelBrief`, `PromptsContext`, `StepContext`, `buildStepContext(store, run, step)`, `contextBlock(ctx)`, `extractContext<T>(prompt)`, `templateVars(store, run, ctx): Record<string, string>`
  - `validation.ts`: `validationSchema(store, run, step): z.ZodType<unknown>`
  - fixtures: `STAMP`, `seedEpisodeWorld(store, opts?) → { manga, chapter }`, `seedRun(store, chapterId, opts?) → EpisodeRun`, `PREMISE`, `outline(names, newCharacters?)`, `TWO_PANEL_PRESET`, `breakdown(pages, preset?)`, `scripts(bd, speaker)`

Prompt files have two parts separated by a line `<!-- user -->`; everything before it (minus a leading `<!-- system -->` line) is the system prompt. Placeholders are `{{name}}`; `renderTemplate` fails on a placeholder without a value. Every user prompt ends with `{{context}}`, a `<context>…</context>` block of pretty-printed JSON: the model reads structured data, and `FAKE_RESPONSES` (Task 5) parse the same block. Like M2's `loadPrompt`, the loader reads from `src/` next to the module and, when running from `dist/`, from `../../../src/workflows/episode/prompts/` (tsc does not copy `.md` files).

- [ ] **Step 1: Write the prompt files**

`packages/server/src/workflows/episode/prompts/premise.md`:

```markdown
<!-- system -->
You are the story writer of a manga. You turn a short request into the premise of ONE chapter.

Rules:
- Write "title", "synopsis", "tone" and "setting" in {{languageName}}.
- The chapter is exactly {{pages}} printed pages long. Keep it focused: one clear goal or conflict, one turn, and an ending beat that lands on the last page.
- Use the characters listed in the context when they fit the request, by the exact names given. Do not describe how anyone looks.
- "title": 1–6 words, no quotes, no chapter number.
- "synopsis": 2–4 sentences covering the beginning, the middle and the end.
- "tone": 2–5 comma-separated words, for example "tense, melancholic".
- "setting": one or two sentences about place, time of day, season and atmosphere.

Reply with only a JSON object of exactly this shape, with no prose and no code fences:
{"title": string, "synopsis": string, "tone": string, "setting": string}
<!-- user -->
Request: {{prompt}}
Requested tone: {{tone}}

The manga, its characters and the request as data:
{{context}}
```

`packages/server/src/workflows/episode/prompts/outline.md`:

```markdown
<!-- system -->
You are the story editor of a manga. You turn a chapter premise into an ordered list of scenes.

Rules:
- Write every "summary", "purpose", "location", "personality" and "speechStyle" in {{languageName}}.
- The chapter is {{pages}} printed pages long. Plan between 2 and {{maxScenes}} scenes; fewer, fuller scenes are better than many thin ones.
- "summary": 1–2 sentences of what visibly happens. "purpose": the scene's job in the story (setup, rising tension, turn, climax, resolution). "location": a short place name.
- "characterNames": the characters present, spelled exactly as in the context's "characters" list or in your "newCharacters".
- Add "newCharacters" only when the story cannot work with the existing cast; at most 3. Each one needs:
  - "name": a name that fits the setting;
  - "role": "main", "supporting" or "minor";
  - "personality" and "speechStyle": one short phrase each;
  - "appearanceTags": English Danbooru-style tags for the permanent look only — count tag, hair, eyes, build, usual outfit (for example "1girl, short black hair, brown eyes, slim, school uniform, sailor collar"). No pose, expression, background, style or quality tags.
- Never invent a new look for an existing character.

Reply with only a JSON object of exactly this shape, with no prose and no code fences:
{"scenes": [{"summary": string, "purpose": string, "location": string, "characterNames": [string]}], "newCharacters": [{"name": string, "role": "main" | "supporting" | "minor", "personality": string, "speechStyle": string, "appearanceTags": string}]}
<!-- user -->
The premise, the page count and the cast as data:
{{context}}
```

`packages/server/src/workflows/episode/prompts/breakdown.md`:

```markdown
<!-- system -->
You are a manga storyboard artist. You split a chapter's scenes into printed pages and choose a panel layout for each page.

Rules:
- Produce exactly {{pages}} pages, in reading order.
- "sceneIdx": the 0-based indexes of the scenes shown on that page, taken from the context's "scenes". Pages go through the scenes in order; every scene appears on at least one page; a long scene may span several pages.
- "panelCount": how many panels the page has (1–9). Quiet dialogue pages use 4–6 panels, action pages 3–5; a big reveal or the final beat may use 1–2.
- "layoutPreset": the name of one preset from the context's "presets" list whose "panelCount" equals your panelCount exactly. Use only names from that list.
- "pacing": 2–4 words about the page's rhythm, for example "slow build", "fast action", "quiet reveal".
- The last page ends the chapter.

Reply with only a JSON object of exactly this shape, with no prose and no code fences:
{"pages": [{"sceneIdx": [number], "panelCount": number, "pacing": string, "layoutPreset": string}]}
<!-- user -->
The scenes, the page count and the available layout presets as data:
{{context}}
```

`packages/server/src/workflows/episode/prompts/scripts.md`:

```markdown
<!-- system -->
You are the scriptwriter of a manga. You write every panel of every page: what the reader sees, and all of the dialogue.

Rules:
- For page N of the context's "pages", write exactly that page's "panelCount" panels, in reading order, following the page's scenes ("sceneIdx") and "pacing".
- Write all dialogue, narration and sound effects in {{languageName}}. Write "action", "background", "pose" and "expression" in {{languageName}} too.
- "action": one visible moment per panel (not a sequence of events), one sentence. "background": the place, 2–8 words.
- "characters": at most 3 per panel, only characters from the context's "characters" list, with "name" spelled exactly as listed. "position" is where they stand as the reader sees the panel: "left", "center" or "right". "pose" and "expression": 1–4 words each.
- Never describe how a character looks (hair, eyes, clothes); that is handled elsewhere.
- "shot": "extreme-close", "close", "medium", "wide" or "extreme-wide". "angle": "eye", "low", "high", "dutch" or "overhead". Vary them, and open each scene with a wide shot.
- "dialogue": 0–3 lines per panel, in reading order. Each "text" is at most 90 characters, so it fits a speech bubble.
  - "kind": "speech", "thought", "shout", "narration" or "sfx".
  - "speaker": for speech, thought and shout, the exact name of a character in that panel; for narration and sfx, null.
  - An "sfx" line is a short onomatopoeia of 1–2 words.
- No panel may need readable text inside the picture: no signs, letters, screens or books with words. All text lives in "dialogue".
- Match each character's "speechStyle".

Reply with only a JSON object of exactly this shape, with no prose and no code fences:
{"pages": [{"panels": [{"action": string, "shot": string, "angle": string, "characters": [{"name": string, "pose": string, "expression": string, "position": "left" | "center" | "right"}], "background": string, "dialogue": [{"speaker": string | null, "kind": string, "text": string}]}]}]}
<!-- user -->
The premise, the scenes, the page plan and the cast as data:
{{context}}
```

`packages/server/src/workflows/episode/prompts/prompts.md`:

```markdown
<!-- system -->
You write image-generation prompts for manga panels. Each prompt describes only what the camera sees in one panel.

Rules:
- Write every "scene" in English, whatever the language of the script.
- If the context's "sceneStyle" is "tags": comma-separated Danbooru-style tags, 8–25 of them, in this order: people count (1girl, 1boy, 2girls, no humans…), framing (close-up, portrait, upper body, cowboy shot, full body, wide shot, very wide shot), camera angle (from below, from above, dutch angle, from side, from behind), action and pose, expression, then background, time of day and lighting.
- If "sceneStyle" is "natural": one or two plain sentences with the same content in the same order.
- Map the script's shot: extreme-close → close-up; close → portrait; medium → upper body or cowboy shot; wide → full body, wide shot; extreme-wide → very wide shot, scenery. Map the angle: low → from below; high → from above; dutch → dutch angle; overhead → from above; eye → nothing.
- Never describe a character's appearance (hair, eyes, clothing, body): their saved appearance tags are added automatically.
- Never add style or quality words (masterpiece, best quality, lineart, monochrome, anime…): the manga's style guide adds them.
- Never ask for text of any kind: no words, letters, captions, signs, speech bubbles or sound effects. Do not use the words "manga" or "comic".
- "negative" is optional: only panel-specific things to avoid, as tags (for example "extra people" when the panel shows exactly one person). Leave it out when there is nothing specific.
- The panel with "isCover": true is the chapter cover: one striking illustration of the main characters facing the reader, with calm, simple space in the top third for the title.

Reply with only a JSON object of exactly this shape, with no prose and no code fences, with exactly one entry for every panelId in the context:
{"panels": [{"panelId": string, "scene": string, "negative": string}]}
<!-- user -->
The chapter's panels as data:
{{context}}
```

- [ ] **Step 2: Write the test fixtures**

```ts
// packages/server/test/helpers/episode-fixtures.ts
import {
  DEFAULT_PAGE_FORMAT, EPISODE_STEPS, PRESET_NAMES, STYLE_PRESETS, presetPanelCount, stepIndex,
  type BreakdownOutput, type Chapter, type EpisodeInput, type EpisodeRun, type EpisodeStepName, type Language, type Manga,
  type NewCharacterDraft, type OutlineOutput, type PremiseOutput, type ReadingDirection, type ScriptsOutput,
} from '@manga/shared';
import type { Store } from '../../src/store/index.js';
import { freshSteps } from '../../src/workflows/episode/steps.js';

export const STAMP = '2026-09-27T00:00:00.000Z';

export interface EpisodeWorld { manga: Manga; chapter: Chapter }

/** A manga with one empty chapter (no pages): the starting point of every episode run. */
export function seedEpisodeWorld(
  store: Store, opts: { language?: Language; direction?: ReadingDirection; mangaTitle?: string; chapterTitle?: string } = {},
): EpisodeWorld {
  const preset = STYLE_PRESETS['manga-bw']!;
  const manga = store.mangas.create({
    title: opts.mangaTitle ?? 'Rain Town', synopsis: 'Quiet stories from a harbour town.', language: opts.language ?? 'en',
    colorMode: 'bw', readingDirection: opts.direction ?? 'rtl', pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
  const chapter = store.chapters.create({
    mangaId: manga.id, number: 1, title: opts.chapterTitle ?? 'Draft', synopsis: '', coverPageId: null, status: 'draft', order: 0,
  });
  return { manga, chapter };
}

export interface SeedRunOptions {
  input?: Partial<EpisodeInput>;
  mode?: 'review' | 'autopilot';
  /** Steps given an output are stored as done. */
  outputs?: Partial<Record<EpisodeStepName, unknown>>;
  currentStep?: EpisodeStepName;
  status?: EpisodeRun['status'];
}

export function seedRun(store: Store, chapterId: string, opts: SeedRunOptions = {}): EpisodeRun {
  const input: EpisodeInput = { prompt: 'A lost cat in the rain', characterIds: [], pages: 2, tone: '', ...opts.input };
  const steps = freshSteps().map((s) => {
    const output = opts.outputs?.[s.name];
    return output === undefined ? s : { ...s, status: 'done' as const, output, startedAt: STAMP, finishedAt: STAMP };
  });
  const firstPending = steps.findIndex((s) => s.status === 'pending');
  const currentStep = opts.currentStep ? stepIndex(opts.currentStep) : firstPending < 0 ? EPISODE_STEPS.length - 1 : firstPending;
  return store.episodes.create({ chapterId, input, mode: opts.mode ?? 'review', steps, currentStep, status: opts.status ?? 'running' });
}

export const PREMISE: PremiseOutput = {
  title: 'The Cat in the Rain', synopsis: 'Aiko finds a stray cat and takes it home.', tone: 'gentle', setting: 'A rainy harbour town at dusk',
};

export function outline(names: string[], newCharacters: NewCharacterDraft[] = []): OutlineOutput {
  return {
    scenes: [
      { summary: 'Aiko finds the cat.', purpose: 'setup', location: 'alley', characterNames: names },
      { summary: 'She takes it home.', purpose: 'resolution', location: 'apartment', characterNames: names },
    ],
    newCharacters,
  };
}

export const TWO_PANEL_PRESET = PRESET_NAMES.find((n) => presetPanelCount(n) === 2)!;

export function breakdown(pages: number, preset = TWO_PANEL_PRESET): BreakdownOutput {
  return {
    pages: Array.from({ length: pages }, (_, i) => ({ sceneIdx: [Math.min(i, 1)], panelCount: presetPanelCount(preset), pacing: 'steady', layoutPreset: preset })),
  };
}

/** One panel script per breakdown panel; `speaker` (a character name) speaks in every panel, or narration when null. */
export function scripts(bd: BreakdownOutput, speaker: string | null): ScriptsOutput {
  return {
    pages: bd.pages.map((p, i) => ({
      panels: Array.from({ length: p.panelCount }, (_, j) => ({
        action: `Page ${i + 1} panel ${j + 1}`, shot: 'medium' as const, angle: 'eye' as const,
        characters: speaker ? [{ name: speaker, pose: 'standing', expression: 'calm', position: 'left' as const }] : [],
        background: 'street',
        dialogue: speaker
          ? [{ speaker, kind: 'speech' as const, text: `Line ${i + 1}.${j + 1}` }]
          : [{ speaker: null, kind: 'narration' as const, text: `Narration ${i + 1}.${j + 1}` }],
      })),
    })),
  };
}
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/server/test/episode-prompts.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { ConflictError } from '../src/errors.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import {
  buildStepContext, contextBlock, extractContext, templateVars,
  type BreakdownContext, type PremiseContext, type PromptsContext,
} from '../src/workflows/episode/context.js';
import { loadStepPrompt, renderTemplate } from '../src/workflows/episode/prompts.js';
import { LLM_STEPS } from '../src/workflows/episode/steps.js';
import { validationSchema } from '../src/workflows/episode/validation.js';
import { PREMISE, TWO_PANEL_PRESET, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** A run whose outputs exist up to prompts, with two story pages and a cover materialized. */
function fullWorld() {
  const { manga, chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
  const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, short black hair');
  const bd = breakdown(2);
  const run = seedRun(lib.store, chapter.id, {
    input: { characterIds: [aiko.id], tone: 'gentle' },
    outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') },
  });
  const p1 = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  createCoverPage(lib.store, manga.id, chapter.id);
  const first = p1.panels[0]!;
  lib.store.panels.update(first.id, { script: { ...first.script, characters: [{ characterId: aiko.id, pose: 'running', expression: 'worried', position: 'right' }] } });
  return { manga, chapter, aiko, run };
}

describe('step prompts', () => {
  it('every step prompt has a system part and a user part ending with the context', () => {
    for (const step of LLM_STEPS) {
      const p = loadStepPrompt(step);
      expect(p.system).toContain('Reply with only a JSON object');
      expect(p.system).not.toContain('<!--');
      expect(p.user.trimEnd().endsWith('{{context}}')).toBe(true);
    }
  });

  it('renders placeholders literally and refuses unknown ones', () => {
    expect(renderTemplate('a {{x}} b', { x: '$1 $&' })).toBe('a $1 $& b');
    expect(() => renderTemplate('{{nope}}', {})).toThrow('template placeholder {{nope}} has no value');
  });

  it('every prompt renders completely for its step', () => {
    const { run } = fullWorld();
    for (const step of LLM_STEPS) {
      const vars = templateVars(lib.store, run, buildStepContext(lib.store, run, step));
      const p = loadStepPrompt(step);
      const text = renderTemplate(p.system, vars) + renderTemplate(p.user, vars);
      expect(text).not.toMatch(/\{\{\w+\}\}/);
      expect(text).toContain('<context>');
    }
    expect(templateVars(lib.store, run, buildStepContext(lib.store, run, 'premise'))['languageName']).toBe('Ukrainian');
  });
});

describe('step contexts', () => {
  it('premise context carries the request and the chosen cast, without appearance', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'premise') as PremiseContext;
    expect(ctx.request).toEqual({ prompt: 'A lost cat in the rain', tone: 'gentle', pages: 2 });
    expect(ctx.characters).toEqual([{ name: 'Aiko', role: 'main', personality: '', speechStyle: '' }]);
    expect(contextBlock(ctx)).not.toContain('short black hair');
  });

  it('breakdown context numbers the scenes and lists every preset with its panel count', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'breakdown') as BreakdownContext;
    expect(ctx.scenes.map((s) => s.idx)).toEqual([0, 1]);
    expect(ctx.presets).toContainEqual({ name: TWO_PANEL_PRESET, panelCount: 2 });
  });

  it('prompts context lists story panels in reading order, then the cover, with character names', () => {
    const { run, chapter, manga } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'prompts') as PromptsContext;
    const entries = chapterPanels(lib.store, chapter.id, manga.readingDirection);
    expect(ctx.panels.map((p) => p.panelId)).toEqual(entries.map((e) => e.panel.id));
    expect(ctx.panels.map((p) => [p.page, p.isCover])).toEqual([[1, false], [1, false], [2, false], [2, false], [0, true]]);
    expect(ctx.sceneStyle).toBe('tags');
    expect(ctx.panels.find((p) => p.characters.length > 0)?.characters[0]).toEqual({ name: 'Aiko', pose: 'running', expression: 'worried', position: 'right' });
  });

  it('extractContext reads the block back', () => {
    const { run } = fullWorld();
    const ctx = buildStepContext(lib.store, run, 'outline');
    expect(extractContext(`intro\n${contextBlock(ctx)}\n`)).toEqual(ctx);
    expect(() => extractContext('no block')).toThrow('prompt has no <context> block');
  });
});

describe('validationSchema', () => {
  it("uses the run's page count and the manga's character names", () => {
    const { run } = fullWorld();
    expect(validationSchema(lib.store, run, 'breakdown').safeParse(breakdown(1)).success).toBe(false);
    expect(validationSchema(lib.store, run, 'breakdown').safeParse(breakdown(2)).success).toBe(true);
    expect(validationSchema(lib.store, run, 'scripts').safeParse(scripts(breakdown(2), 'aiko')).success).toBe(true);
    expect(validationSchema(lib.store, run, 'scripts').safeParse(scripts(breakdown(2), 'Mika')).success).toBe(false);
  });

  it('refuses to build a schema that needs a missing earlier output', () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE } });
    expect(() => validationSchema(lib.store, run, 'breakdown')).toThrow(ConflictError);
    expect(() => validationSchema(lib.store, run, 'breakdown')).toThrow('step outline has no output yet');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run packages/server/test/episode-prompts.test.ts`
Expected: FAIL — `Failed to load url ../../src/workflows/episode/steps.js` (imported by the fixtures).

- [ ] **Step 5: Write `steps.ts`, `chapter.ts` and `prompts.ts`**

```ts
// packages/server/src/workflows/episode/steps.ts
import type { z } from 'zod';
import { EPISODE_STEPS, stepIndex, type EpisodeRun, type EpisodeStep, type EpisodeStepName } from '@manga/shared';
import { ConflictError } from '../../errors.js';

export type LlmStepName = Exclude<EpisodeStepName, 'render' | 'lettering'>;
export const LLM_STEPS: readonly LlmStepName[] = ['premise', 'outline', 'breakdown', 'scripts', 'prompts'];

export function isLlmStep(name: EpisodeStepName): name is LlmStepName {
  return name !== 'render' && name !== 'lettering';
}

/** Job progress label shown while a step runs (spec §7: "Writing outline…"). */
export const STEP_PROGRESS: Record<EpisodeStepName, string> = {
  premise: 'Writing premise…', outline: 'Writing outline…', breakdown: 'Planning pages…', scripts: 'Writing scripts…',
  prompts: 'Writing image prompts…', render: 'Rendering images…', lettering: 'Lettering…',
};

export const nowIso = (): string => new Date().toISOString();

let lastToken = '';
/** Strictly increasing ISO timestamps in this process: a step's token (startedAt) must change on every dispatch, even within one millisecond. */
export function monotonicIso(): string {
  let t = new Date().toISOString();
  if (t <= lastToken) t = new Date(Date.parse(lastToken) + 1).toISOString();
  lastToken = t;
  return t;
}

export function freshStep(name: EpisodeStepName): EpisodeStep {
  return { name, status: 'pending', output: null, error: null, startedAt: null, finishedAt: null };
}

export function freshSteps(): EpisodeStep[] {
  return EPISODE_STEPS.map(freshStep);
}

export function patchStep(steps: EpisodeStep[], index: number, patch: Partial<EpisodeStep>): EpisodeStep[] {
  return steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

export function requireOutput<T>(run: EpisodeRun, name: EpisodeStepName, schema: z.ZodType<T>): T {
  const step = run.steps[stepIndex(name)];
  if (!step || step.output === null || step.output === undefined) throw new ConflictError(`step ${name} has no output yet`);
  return schema.parse(step.output);
}
```

```ts
// packages/server/src/workflows/episode/chapter.ts
import { panelIds, readingOrder, type Page, type Panel, type ReadingDirection } from '@manga/shared';
import { chapterPages } from '../../domain/order.js';
import type { Store } from '../../store/index.js';

export interface ChapterPanel { page: Page; panel: Panel; pageNumber: number; isCover: boolean }

/** The chapter's story pages (not the cover), by `order`. */
export function storyPages(store: Store, chapterId: string): Page[] {
  return [...chapterPages(store, chapterId)].sort((a, b) => a.order - b.order);
}

/** Story panels page by page in reading order, then the chapter cover's panel (pageNumber 0). */
export function chapterPanels(store: Store, chapterId: string, dir: ReadingDirection): ChapterPanel[] {
  const out: ChapterPanel[] = [];
  storyPages(store, chapterId).forEach((page, i) => {
    for (const id of readingOrder(page.layout, dir)) {
      const panel = store.panels.get(id);
      if (panel) out.push({ page, panel, pageNumber: i + 1, isCover: false });
    }
  });
  const { coverPageId } = store.chapters.require(chapterId);
  const cover = coverPageId === null ? null : store.pages.get(coverPageId);
  if (cover) {
    for (const id of panelIds(cover.layout)) {
      const panel = store.panels.get(id);
      if (panel) out.push({ page: cover, panel, pageNumber: 0, isCover: true });
    }
  }
  return out;
}
```

```ts
// packages/server/src/workflows/episode/prompts.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LlmStepName } from './steps.js';

export interface StepPrompt { system: string; user: string }

const SPLIT = '<!-- user -->';
const cache = new Map<LlmStepName, StepPrompt>();

/** Reads prompts/<step>.md from src (vitest) or, from dist, ../../../src/workflows/episode/prompts (tsc does not copy .md). */
export function loadStepPrompt(step: LlmStepName): StepPrompt {
  const hit = cache.get(step);
  if (hit) return hit;
  const candidates = [
    fileURLToPath(new URL(`./prompts/${step}.md`, import.meta.url)),
    fileURLToPath(new URL(`../../../src/workflows/episode/prompts/${step}.md`, import.meta.url)),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`Episode prompt ${step}.md not found (looked in ${candidates.join(', ')})`);
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf(SPLIT);
  if (at < 0) throw new Error(`Episode prompt ${step}.md has no "${SPLIT}" line`);
  const prompt: StepPrompt = {
    system: text.slice(0, at).replace('<!-- system -->', '').trim(),
    user: text.slice(at + SPLIT.length).trim(),
  };
  cache.set(step, prompt);
  return prompt;
}

/** Replaces {{name}} placeholders; values are inserted literally (no `$&` expansion). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`template placeholder {{${key}}} has no value`);
    return value;
  });
}
```

- [ ] **Step 6: Write `context.ts` and `validation.ts`**

```ts
// packages/server/src/workflows/episode/context.ts
import {
  BreakdownOutputSchema, OutlineOutputSchema, PRESET_NAMES, PremiseOutputSchema, presetPanelCount,
  type BreakdownPage, type Character, type ColorMode, type EpisodeRun, type Language, type OutlineScene, type PremiseOutput, type PresetInfo,
} from '@manga/shared';
import { promptStyleFor, type PromptStyle } from '../../imaging/route.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';
import { requireOutput, type LlmStepName } from './steps.js';

export const LANGUAGE_NAME: Record<Language, string> = { en: 'English', uk: 'Ukrainian' };

export interface CharacterBrief { name: string; role: string; personality: string; speechStyle: string }
export interface PremiseContext {
  step: 'premise'; language: Language; manga: { title: string; synopsis: string };
  request: { prompt: string; tone: string; pages: number }; characters: CharacterBrief[];
}
export interface OutlineContext { step: 'outline'; language: Language; pages: number; premise: PremiseOutput; characters: CharacterBrief[] }
export interface BreakdownContext {
  step: 'breakdown'; pages: number; scenes: Array<{ idx: number; summary: string; purpose: string; location: string }>; presets: PresetInfo[];
}
export interface ScriptsContext {
  step: 'scripts'; language: Language; premise: PremiseOutput; scenes: Array<OutlineScene & { idx: number }>;
  pages: Array<BreakdownPage & { page: number }>; characters: CharacterBrief[];
}
export interface PromptsPanelBrief {
  panelId: string; page: number; isCover: boolean; action: string; shot: string; angle: string; background: string;
  characters: Array<{ name: string; pose: string; expression: string; position: string }>;
}
export interface PromptsContext {
  step: 'prompts'; colorMode: ColorMode; sceneStyle: PromptStyle; premise: { title: string; setting: string; tone: string }; panels: PromptsPanelBrief[];
}
export type StepContext = PremiseContext | OutlineContext | BreakdownContext | ScriptsContext | PromptsContext;

/** Never includes appearanceTags: the story model must not rewrite a character's look (spec §6.3). */
const brief = (c: Character): CharacterBrief => ({ name: c.name, role: c.role, personality: c.personality, speechStyle: c.speechStyle });

export function buildStepContext(store: Store, run: EpisodeRun, step: LlmStepName): StepContext {
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const all = store.characters.listByManga(manga.id);
  const chosen = run.input.characterIds.length > 0 ? all.filter((c) => run.input.characterIds.includes(c.id)) : all;
  switch (step) {
    case 'premise':
      return {
        step, language: manga.language, manga: { title: manga.title, synopsis: manga.synopsis },
        request: { prompt: run.input.prompt, tone: run.input.tone, pages: run.input.pages }, characters: chosen.map(brief),
      };
    case 'outline':
      return { step, language: manga.language, pages: run.input.pages, premise: requireOutput(run, 'premise', PremiseOutputSchema), characters: chosen.map(brief) };
    case 'breakdown': {
      const { scenes } = requireOutput(run, 'outline', OutlineOutputSchema);
      return {
        step, pages: run.input.pages,
        scenes: scenes.map((s, idx) => ({ idx, summary: s.summary, purpose: s.purpose, location: s.location })),
        presets: PRESET_NAMES.map((name) => ({ name, panelCount: presetPanelCount(name) })),
      };
    }
    case 'scripts': {
      const { scenes } = requireOutput(run, 'outline', OutlineOutputSchema);
      const { pages } = requireOutput(run, 'breakdown', BreakdownOutputSchema);
      return {
        step, language: manga.language, premise: requireOutput(run, 'premise', PremiseOutputSchema),
        scenes: scenes.map((s, idx) => ({ ...s, idx })), pages: pages.map((p, i) => ({ ...p, page: i + 1 })),
        characters: all.map(brief), // outline approval may have added characters that are not in input.characterIds
      };
    }
    case 'prompts': {
      const premise = requireOutput(run, 'premise', PremiseOutputSchema);
      const nameOf = (id: string): string => store.characters.get(id)?.name ?? 'someone';
      return {
        step, colorMode: manga.colorMode, sceneStyle: promptStyleFor(manga.styleGuide.recipe),
        premise: { title: premise.title, setting: premise.setting, tone: premise.tone },
        panels: chapterPanels(store, chapter.id, manga.readingDirection).map(({ panel, pageNumber, isCover }) => ({
          panelId: panel.id, page: pageNumber, isCover, action: panel.script.action, shot: panel.script.shot, angle: panel.script.angle,
          background: panel.script.background,
          characters: panel.script.characters.map((c) => ({ name: nameOf(c.characterId), pose: c.pose, expression: c.expression, position: c.position })),
        })),
      };
    }
  }
}

export function contextBlock(ctx: StepContext): string {
  return `<context>\n${JSON.stringify(ctx, null, 2)}\n</context>`;
}

export function extractContext<T extends StepContext>(prompt: string): T {
  const match = /<context>\s*([\s\S]*?)\s*<\/context>/.exec(prompt);
  if (!match?.[1]) throw new Error('prompt has no <context> block');
  return JSON.parse(match[1]) as T;
}

export function templateVars(store: Store, run: EpisodeRun, ctx: StepContext): Record<string, string> {
  const manga = store.mangas.require(store.chapters.require(run.chapterId).mangaId);
  return {
    context: contextBlock(ctx),
    languageName: LANGUAGE_NAME[manga.language],
    pages: String(run.input.pages),
    maxScenes: String(Math.max(2, run.input.pages * 2)),
    prompt: run.input.prompt,
    tone: run.input.tone.trim() || 'any',
  };
}
```

```ts
// packages/server/src/workflows/episode/validation.ts
import type { z } from 'zod';
import {
  BreakdownOutputSchema, LetteringOutputSchema, OutlineOutputSchema, PremiseOutputSchema, RenderOutputSchema,
  breakdownSchemaFor, promptsSchemaFor, scriptsSchemaFor, type EpisodeRun, type EpisodeStepName,
} from '@manga/shared';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';
import { requireOutput } from './steps.js';

/** The schema a step's output must satisfy right now (LLM answers and user edits alike). */
export function validationSchema(store: Store, run: EpisodeRun, step: EpisodeStepName): z.ZodType<unknown> {
  switch (step) {
    case 'premise':
      return PremiseOutputSchema;
    case 'outline':
      return OutlineOutputSchema;
    case 'breakdown':
      return breakdownSchemaFor({ pages: run.input.pages, sceneCount: requireOutput(run, 'outline', OutlineOutputSchema).scenes.length });
    case 'scripts': {
      const chapter = store.chapters.require(run.chapterId);
      return scriptsSchemaFor({
        panelCounts: requireOutput(run, 'breakdown', BreakdownOutputSchema).pages.map((p) => p.panelCount),
        knownNames: store.characters.listByManga(chapter.mangaId).map((c) => c.name),
      });
    }
    case 'prompts': {
      const chapter = store.chapters.require(run.chapterId);
      const manga = store.mangas.require(chapter.mangaId);
      return promptsSchemaFor({ panelIds: chapterPanels(store, chapter.id, manga.readingDirection).map((e) => e.panel.id) });
    }
    case 'render':
      return RenderOutputSchema;
    case 'lettering':
      return LetteringOutputSchema;
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/episode-prompts.test.ts`
Expected: PASS — `Tests  9 passed (9)`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/workflows/episode packages/server/test/helpers/episode-fixtures.ts packages/server/test/episode-prompts.test.ts
git commit -m "feat(server): episode step prompts, LLM contexts and step validation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Server — fake `episode.*` responses

**Files:**
- Create: `packages/server/src/dev/fake-episode.ts`
- Modify: `packages/server/src/dev/fake-responses.ts` (one import, one spread line)
- Test: `packages/server/test/fake-episode.test.ts`

**Interfaces:**
- Consumes: `extractContext` and the step context types (Task 4); `JsonRequest` (`../engines/types.js`); `sameName`, output types (Task 2).
- Produces: `FAKE_NEW_CHARACTER = 'Mika'`; `EPISODE_FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown>` with keys `episode.premise`, `episode.outline`, `episode.breakdown`, `episode.scripts`, `episode.prompts`; `FAKE_RESPONSES` now includes them (so `MANGA_FAKES=1`, `startM2TestServer` and every `ScriptedEngine` built from `FAKE_RESPONSES` can run whole episodes).

The fakes read the `<context>` block of the request, so their answers always fit the request: the right page count, a 2-panel preset from the offered list, one new character ("Mika", once), speakers that exist, one prompt per offered panel id, Ukrainian text for Ukrainian mangas.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/fake-episode.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PremiseOutputSchema, STEP_TASK, stepIndex,
  type BreakdownOutput, type EpisodeRun, type EpisodeStepName, type OutlineOutput, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { buildStepContext, templateVars } from '../src/workflows/episode/context.js';
import { loadStepPrompt, renderTemplate } from '../src/workflows/episode/prompts.js';
import { patchStep, type LlmStepName } from '../src/workflows/episode/steps.js';
import { validationSchema } from '../src/workflows/episode/validation.js';
import { seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** Asks the scripted engine exactly the way the runner will (Task 9), validating with the step's refined schema. */
async function ask<T>(run: EpisodeRun, step: LlmStepName): Promise<T> {
  const vars = templateVars(lib.store, run, buildStepContext(lib.store, run, step));
  const p = loadStepPrompt(step);
  const engine = new ScriptedEngine('claude', FAKE_RESPONSES);
  return (await engine.completeJson({
    name: `episode.${step}`, task: STEP_TASK[step]!, system: renderTemplate(p.system, vars), prompt: renderTemplate(p.user, vars),
    schema: validationSchema(lib.store, run, step),
  })) as T;
}

function save(run: EpisodeRun, step: EpisodeStepName, output: unknown): EpisodeRun {
  return lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex(step), { status: 'done', output }) });
}

describe('fake episode responses', () => {
  it("answer every step with output that passes that step's validation", async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    let run = seedRun(lib.store, chapter.id, { input: { characterIds: [aiko.id], pages: 2 } });

    const premise = await ask<PremiseOutput>(run, 'premise');
    expect(premise.title).toBe('Кіт під дощем');
    run = save(run, 'premise', premise);

    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(outline.newCharacters.map((c) => c.name)).toEqual(['Mika']);
    expect(outline.scenes[0]!.characterNames).toEqual(['Aiko', 'Mika']);
    run = save(run, 'outline', outline);
    seedCharacter(lib.store, manga.id, 'Mika');

    const bd = await ask<BreakdownOutput>(run, 'breakdown');
    expect(bd.pages).toHaveLength(2);
    run = save(run, 'breakdown', bd);

    const sc = await ask<ScriptsOutput>(run, 'scripts');
    expect(sc.pages[0]!.panels[0]!.dialogue[0]).toEqual({ speaker: null, kind: 'narration', text: 'Осінь.' });
    expect(sc.pages[0]!.panels[0]!.dialogue[1]).toMatchObject({ speaker: 'Mika', kind: 'speech' });
    run = save(run, 'scripts', sc);

    for (const page of bd.pages) createPage(lib.store, chapter.id, page.layoutPreset);
    createCoverPage(lib.store, manga.id, chapter.id);
    const prompts = await ask<PromptsOutput>(run, 'prompts');
    expect(prompts.panels).toHaveLength(bd.pages.reduce((n, p) => n + p.panelCount, 0) + 1);
    expect(prompts.panels.at(-1)!.scene).toContain('looking at viewer');
  });

  it('introduce the new character only once', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    seedCharacter(lib.store, manga.id, 'mika');
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' } } });
    const outline = await ask<OutlineOutput>(run, 'outline');
    expect(outline.newCharacters).toEqual([]);
    expect(outline.scenes[0]!.characterNames).toEqual(['mika']);
  });

  it('write narration only when the manga has no characters', async () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const bd: BreakdownOutput = { pages: [{ sceneIdx: [0], panelCount: 2, pacing: 'x', layoutPreset: 'nope' }] };
    const run = seedRun(lib.store, chapter.id, {
      input: { pages: 1 },
      outputs: { premise: { title: 'T', synopsis: 'S', tone: '', setting: '' }, outline: { scenes: [{ summary: 's', purpose: '', location: '', characterNames: [] }], newCharacters: [] }, breakdown: bd },
    });
    const sc = await ask<ScriptsOutput>(run, 'scripts');
    expect(sc.pages[0]!.panels.flatMap((p) => p.dialogue.map((d) => d.kind))).toEqual(['narration']);
    expect(sc.pages[0]!.panels.every((p) => p.characters.length === 0)).toBe(true);
  });

  it('are part of FAKE_RESPONSES', async () => {
    for (const key of Object.keys(EPISODE_FAKE_RESPONSES)) expect(FAKE_RESPONSES[key]).toBe(EPISODE_FAKE_RESPONSES[key]);
    expect(Object.keys(EPISODE_FAKE_RESPONSES).sort()).toEqual(['episode.breakdown', 'episode.outline', 'episode.premise', 'episode.prompts', 'episode.scripts']);
    expect(PremiseOutputSchema.safeParse(EPISODE_FAKE_RESPONSES['episode.premise']!({
      name: 'episode.premise', task: 'story', system: '', schema: PremiseOutputSchema,
      prompt: '<context>{"step":"premise","language":"en","manga":{"title":"M","synopsis":""},"request":{"prompt":"p","tone":"","pages":1},"characters":[]}</context>',
    })).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/fake-episode.test.ts`
Expected: FAIL — `Failed to load url ../src/dev/fake-episode.js`.

- [ ] **Step 3: Write the fakes**

```ts
// packages/server/src/dev/fake-episode.ts
import {
  sameName,
  type BreakdownOutput, type DialogueKind, type OutlineOutput, type PanelScriptDraft, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import type { JsonRequest } from '../engines/types.js';
import {
  extractContext, type BreakdownContext, type OutlineContext, type PremiseContext, type PromptsContext, type ScriptsContext,
} from '../workflows/episode/context.js';

/** The one new character every fake outline introduces, unless the manga already has her. */
export const FAKE_NEW_CHARACTER = 'Mika';

const line = (speaker: string | null, kind: DialogueKind, text: string): PanelScriptDraft['dialogue'][number] => ({ speaker, kind, text });

function fakePanel(page: number, index: number, speaker: string | null, uk: boolean): PanelScriptDraft {
  return {
    action: uk ? 'Міка махає рукою' : 'Mika waves',
    shot: index === 0 ? 'wide' : 'medium',
    angle: 'eye',
    characters: speaker ? [{ name: speaker, pose: 'waving', expression: 'smiling', position: index % 2 === 0 ? 'left' : 'right' }] : [],
    background: uk ? 'вулиця біля порту' : 'harbour street',
    dialogue: [
      ...(page === 1 && index === 0 ? [line(null, 'narration', uk ? 'Осінь.' : 'Autumn.')] : []),
      ...(speaker ? [line(speaker, 'speech', uk ? `Привіт! (${page}.${index + 1})` : `Hello! (${page}.${index + 1})`)] : []),
    ],
  };
}

/** Canned answers for MANGA_FAKES=1 and tests; each one reads the request's <context> block so it always fits. */
export const EPISODE_FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'episode.premise': (req): PremiseOutput => {
    const c = extractContext<PremiseContext>(req.prompt);
    return c.language === 'uk'
      ? { title: 'Кіт під дощем', synopsis: `Коротка історія: ${c.request.prompt}`, tone: c.request.tone || 'лагідний', setting: 'Портове містечко восени, вечір' }
      : { title: 'The Cat in the Rain', synopsis: `A short story: ${c.request.prompt}`, tone: c.request.tone || 'gentle', setting: 'A harbour town in autumn, evening' };
  },

  'episode.outline': (req): OutlineOutput => {
    const c = extractContext<OutlineContext>(req.prompt);
    const existing = c.characters.find((ch) => sameName(ch.name, FAKE_NEW_CHARACTER));
    const lead = c.characters.find((ch) => !sameName(ch.name, FAKE_NEW_CHARACTER));
    const cast = [...(lead ? [lead.name] : []), existing?.name ?? FAKE_NEW_CHARACTER];
    return {
      scenes: [
        { summary: 'They meet in the rain.', purpose: 'setup', location: 'harbour street', characterNames: cast },
        { summary: 'They part as friends.', purpose: 'resolution', location: 'pier', characterNames: cast },
      ],
      newCharacters: existing ? [] : [{
        name: FAKE_NEW_CHARACTER, role: 'supporting', personality: 'cheerful', speechStyle: 'short sentences',
        appearanceTags: '1girl, long brown hair, green eyes, yellow raincoat',
      }],
    };
  },

  'episode.breakdown': (req): BreakdownOutput => {
    const c = extractContext<BreakdownContext>(req.prompt);
    const preset = c.presets.find((p) => p.panelCount === 2) ?? c.presets[0]!;
    return {
      pages: Array.from({ length: c.pages }, (_, i) => ({
        sceneIdx: [Math.min(i, c.scenes.length - 1)], panelCount: preset.panelCount, pacing: 'steady', layoutPreset: preset.name,
      })),
    };
  },

  'episode.scripts': (req): ScriptsOutput => {
    const c = extractContext<ScriptsContext>(req.prompt);
    const speaker = c.characters.find((ch) => sameName(ch.name, FAKE_NEW_CHARACTER))?.name ?? c.characters[0]?.name ?? null;
    const uk = c.language === 'uk';
    return { pages: c.pages.map((p) => ({ panels: Array.from({ length: p.panelCount }, (_, j) => fakePanel(p.page, j, speaker, uk)) })) };
  },

  'episode.prompts': (req): PromptsOutput => {
    const c = extractContext<PromptsContext>(req.prompt);
    return {
      panels: c.panels.map((p) => ({
        panelId: p.panelId,
        scene: p.isCover
          ? '1girl, looking at viewer, smile, upper body, harbour, evening, cloudy sky'
          : `${p.characters.length > 0 ? '1girl' : 'no humans'}, upper body, waving, harbour street, evening`,
      })),
    };
  },
};
```

In `packages/server/src/dev/fake-responses.ts`, add the import next to the existing one and spread the entries as the **last** line of the `FAKE_RESPONSES` object literal:

```ts
import { EPISODE_FAKE_RESPONSES } from './fake-episode.js';
```

```ts
  ...EPISODE_FAKE_RESPONSES,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/fake-episode.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

Note on the third test: the breakdown fixture uses the invalid preset `'nope'` on purpose — the scripts step only reads `panelCount`, and this proves the fake does not depend on preset names.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dev/fake-episode.ts packages/server/src/dev/fake-responses.ts packages/server/test/fake-episode.test.ts
git commit -m "feat(server): scripted episode.* answers for MANGA_FAKES and tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Server — step effects (chapter, characters, pages, prompts)

**Files:**
- Create: `packages/server/src/workflows/emit.ts`
- Create: `packages/server/src/workflows/episode/effects.ts`
- Test: `packages/server/test/episode-effects.test.ts`

**Interfaces:**
- Consumes: `createCharacter` (`../../domain/characters.js`), `createPage`, `createCoverPage` (`../../domain/pages.js`), `ConflictError`, `ValidationError` (`../../errors.js`), `EventBus`, `Store`; `storyPages`, `chapterPanels` (Task 4); `readingOrder`, `panelIds`, `sameName`, `CreateCharacterSchema`, `EMPTY_SCRIPT` and output types (`@manga/shared`).
- Produces:
  - `emit.ts`: `emitEntity(bus, entity, id, op, mangaId): void`
  - `effects.ts`: `interface EffectDeps { store: Store; bus: EventBus }`; `applyPremise(deps, chapterId, premise)`; `createOutlineCharacters(deps, mangaId, drafts): Character[]` (skips names that already exist, case-insensitively); `draftToScript(draft, characters): { script: PanelScript; refCharacterIds: string[] }`; `materializeScripts(deps, chapterId, { breakdown, scripts, premise }): { pageIds: string[]; coverPageId: string }`; `applyScripts(deps, chapterId, scripts)`; `applyPrompts(deps, chapterId, prompts)`

Rules: materialization runs in one transaction — pages from `buildPreset(layoutPreset, manga.readingDirection)` via M1's `createPage`, panels filled in reading order, names mapped to ids (case-insensitive; unknown → `ValidationError`), `refCharacterIds` = the panel's characters, and the chapter cover (M1's `createCoverPage`, which reuses an existing cover) gets a cover script with the two most frequent characters. It refuses to run when the chapter already has story pages (`ConflictError`): replacing pages is only possible through `rerun … confirm` (Task 9), which deletes them first.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/episode-effects.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readingOrder, type ServerEvent } from '@manga/shared';
import { createPage } from '../src/domain/pages.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { storyPages } from '../src/workflows/episode/chapter.js';
import { applyPremise, applyPrompts, applyScripts, createOutlineCharacters, materializeScripts } from '../src/workflows/episode/effects.js';
import { PREMISE, TWO_PANEL_PRESET, breakdown, scripts, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
});
afterEach(() => { lib.close(); });

const entityEvents = () => events.flatMap((e) => (e.type === 'entity' ? [`${e.entity}:${e.op}`] : []));

function world() {
  const w = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, w.manga.id, 'Aiko');
  return { ...w, aiko };
}

describe('premise and outline effects', () => {
  it('applyPremise writes the title and synopsis to the chapter', () => {
    const { chapter } = world();
    applyPremise({ store: lib.store, bus }, chapter.id, PREMISE);
    expect(lib.store.chapters.require(chapter.id)).toMatchObject({ title: PREMISE.title, synopsis: PREMISE.synopsis });
    expect(entityEvents()).toEqual(['chapter:updated']);
  });

  it('createOutlineCharacters creates each new name once, skipping existing ones', () => {
    const { manga } = world();
    const draft = { role: 'supporting' as const, personality: 'cheerful', speechStyle: 'short', appearanceTags: '1girl, yellow raincoat' };
    const created = createOutlineCharacters({ store: lib.store, bus }, manga.id, [
      { name: 'Mika', ...draft }, { name: ' mika ', ...draft }, { name: 'AIKO', ...draft },
    ]);
    expect(created.map((c) => c.name)).toEqual(['Mika']);
    expect(created[0]).toMatchObject({ role: 'supporting', appearanceTags: '1girl, yellow raincoat', refs: {} });
    expect(lib.store.characters.listByManga(manga.id).map((c) => c.name).sort()).toEqual(['Aiko', 'Mika']);
    expect(entityEvents()).toEqual(['character:created']);
  });
});

describe('materializeScripts', () => {
  it('creates the pages of the breakdown and fills their panels in reading order', () => {
    const { chapter, manga, aiko } = world();
    const bd = breakdown(2);
    const { pageIds } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    const pages = storyPages(lib.store, chapter.id);
    expect(pages.map((p) => p.id)).toEqual(pageIds);
    pages.forEach((page, i) => {
      readingOrder(page.layout, manga.readingDirection).forEach((panelId, j) => {
        const panel = lib.store.panels.require(panelId);
        expect(panel.script.action).toBe(`Page ${i + 1} panel ${j + 1}`);
        expect(panel.script.characters).toEqual([{ characterId: aiko.id, pose: 'standing', expression: 'calm', position: 'left' }]);
        expect(panel.script.dialogue).toEqual([{ speakerId: aiko.id, kind: 'speech', text: `Line ${i + 1}.${j + 1}` }]);
        expect(panel.refCharacterIds).toEqual([aiko.id]);
      });
    });
    expect(entityEvents()).toEqual(['page:created', 'page:created', 'page:updated', 'chapter:updated']);
  });

  it('materialize maps names case-insensitively', () => {
    const { chapter, aiko } = world();
    const bd = breakdown(1);
    materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, '  AIKO '), premise: PREMISE });
    const page = storyPages(lib.store, chapter.id)[0]!;
    const panel = lib.store.panels.listByPage(page.id)[0]!;
    expect(panel.script.dialogue[0]!.speakerId).toBe(aiko.id);
  });

  it('prepares the chapter cover with the leading characters', () => {
    const { chapter, aiko } = world();
    const bd = breakdown(1);
    const { coverPageId } = materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBe(coverPageId);
    const cover = lib.store.panels.listByPage(coverPageId)[0]!;
    expect(cover.refCharacterIds).toEqual([aiko.id]);
    expect(cover.script).toMatchObject({ background: PREMISE.setting, dialogue: [], characters: [{ characterId: aiko.id, position: 'center' }] });
  });

  it('refuses a chapter that already has story pages', () => {
    const { chapter } = world();
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const bd = breakdown(1);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE }))
      .toThrow(ConflictError);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(1);
  });

  it('rolls everything back when a page script does not fit its layout', () => {
    const { chapter } = world();
    const bd = breakdown(2);
    const bad = scripts(bd, 'Aiko');
    bad.pages[1]!.panels.push(bad.pages[1]!.panels[0]!);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: bad, premise: PREMISE }))
      .toThrow(`page 2: layout "${TWO_PANEL_PRESET}" has 2 panels but the script has 3`);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(0);
    expect(lib.store.chapters.require(chapter.id).coverPageId).toBeNull();
  });

  it('rejects an unknown character name', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    expect(() => materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Nobody'), premise: PREMISE }))
      .toThrow(ValidationError);
  });
});

describe('edits after materialization', () => {
  it('applyScripts rewrites panel scripts in place and refuses a different shape', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    const edited = scripts(bd, null);
    applyScripts({ store: lib.store, bus }, chapter.id, edited);
    const page = storyPages(lib.store, chapter.id)[0]!;
    expect(lib.store.panels.listByPage(page.id).flatMap((p) => p.script.dialogue.map((d) => d.kind))).toEqual(['narration', 'narration']);
    expect(() => applyScripts({ store: lib.store, bus }, chapter.id, scripts(breakdown(2), 'Aiko')))
      .toThrow('the chapter has 1 pages but the scripts have 2; re-run the scripts step instead');
  });

  it('applyPrompts writes scene and negative and refuses panels of other chapters', () => {
    const { chapter } = world();
    const bd = breakdown(1);
    materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
    const page = storyPages(lib.store, chapter.id)[0]!;
    const [a, b] = lib.store.panels.listByPage(page.id);
    applyPrompts({ store: lib.store, bus }, chapter.id, { panels: [{ panelId: a!.id, scene: '1girl, rain' }, { panelId: b!.id, scene: 'no humans, pier', negative: 'people' }] });
    expect(lib.store.panels.require(a!.id).prompt).toEqual({ scene: '1girl, rain', negative: '' });
    expect(lib.store.panels.require(b!.id).prompt).toEqual({ scene: 'no humans, pier', negative: 'people' });
    expect(() => applyPrompts({ store: lib.store, bus }, chapter.id, { panels: [{ panelId: 'pn_elsewhere', scene: 'x' }] }))
      .toThrow('panel pn_elsewhere is not part of this chapter');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/episode-effects.test.ts`
Expected: FAIL — `Failed to load url ../src/workflows/episode/effects.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/workflows/emit.ts
import type { EntityName } from '@manga/shared';
import type { EventBus } from '../events/bus.js';

export function emitEntity(bus: EventBus, entity: EntityName, id: string, op: 'created' | 'updated' | 'deleted', mangaId: string | null): void {
  bus.emit({ type: 'entity', entity, id, op, mangaId });
}
```

```ts
// packages/server/src/workflows/episode/effects.ts
import {
  CreateCharacterSchema, EMPTY_SCRIPT, panelIds, readingOrder, sameName,
  type BreakdownOutput, type Chapter, type Character, type Manga, type NewCharacterDraft, type PanelScript,
  type PanelScriptDraft, type PremiseOutput, type PromptsOutput, type ScriptsOutput,
} from '@manga/shared';
import { createCharacter } from '../../domain/characters.js';
import { createCoverPage, createPage } from '../../domain/pages.js';
import { ConflictError, ValidationError } from '../../errors.js';
import type { EventBus } from '../../events/bus.js';
import type { Store } from '../../store/index.js';
import { emitEntity } from '../emit.js';
import { chapterPanels, storyPages } from './chapter.js';

export interface EffectDeps { store: Store; bus: EventBus }
type Position = PanelScript['characters'][number]['position'];

/** Step 1 → the chapter (spec §8: "written to the chapter"). */
export function applyPremise({ store, bus }: EffectDeps, chapterId: string, premise: PremiseOutput): void {
  const chapter = store.chapters.update(chapterId, { title: premise.title, synopsis: premise.synopsis });
  emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
}

/** Outline acceptance: new characters (random seed via M1's createCharacter). Names that already exist are skipped. */
export function createOutlineCharacters({ store, bus }: EffectDeps, mangaId: string, drafts: NewCharacterDraft[]): Character[] {
  const existing = store.characters.listByManga(mangaId);
  const created: Character[] = [];
  for (const d of drafts) {
    if ([...existing, ...created].some((c) => sameName(c.name, d.name))) continue;
    const character = createCharacter(store, mangaId, CreateCharacterSchema.parse({
      name: d.name.trim(), role: d.role, personality: d.personality, speechStyle: d.speechStyle, appearanceTags: d.appearanceTags,
    }));
    emitEntity(bus, 'character', character.id, 'created', mangaId);
    created.push(character);
  }
  return created;
}

function byName(characters: Character[], name: string): Character {
  const found = characters.find((c) => sameName(c.name, name));
  if (!found) throw new ValidationError(`unknown character "${name}"`);
  return found;
}

export function draftToScript(draft: PanelScriptDraft, characters: Character[]): { script: PanelScript; refCharacterIds: string[] } {
  const cast = draft.characters.map((c) => ({ characterId: byName(characters, c.name).id, pose: c.pose, expression: c.expression, position: c.position }));
  const dialogue = draft.dialogue.map((d) => ({ speakerId: d.speaker === null ? null : byName(characters, d.speaker).id, kind: d.kind, text: d.text }));
  return {
    script: { action: draft.action, shot: draft.shot, angle: draft.angle, characters: cast, background: draft.background, dialogue },
    refCharacterIds: [...new Set(cast.map((c) => c.characterId))],
  };
}

function prepareCover(store: Store, chapter: Chapter, manga: Manga, premise: PremiseOutput, scripts: ScriptsOutput, characters: Character[]): string {
  const detail = createCoverPage(store, manga.id, chapter.id); // returns the existing cover when there is one
  const panel = detail.panels[0];
  if (!panel) return detail.page.id;
  const counts = new Map<string, number>();
  for (const page of scripts.pages) {
    for (const p of page.panels) for (const c of p.characters) {
      const id = byName(characters, c.name).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const leads = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
  const positions: Position[] = leads.length === 1 ? ['center'] : ['left', 'right'];
  store.panels.update(panel.id, {
    script: {
      ...EMPTY_SCRIPT, action: `Chapter cover: ${premise.title}. ${premise.synopsis}`, shot: 'medium', angle: 'low', background: premise.setting,
      characters: leads.map((characterId, i) => ({ characterId, pose: 'facing the reader', expression: 'determined', position: positions[i] ?? 'center' })),
      dialogue: [],
    },
    refCharacterIds: leads,
  });
  return detail.page.id;
}

/** Step 4 (spec §8): "Materializes Pages and Panels" — all or nothing. */
export function materializeScripts(
  { store, bus }: EffectDeps, chapterId: string, input: { breakdown: BreakdownOutput; scripts: ScriptsOutput; premise: PremiseOutput },
): { pageIds: string[]; coverPageId: string } {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  if (storyPages(store, chapterId).length > 0) {
    throw new ConflictError('the chapter already has pages; re-run the scripts step with confirm to replace them');
  }
  const characters = store.characters.listByManga(manga.id);
  const result = store.tx(() => {
    const pageIds = input.breakdown.pages.map((bp, i) => {
      const detail = createPage(store, chapterId, bp.layoutPreset);
      const slots = readingOrder(detail.page.layout, manga.readingDirection);
      const drafts = input.scripts.pages[i]?.panels ?? [];
      if (slots.length !== drafts.length) {
        throw new ValidationError(`page ${i + 1}: layout "${bp.layoutPreset}" has ${slots.length} panels but the script has ${drafts.length}`);
      }
      slots.forEach((panelId, j) => { store.panels.update(panelId, draftToScript(drafts[j]!, characters)); });
      return detail.page.id;
    });
    return { pageIds, coverPageId: prepareCover(store, chapter, manga, input.premise, input.scripts, characters) };
  });
  for (const id of result.pageIds) emitEntity(bus, 'page', id, 'created', manga.id);
  emitEntity(bus, 'page', result.coverPageId, 'updated', manga.id);
  emitEntity(bus, 'chapter', chapter.id, 'updated', manga.id);
  return result;
}

/** A user edit of the scripts output after materialization: rewrite the panel scripts in place. */
export function applyScripts({ store, bus }: EffectDeps, chapterId: string, scripts: ScriptsOutput): void {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const pages = storyPages(store, chapterId);
  if (pages.length === 0) return;
  if (pages.length !== scripts.pages.length) {
    throw new ValidationError(`the chapter has ${pages.length} pages but the scripts have ${scripts.pages.length}; re-run the scripts step instead`);
  }
  const characters = store.characters.listByManga(manga.id);
  store.tx(() => {
    pages.forEach((page, i) => {
      const slots = readingOrder(page.layout, manga.readingDirection);
      const drafts = scripts.pages[i]!.panels;
      if (slots.length !== drafts.length) {
        throw new ValidationError(`page ${i + 1} has ${slots.length} panels but its script has ${drafts.length}; re-run the scripts step instead`);
      }
      slots.forEach((id, j) => { store.panels.update(id, draftToScript(drafts[j]!, characters)); });
    });
  });
  for (const page of pages) for (const id of panelIds(page.layout)) emitEntity(bus, 'panel', id, 'updated', manga.id);
}

/** Step 5 → panel.prompt (and user edits of it). */
export function applyPrompts({ store, bus }: EffectDeps, chapterId: string, prompts: PromptsOutput): void {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const allowed = new Set(chapterPanels(store, chapterId, manga.readingDirection).map((e) => e.panel.id));
  store.tx(() => {
    for (const p of prompts.panels) {
      if (!allowed.has(p.panelId)) throw new ValidationError(`panel ${p.panelId} is not part of this chapter`);
      store.panels.update(p.panelId, { prompt: { scene: p.scene, negative: p.negative ?? '' } });
    }
  });
  for (const p of prompts.panels) emitEntity(bus, 'panel', p.panelId, 'updated', manga.id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/episode-effects.test.ts`
Expected: PASS — `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workflows/emit.ts packages/server/src/workflows/episode/effects.ts packages/server/test/episode-effects.test.ts
git commit -m "feat(server): episode step effects — chapter premise, outline characters, page materialization, prompts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Server — `letterPage` domain service

**Files:**
- Create: `packages/server/src/domain/lettering.ts`
- Test: `packages/server/test/lettering-domain.test.ts`

**Interfaces:**
- Consumes: `autoLetter` (Task 3); `computeRects`, `CreateFrameSchema` (`@manga/shared`); `pageDetail` (`./pages.js`), `createFrame` (`./frames.js`), `Store`.
- Produces: `letterPage(store: Store, pageId: string): TextFrame[]` — creates frames for every not-yet-lettered dialogue line on the page (one transaction) and, on a cover page without a `title` frame, a title frame (chapter title, or manga title for the manga cover) across the top of the panel. Returns only the frames it created. Emits nothing (callers emit). Used by `POST /api/pages/:id/auto-letter` and the lettering step.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/lettering-domain.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRects, CreateFrameSchema } from '@manga/shared';
import { createFrame } from '../src/domain/frames.js';
import { letterPage } from '../src/domain/lettering.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

function letteredWorld() {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
  const detail = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  const [a, b] = detail.panels;
  updatePanel(lib.store, a!.id, {
    characters: [{ characterId: aiko.id, pose: '', expression: '', position: 'left' }],
    dialogue: [{ speakerId: null, kind: 'narration', text: 'Autumn.' }, { speakerId: aiko.id, kind: 'speech', text: 'Line 1' }],
  });
  updatePanel(lib.store, b!.id, { dialogue: [{ speakerId: null, kind: 'sfx', text: 'BANG' }] });
  return { manga, chapter, aiko, page: detail.page, a: a!, b: b! };
}

describe('letterPage', () => {
  it('letters every dialogue line of the page exactly once', () => {
    const { page, a, b } = letteredWorld();
    const frames = letterPage(lib.store, page.id);
    expect(frames.map((f) => [f.panelId, f.kind, f.text])).toEqual([
      [a.id, 'narration', 'Autumn.'], [a.id, 'speech', 'Line 1'], [b.id, 'sfx', 'BANG'],
    ]);
    expect(frames.map((f) => f.order)).toEqual([0, 1, 2]);
    expect(letterPage(lib.store, page.id)).toEqual([]);
    expect(lib.store.frames.listByPage(page.id)).toHaveLength(3);
  });

  it('places every frame inside its panel', () => {
    const { manga, page } = letteredWorld();
    const rects = new Map(computeRects(page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
    for (const f of letterPage(lib.store, page.id)) {
      const r = rects.get(f.panelId!)!;
      expect(f.box.x).toBeGreaterThanOrEqual(r.x);
      expect(f.box.y).toBeGreaterThanOrEqual(r.y);
      expect(f.box.x + f.box.w).toBeLessThanOrEqual(r.x + r.w + 1e-9);
      expect(f.box.y + f.box.h).toBeLessThanOrEqual(r.y + r.h + 1e-9);
    }
  });

  it('keeps lines the user already lettered by hand', () => {
    const { page, a } = letteredWorld();
    createFrame(lib.store, page.id, CreateFrameSchema.parse({ kind: 'speech', text: 'Line 1', panelId: a.id }));
    expect(letterPage(lib.store, page.id).map((f) => f.text)).toEqual(['Autumn.', 'BANG']);
  });

  it('adds the chapter title to a cover page once', () => {
    const { manga, chapter } = letteredWorld();
    lib.store.chapters.update(chapter.id, { title: 'The Cat in the Rain' });
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const frames = letterPage(lib.store, cover.page.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'title', text: 'The Cat in the Rain', panelId: cover.panels[0]!.id, tail: null });
    expect(letterPage(lib.store, cover.page.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/lettering-domain.test.ts`
Expected: FAIL — `Failed to load url ../src/domain/lettering.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/domain/lettering.ts
import { autoLetter, computeRects, CreateFrameSchema, type Rect, type TextFrame } from '@manga/shared';
import type { Store } from '../store/index.js';
import { createFrame } from './frames.js';
import { pageDetail } from './pages.js';

/** Auto-letters a page (spec §9.3). Returns only the frames it created; the caller emits events. */
export function letterPage(store: Store, pageId: string): TextFrame[] {
  const detail = pageDetail(store, pageId);
  const manga = store.mangas.require(detail.page.mangaId);
  const rects = new Map(computeRects(detail.page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
  const drafts = autoLetter({
    layout: detail.page.layout, format: manga.pageFormat, direction: manga.readingDirection,
    panels: detail.panels.flatMap((p) => {
      const rect = rects.get(p.id);
      return rect ? [{ id: p.id, rect, script: p.script }] : [];
    }),
    existingFrames: detail.frames.map((f) => ({ panelId: f.panelId, text: f.text, box: f.box, order: f.order })),
  });
  return store.tx(() => {
    const created = drafts.map((d) => createFrame(store, pageId, CreateFrameSchema.parse({
      kind: d.kind, text: d.text, panelId: d.panelId, speakerId: d.speakerId, box: d.box, tail: d.tail,
      rotation: d.rotation, font: d.font, fontSize: d.fontSize, autoFit: true, align: d.align,
    })));
    if (detail.page.kind === 'cover' && !detail.frames.some((f) => f.kind === 'title')) {
      const title = detail.page.chapterId !== null ? store.chapters.require(detail.page.chapterId).title : manga.title;
      const first = detail.panels[0];
      const r: Rect = (first ? rects.get(first.id) : undefined) ?? { x: 0, y: 0, w: 1, h: 1 };
      created.push(createFrame(store, pageId, CreateFrameSchema.parse({
        kind: 'title', text: title, panelId: first?.id ?? null, tail: null, align: 'center', autoFit: true,
        box: { x: r.x + r.w * 0.08, y: r.y + r.h * 0.05, w: r.w * 0.84, h: r.h * 0.12 },
      })));
    }
    return created;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/lettering-domain.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/domain/lettering.ts packages/server/test/lettering-domain.test.ts
git commit -m "feat(server): letterPage — auto-letter a page and title covers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Server — render and lettering drivers

**Files:**
- Create: `packages/server/src/workflows/episode/render.ts`, `packages/server/src/workflows/episode/lettering.ts`
- Create: `packages/server/test/helpers/fake-queue.ts`
- Test: `packages/server/test/episode-render.test.ts`

**Interfaces:**
- Consumes: `chapterPanels`, `storyPages` (Task 4); `letterPage` (Task 7); `emitEntity` (Task 6); `randomSeed` (`../../domain/seed.js`); `routeRecipe` (`../../imaging/route.js`); `PermanentError`, `JobContext`, `JobQueue` (`../../jobs/index.js`); `Engines` (`../../engines/resolve.js`); `estimateSeconds`, `formatEstimate`, `stepIndex` (Task 2); job payload types (`@manga/shared`).
- Produces:
  - `render.ts`: `type QueueLike = Pick<JobQueue, 'enqueue' | 'cancel' | 'waitFor'>`; `interface DriverDeps { store; bus; queue: QueueLike; engines: Pick<Engines, 'laneFor'>; newSeed?: () => number }`; `TEXT_NEGATIVE`; `interface RetryPatch { seed: number; recipe?: string; negativeExtra?: string; sceneSuffix?: string }`; `retryPatch(issues, settings, seed): RetryPatch`; `estimateRender(store, settings, manga, panels): number`; `runRenderStep(deps, ctx, run): Promise<RenderOutput>`
  - `lettering.ts`: `runLetteringStep(deps: { store; bus }, ctx, run): Promise<LetteringOutput>`
  - test helper `FakeQueue` (`on`, `enqueue`, `cancel`, `waitFor`, `succeed`, `fail`, `jobs(kind?)`, `idle()`, `asQueue()`), `fakeJobContext(store, bus, queue, job, signal?, progress?)`, `fakeImaging(store, queue, opts?)`

Render step rules (spec §8, brief): every story panel **and the chapter cover's panel** (both created by the scripts step, Task 6) gets one `image.generate {target:'panel'}` on lane `gpu`, tagged with `episodeRunId`; the estimate label (`Rendering N panels · est. ~X`) is reported **before** queueing. Panels whose active image was created after this step's `startedAt` are skipped, so retrying a failed render step only renders what is missing. Before rendering, every character used in a panel needs `refs.portrait`: review mode fails the step with a clear message; autopilot takes the character's first generated portrait (generating one if none exists yet). Then, when `settings.review.autoInEpisode`, up to `settings.review.rounds` batch rounds: `image.review` for every not-yet-reviewed active image on `engines.laneFor('review')`, wait for all, re-generate the flagged ones with `retryPatch`, and review only those in the next round. A failed review job counts as "not flagged" (review is advisory); a failed first render fails the step.

- [ ] **Step 1: Write the fake queue helper**

```ts
// packages/server/test/helpers/fake-queue.ts
import type { ImageGeneratePayload, ImageReviewPayload, Job, JobKind, ReviewResult } from '@manga/shared';
import type { EventBus } from '../../src/events/bus.js';
import { GpuArbiter, type EnqueueInput, type JobContext, type JobQueue } from '../../src/jobs/index.js';
import type { Store } from '../../src/store/index.js';
import { seedImage } from './seed.js';

export type FakeHandler = (job: Job, signal: AbortSignal) => unknown;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** In-memory JobQueue stand-in: jobs are real rows (store.jobs.list works); handlers run on the microtask queue. */
export class FakeQueue {
  private readonly handlers = new Map<JobKind, FakeHandler>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly order: string[] = [];
  private inflight = 0;

  constructor(private readonly store: Store) {}

  on(kind: JobKind, handler: FakeHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  enqueue(input: EnqueueInput): Job {
    const job = this.store.jobs.insert({
      kind: input.kind, lane: input.lane, payload: input.payload, priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3, nextRunAt: new Date().toISOString(), episodeRunId: input.episodeRunId ?? null,
    });
    this.order.push(job.id);
    const handler = this.handlers.get(input.kind);
    if (handler) {
      this.inflight++;
      queueMicrotask(() => { void this.run(job.id, handler); });
    }
    return job;
  }

  private async run(id: string, handler: FakeHandler): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      if (TERMINAL.has(this.store.jobs.require(id).status)) return;
      this.store.jobs.update(id, { status: 'running', startedAt: new Date().toISOString() });
      const result = await handler(this.store.jobs.require(id), controller.signal);
      this.settle(id, { status: 'succeeded', result: result ?? null });
    } catch (err) {
      this.settle(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.controllers.delete(id);
      this.inflight--;
    }
  }

  private settle(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job {
    const current = this.store.jobs.require(id);
    if (TERMINAL.has(current.status)) return current;
    const job = this.store.jobs.update(id, { ...patch, finishedAt: new Date().toISOString() });
    for (const resolve of this.waiters.get(id) ?? []) resolve(job);
    this.waiters.delete(id);
    return job;
  }

  succeed(id: string, result: unknown = null): Job { return this.settle(id, { status: 'succeeded', result }); }
  fail(id: string, error: string): Job { return this.settle(id, { status: 'failed', error }); }

  cancel(id: string): Job {
    this.controllers.get(id)?.abort();
    return this.settle(id, { status: 'cancelled' });
  }

  waitFor(id: string): Promise<Job> {
    const job = this.store.jobs.require(id);
    if (TERMINAL.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => { this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]); });
  }

  /** Jobs enqueued through this queue, in enqueue order. */
  jobs(kind?: JobKind): Job[] {
    return this.order.map((id) => this.store.jobs.require(id)).filter((j) => kind === undefined || j.kind === kind);
  }

  /** Resolves once no handler is running and none is scheduled. */
  async idle(): Promise<void> {
    for (let i = 0; i < 5_000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.inflight === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.inflight === 0) return;
      }
    }
    throw new Error('FakeQueue did not become idle');
  }

  asQueue(): JobQueue {
    return this as unknown as JobQueue;
  }
}

export function fakeJobContext(
  store: Store, bus: EventBus, queue: FakeQueue, job: Job, signal: AbortSignal = new AbortController().signal, progress: string[] = [],
): JobContext {
  return { job, signal, store, bus, gpu: new GpuArbiter(), queue: queue.asQueue(), progress: (label) => { progress.push(label); } };
}

export interface FakeImagingOptions {
  /** Issues to report for a review; [] or undefined = pass. */
  review?: (imageId: string, panelId: string | null) => ReviewResult['issues'] | undefined;
  /** Throw to make a panel render fail. */
  beforePanel?: (panelId: string) => void;
}

/** Stand-ins for M2's image.generate (panel + portrait) and image.review handlers. */
export function fakeImaging(store: Store, queue: FakeQueue, opts: FakeImagingOptions = {}): void {
  queue.on('image.generate', (job) => {
    const p = job.payload as ImageGeneratePayload;
    if (p.target === 'panel') {
      opts.beforePanel?.(p.panelId);
      const panel = store.panels.require(p.panelId);
      const page = store.pages.require(panel.pageId);
      const image = seedImage(store, page.mangaId, { type: 'panel', id: panel.id }, null);
      store.panels.update(panel.id, { activeImageId: image.id });
      return { imageId: image.id };
    }
    if (p.target === 'character-portrait') {
      const c = store.characters.require(p.characterId);
      return { imageId: seedImage(store, c.mangaId, { type: 'character', id: c.id }, 'portrait').id };
    }
    throw new Error(`fake imaging does not support ${p.target}`);
  });
  queue.on('image.review', (job) => {
    const p = job.payload as ImageReviewPayload;
    const issues = opts.review?.(p.imageId, p.panelId) ?? [];
    const review: ReviewResult = { engine: 'claude', pass: issues.length === 0, issues, at: new Date().toISOString() };
    store.images.update(p.imageId, { review });
    return review;
  });
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/episode-render.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, stepIndex, type EpisodeRun, type ImageGeneratePayload, type ServerEvent } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import { materializeScripts } from '../src/workflows/episode/effects.js';
import { runLetteringStep } from '../src/workflows/episode/lettering.js';
import { TEXT_NEGATIVE, retryPatch, runRenderStep, type DriverDeps } from '../src/workflows/episode/render.js';
import { nowIso, patchStep } from '../src/workflows/episode/steps.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeImaging, fakeJobContext, type FakeImagingOptions } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
let queue: FakeQueue;
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
  queue = new FakeQueue(lib.store);
});
afterEach(() => { lib.close(); });

const deps = (): DriverDeps => ({ store: lib.store, bus, queue: queue.asQueue(), engines: { laneFor: () => 'claude' }, newSeed: () => 777 });

/** Two story pages of two panels + the cover, all with Aiko; the render step is running. */
function renderWorld(opts: { portrait?: boolean; mode?: 'review' | 'autopilot' } = {}) {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  let aiko = seedCharacter(lib.store, manga.id, 'Aiko');
  if (opts.portrait !== false) aiko = giveRefs(lib.store, aiko, ['portrait']);
  const bd = breakdown(2);
  const sc = scripts(bd, 'Aiko');
  materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: sc, premise: PREMISE });
  const seeded = seedRun(lib.store, chapter.id, {
    mode: opts.mode ?? 'autopilot', outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: sc }, currentStep: 'render',
  });
  const run = lib.store.episodes.update(seeded.id, { steps: patchStep(seeded.steps, stepIndex('render'), { status: 'running', startedAt: nowIso() }) });
  const panelIds = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  return { manga, chapter, aiko, run, panelIds };
}

async function render(run: EpisodeRun, imaging: FakeImagingOptions = {}, progress: string[] = []) {
  fakeImaging(lib.store, queue, imaging);
  const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'cpu', payload: { type: 'episode', runId: run.id, step: 'render' }, priority: 0, maxAttempts: 1, nextRunAt: nowIso(), episodeRunId: run.id });
  return runRenderStep(deps(), fakeJobContext(lib.store, bus, queue, job, undefined, progress), run);
}

const panelJobs = (panelId: string) =>
  queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload & { panelId?: string }).panelId === panelId);

describe('retryPatch', () => {
  it('maps issue kinds to retry strategies', () => {
    const s = DEFAULT_SETTINGS;
    expect(retryPatch([], s, 1)).toEqual({ seed: 1 });
    expect(retryPatch([{ kind: 'identity', note: 'wrong hair' }], s, 2)).toEqual({ seed: 2, recipe: 'qwen-edit-ref' });
    expect(retryPatch([{ kind: 'text', note: 'letters on wall' }], s, 3)).toEqual({ seed: 3, negativeExtra: TEXT_NEGATIVE });
    expect(retryPatch([{ kind: 'anatomy', note: 'extra arm' }, { kind: 'script-mismatch', note: 'should be sitting' }], s, 4))
      .toEqual({ seed: 4, sceneSuffix: 'extra arm, should be sitting' });
    expect(retryPatch([{ kind: 'identity', note: '' }, { kind: 'text', note: '' }, { kind: 'character-count', note: 'only one person' }], s, 5))
      .toEqual({ seed: 5, recipe: 'qwen-edit-ref', negativeExtra: TEXT_NEGATIVE, sceneSuffix: 'only one person' });
  });
});

describe('runRenderStep', () => {
  it('renders every story panel and the cover, showing the estimate before queueing', async () => {
    const { run, panelIds } = renderWorld();
    const progress: string[] = [];
    const out = await render(run, {}, progress);
    expect(panelIds).toHaveLength(5);
    expect(out).toMatchObject({ reviewed: 5, flagged: 0, rounds: 0 });
    expect(out.jobs).toHaveLength(10);
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
    expect(progress[0]).toMatch(/^Rendering 5 panels · est\. ~\d+ (s|min)$/);
    expect(queue.jobs('image.generate').every((j) => j.lane === 'gpu' && j.episodeRunId === run.id)).toBe(true);
    expect(queue.jobs('image.review').every((j) => j.lane === 'claude')).toBe(true);
  });

  it('reviews in batches and re-renders flagged panels with the strategy for their issues', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[0]!;
    const seen = new Set<string>();
    const out = await render(run, {
      review: (_imageId, panelId) => {
        if (panelId !== target || seen.has(panelId)) return [];
        seen.add(panelId);
        return [{ kind: 'text', note: 'letters on the wall' }];
      },
    });
    expect(out).toMatchObject({ reviewed: 6, flagged: 1, rounds: 1 });
    expect(panelJobs(target).map((j) => j.payload)).toEqual([
      { target: 'panel', panelId: target },
      { target: 'panel', panelId: target, seed: 777, negativeExtra: TEXT_NEGATIVE },
    ]);
  });

  it('stops after settings.review.rounds', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[1]!;
    const out = await render(run, { review: (_i, panelId) => (panelId === target ? [{ kind: 'identity', note: 'not Aiko' }] : []) });
    expect(out).toMatchObject({ reviewed: 6, flagged: 2, rounds: 2 });
    expect(panelJobs(target)).toHaveLength(3);
    expect(panelJobs(target).at(-1)!.payload).toMatchObject({ recipe: DEFAULT_SETTINGS.routing.driftFallback, seed: 777 });
  });

  it('skips review when review.autoInEpisode is off', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run } = renderWorld();
    const out = await render(run);
    expect(out).toMatchObject({ reviewed: 0, flagged: 0, rounds: 0 });
    expect(queue.jobs('image.review')).toEqual([]);
  });

  it('refuses to render in review mode while a character has no portrait', async () => {
    const { run } = renderWorld({ portrait: false, mode: 'review' });
    await expect(render(run)).rejects.toThrow('Pick a portrait for Aiko in the Characters tab, then retry the render step');
    expect(queue.jobs('image.generate')).toEqual([]);
  });

  it('takes the first generated portrait in autopilot', async () => {
    const { run, aiko } = renderWorld({ portrait: false });
    const first = seedImage(lib.store, aiko.mangaId, { type: 'character', id: aiko.id }, 'portrait');
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
    seedImage(lib.store, aiko.mangaId, { type: 'character', id: aiko.id }, 'portrait');
    await render(run);
    expect(lib.store.characters.require(aiko.id).refs.portrait).toBe(first.id);
    expect(queue.jobs('image.generate').some((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait')).toBe(false);
  });

  it('generates a portrait in autopilot when none exists yet', async () => {
    const { run, aiko } = renderWorld({ portrait: false });
    await render(run);
    const portraitJobs = queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait');
    expect(portraitJobs).toHaveLength(1);
    expect(lib.store.characters.require(aiko.id).refs.portrait).toBe((portraitJobs[0]!.result as { imageId: string }).imageId);
  });

  it('on retry renders only the panels not rendered since the step started', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, manga, panelIds } = renderWorld();
    for (const id of panelIds.slice(0, 2)) {
      lib.store.panels.update(id, { activeImageId: seedImage(lib.store, manga.id, { type: 'panel', id }, null).id });
    }
    await render(run);
    expect(queue.jobs('image.generate').map((j) => (j.payload as { panelId: string }).panelId)).toEqual(panelIds.slice(2));
  });

  it('fails the step when a panel render fails, naming the panel', async () => {
    const { run, panelIds } = renderWorld();
    const broken = panelIds[2]!;
    await expect(render(run, { beforePanel: (id) => { if (id === broken) throw new Error('ComfyUI rejected the graph'); } }))
      .rejects.toThrow(`1 of 5 panel renders failed (${broken}: ComfyUI rejected the graph). Retry the render step to render only the missing panels.`);
  });
});

describe('runLetteringStep', () => {
  it('letters every story page and the cover title', async () => {
    const { run } = renderWorld();
    const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'cpu', payload: {}, priority: 0, maxAttempts: 1, nextRunAt: nowIso(), episodeRunId: run.id });
    const out = await runLetteringStep({ store: lib.store, bus }, fakeJobContext(lib.store, bus, queue, job), run);
    expect(out).toEqual({ frames: 5 });
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'textFrame' && e.op === 'created')).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/episode-render.test.ts`
Expected: FAIL — `Failed to load url ../src/workflows/episode/lettering.js`.

- [ ] **Step 4: Write the drivers**

```ts
// packages/server/src/workflows/episode/render.ts
import {
  estimateSeconds, formatEstimate, stepIndex,
  type Character, type EpisodeRun, type Image, type ImageGeneratePayload, type ImageGenerateResult, type ImageReviewPayload,
  type Manga, type Panel, type RenderOutput, type ReviewResult, type Settings,
} from '@manga/shared';
import { randomSeed } from '../../domain/seed.js';
import type { Engines } from '../../engines/resolve.js';
import type { EventBus } from '../../events/bus.js';
import { routeRecipe } from '../../imaging/route.js';
import { PermanentError, type JobContext, type JobQueue } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { emitEntity } from '../emit.js';
import { chapterPanels } from './chapter.js';

export type QueueLike = Pick<JobQueue, 'enqueue' | 'cancel' | 'waitFor'>;
export interface DriverDeps { store: Store; bus: EventBus; queue: QueueLike; engines: Pick<Engines, 'laneFor'>; newSeed?: () => number }

export const TEXT_NEGATIVE = 'text, letters, words, writing';
export interface RetryPatch { seed: number; recipe?: string; negativeExtra?: string; sceneSuffix?: string }

/** Spec §8 retry strategy: identity → drift recipe (M2 adds the B&W refine), text → stronger negative, others → notes in the scene. Always a new seed. */
export function retryPatch(issues: ReviewResult['issues'], settings: Settings, seed: number): RetryPatch {
  const kinds = new Set(issues.map((i) => i.kind));
  const notes = issues.filter((i) => i.kind !== 'identity' && i.kind !== 'text').map((i) => i.note.trim()).filter((n) => n.length > 0);
  return {
    seed,
    ...(kinds.has('identity') ? { recipe: settings.routing.driftFallback } : {}),
    ...(kinds.has('text') ? { negativeExtra: TEXT_NEGATIVE } : {}),
    ...(notes.length > 0 ? { sceneSuffix: notes.join(', ') } : {}),
  };
}

/** Spec §8: "panels × recipe average", with the routing M2 would use right now. */
export function estimateRender(store: Store, settings: Settings, manga: Manga, panels: Panel[]): number {
  return estimateSeconds(panels.flatMap((panel) => {
    const refCount = panel.refCharacterIds.filter((id) => {
      const c = store.characters.get(id);
      return c !== null && (c.refs.portrait !== undefined || c.refs.fullbody !== undefined);
    }).length;
    const route = routeRecipe({ settings, manga, panel, refCount, charCount: panel.script.characters.length });
    return route.refineWith ? [route.recipe, route.refineWith] : [route.recipe];
  }));
}

function renderedSince(store: Store, panel: Panel, token: string | null): boolean {
  if (token === null || panel.activeImageId === null) return false;
  const image = store.images.get(panel.activeImageId);
  return image !== null && image.createdAt >= token;
}

function firstPortrait(store: Store, characterId: string): Image | null {
  return store.images.listByOwner('character', characterId)
    .filter((i) => i.role === 'portrait')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

async function ensurePortraits(deps: DriverDeps, ctx: JobContext, run: EpisodeRun, panels: Panel[]): Promise<void> {
  const { store, queue, bus } = deps;
  const ids = [...new Set(panels.flatMap((p) => p.script.characters.map((c) => c.characterId)))];
  const missing = ids.map((id) => store.characters.get(id)).filter((c): c is Character => c !== null && c.refs.portrait === undefined);
  if (missing.length === 0) return;
  if (run.mode === 'review') {
    throw new PermanentError(`Pick a portrait for ${missing.map((c) => c.name).join(', ')} in the Characters tab, then retry the render step`);
  }
  for (const c of missing) {
    ctx.progress(`Choosing a portrait for ${c.name}`);
    let image = firstPortrait(store, c.id);
    if (!image) {
      const payload: ImageGeneratePayload = { target: 'character-portrait', characterId: c.id, seed: c.seed };
      const done = await queue.waitFor(queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id }).id);
      ctx.signal.throwIfAborted();
      image = firstPortrait(store, c.id);
      if (!image) throw new PermanentError(`Could not generate a portrait for ${c.name}: ${done.error ?? done.status}`);
    }
    store.characters.update(c.id, { refs: { ...store.characters.require(c.id).refs, portrait: image.id } });
    emitEntity(bus, 'character', c.id, 'updated', c.mangaId);
  }
}

interface GenRequest { panelId: string; patch?: RetryPatch }

async function generateAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, reqs: GenRequest[], jobIds: string[], label: string,
): Promise<{ done: Set<string>; failed: string[] }> {
  ctx.progress(label, 0, reqs.length); // before queueing, so the estimate is visible first
  const jobs = reqs.map((r) => {
    const payload: ImageGeneratePayload = { target: 'panel', panelId: r.panelId, ...r.patch };
    return deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  const done = new Set<string>();
  const failed: string[] = [];
  let count = 0;
  await Promise.all(jobs.map(async (job, i) => {
    const finished = await deps.queue.waitFor(job.id);
    const panelId = reqs[i]!.panelId;
    if (finished.status === 'succeeded' && (finished.result as ImageGenerateResult | null)?.imageId) done.add(panelId);
    else failed.push(`${panelId}: ${finished.error ?? finished.status}`);
    ctx.progress(label, ++count, reqs.length);
  }));
  ctx.signal.throwIfAborted();
  return { done, failed };
}

async function reviewAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, panels: Panel[], jobIds: string[], round: number,
): Promise<Array<{ panel: Panel; review: ReviewResult }>> {
  const lane = deps.engines.laneFor('review');
  const items = panels.flatMap((panel) => (panel.activeImageId ? [{ panel, imageId: panel.activeImageId }] : []));
  const label = `Reviewing ${items.length} images (round ${round})`;
  ctx.progress(label, 0, items.length);
  const jobs = items.map((it) => {
    const payload: ImageReviewPayload = { imageId: it.imageId, panelId: it.panel.id };
    return deps.queue.enqueue({ kind: 'image.review', lane, payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  let count = 0;
  const results = await Promise.all(jobs.map(async (job, i) => {
    await deps.queue.waitFor(job.id);
    ctx.progress(label, ++count, items.length);
    const review = deps.store.images.get(items[i]!.imageId)?.review ?? null; // a failed review counts as "not flagged"
    return review ? { panel: items[i]!.panel, review } : null;
  }));
  ctx.signal.throwIfAborted();
  return results.filter((r): r is { panel: Panel; review: ReviewResult } => r !== null);
}

/** Step 6 (spec §8): render, then batch review → re-render flagged, for at most settings.review.rounds rounds. */
export async function runRenderStep(deps: DriverDeps, ctx: JobContext, run: EpisodeRun): Promise<RenderOutput> {
  const { store } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const settings = store.settings.get();
  const token = run.steps[stepIndex('render')]?.startedAt ?? null;
  const ids = chapterPanels(store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  if (ids.length === 0) throw new PermanentError('Nothing to render: the chapter has no panels yet (the scripts step creates them)');
  const current = (): Panel[] => ids.map((id) => store.panels.require(id));

  await ensurePortraits(deps, ctx, run, current());
  const todo = current().filter((p) => !renderedSince(store, p, token));
  const jobIds: string[] = [];
  const estimate = formatEstimate(estimateRender(store, settings, manga, todo));
  const first = await generateAll(deps, ctx, run, todo.map((p) => ({ panelId: p.id })), jobIds, `Rendering ${todo.length} panels · est. ${estimate}`);
  if (first.failed.length > 0) {
    throw new PermanentError(
      `${first.failed.length} of ${todo.length} panel renders failed (${first.failed[0]}). Retry the render step to render only the missing panels.`,
    );
  }

  let reviewed = 0;
  let flagged = 0;
  let rounds = 0;
  if (settings.review.autoInEpisode && settings.review.rounds > 0) {
    const newSeed = deps.newSeed ?? randomSeed;
    let batch = current().filter((p) => p.activeImageId !== null && store.images.get(p.activeImageId)?.review == null);
    for (let round = 1; round <= settings.review.rounds && batch.length > 0; round++) {
      const results = await reviewAll(deps, ctx, run, batch, jobIds, round);
      reviewed += results.length;
      const bad = results.filter((r) => !r.review.pass);
      if (bad.length === 0) break;
      rounds = round;
      flagged += bad.length;
      const again = await generateAll(
        deps, ctx, run, bad.map((b) => ({ panelId: b.panel.id, patch: retryPatch(b.review.issues, settings, newSeed()) })), jobIds,
        `Re-rendering ${bad.length} flagged panels (round ${round})`,
      );
      batch = current().filter((p) => again.done.has(p.id));
    }
  }
  return { jobs: jobIds, reviewed, flagged, rounds };
}
```

```ts
// packages/server/src/workflows/episode/lettering.ts
import type { EpisodeRun, LetteringOutput, Page } from '@manga/shared';
import { letterPage } from '../../domain/lettering.js';
import type { EventBus } from '../../events/bus.js';
import type { JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { emitEntity } from '../emit.js';
import { storyPages } from './chapter.js';

/** Step 7 (spec §8): TextFrames from dialogue on every story page, plus the cover's title frame. */
export async function runLetteringStep(deps: { store: Store; bus: EventBus }, ctx: JobContext, run: EpisodeRun): Promise<LetteringOutput> {
  const { store, bus } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const cover = chapter.coverPageId === null ? null : store.pages.get(chapter.coverPageId);
  const pages: Page[] = [...storyPages(store, chapter.id), ...(cover ? [cover] : [])];
  let frames = 0;
  pages.forEach((page, i) => {
    ctx.progress('Lettering pages', i, pages.length);
    const created = letterPage(store, page.id);
    frames += created.length;
    for (const f of created) emitEntity(bus, 'textFrame', f.id, 'created', page.mangaId);
    if (created.length > 0) emitEntity(bus, 'page', page.id, 'updated', page.mangaId);
  });
  ctx.progress('Lettering pages', pages.length, pages.length);
  return { frames };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/episode-render.test.ts`
Expected: PASS — `Tests  11 passed (11)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workflows/episode/render.ts packages/server/src/workflows/episode/lettering.ts packages/server/test/helpers/fake-queue.ts packages/server/test/episode-render.test.ts
git commit -m "feat(server): episode render driver with batch review rounds, and the lettering driver" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Server — `EpisodeRunner` state machine and LLM steps

**Files:**
- Create: `packages/server/src/workflows/episode/llm.ts`, `packages/server/src/workflows/episode/runner.ts`
- Test: `packages/server/test/episode-runner.test.ts`

**Interfaces:**
- Consumes: Tasks 4–8 (`buildStepContext`, `templateVars`, `loadStepPrompt`, `renderTemplate`, `validationSchema`, step helpers, effects, `runRenderStep`, `runLetteringStep`, `QueueLike`, `DriverDeps`); `deletePage` (`../../domain/delete.js`), `NeedsConfirmError` (`../../domain/pages.js`), `ConflictError`, `ValidationError` (`../../errors.js`), `PermanentError`, `JobContext` (`../../jobs/index.js`), `Engines` (`../../engines/resolve.js`), `InvalidOutputError` (`../../engines/errors.js`).
- Produces:
  - `llm.ts`: `executeLlmStep(deps: { store; engines: Pick<Engines, 'for'> }, ctx, run, step: LlmStepName): Promise<unknown>`
  - `runner.ts`: `interface RunnerDeps { store; bus; queue: QueueLike; engines: Pick<Engines, 'for' | 'laneFor'>; newSeed?: () => number }`, `PORTRAITS_PER_NEW_CHARACTER = 4`, and

    ```ts
    class EpisodeRunner {
      constructor(deps: RunnerDeps);
      get(runId: string): EpisodeRun;                                    // NotFoundError → 404
      latest(chapterId: string): EpisodeRun | null;                      // 404 for an unknown chapter
      start(chapterId: string, input: EpisodeInput, mode: 'review' | 'autopilot'): EpisodeRun;
      approve(runId: string): EpisodeRun;
      autopilot(runId: string): EpisodeRun;                               // "Run to end"
      cancel(runId: string): EpisodeRun;
      editOutput(runId: string, step: EpisodeStepName, output: unknown): EpisodeRun;
      rerun(runId: string, step: EpisodeStepName, confirm: boolean): EpisodeRun;   // NeedsConfirmError → 409 needs_confirm
      resume(): number;                                                   // called by episodeModule.start()
      handleStepJob(ctx: JobContext, payload: LlmStepPayload): Promise<unknown>;   // the llm.step 'episode' handler
      stop(): void;
    }
    ```

State machine (spec §8):
- `start` → run `running`, chapter `generating`, step 0 dispatched. Refused (409 `conflict`) when the chapter already has story pages or an active run.
- **dispatch** marks the current `pending` step `running` with `startedAt` (the step's *token*; a retried failed step keeps its old token) and enqueues `llm.step {type:'episode', runId, step}` with `episodeRunId` — LLM steps on `engines.laneFor(STEP_TASK[step])`, render/lettering on `cpu` with `maxAttempts: 1` — and watches it with `queue.waitFor`: a failed/cancelled job fails the step (and the run), unless the step was re-run meanwhile (token mismatch).
- **handleStepJob** ignores a payload whose step is no longer the current running step; runs the step; re-reads the run and **discards the result if the token changed** (re-run while it was working); otherwise applies the effect (premise → chapter, scripts → materialize, prompts → panels) and completes the step.
- **complete**: a review point in `review` mode → step and run `awaiting-review`; otherwise the step is `done` and accepted. **accept**: after `outline`, new characters are created and 4 `image.generate {target:'character-portrait'}` jobs are queued for each; after the last step the run is `done` and the chapter `ready`; else `currentStep + 1` is dispatched.
- `approve` accepts the awaiting step; `autopilot` switches `mode` and approves when awaiting; `cancel` cancels every queued/running job of the run, marks the running step failed (`Cancelled`), run `cancelled`, chapter `draft`.
- `editOutput`: only premise…prompts, only when the step is `done` or `awaiting-review`; validated with the refined schema (a `ZodError` → 400); premise/scripts/prompts edits are applied to the chapter/panels.
- `rerun(step)`: allowed for the latest run and a step at or before `currentStep`; when `step` ≤ scripts and the chapter has story pages, requires `confirm` (409 `needs_confirm` listing the panel ids), then deletes those pages. Cancels the run's jobs, resets that step and all later ones to `pending` (a **failed current step keeps its token = retry**), status `running`, chapter `generating`, dispatch.
- `resume()`: for the latest run of every chapter in status `running`: a `pending` current step is dispatched; a `running` one is re-attached to its queued/running job if there is one, else enqueued again.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/episode-runner.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { EpisodeInput, ImageGeneratePayload, LlmStepPayload, ServerEvent } from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createPage, NeedsConfirmError } from '../src/domain/pages.js';
import { Engines } from '../src/engines/resolve.js';
import { ScriptedEngine, type ScriptedResponse } from '../src/engines/scripted.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { storyPages } from '../src/workflows/episode/chapter.js';
import { EpisodeRunner } from '../src/workflows/episode/runner.js';
import { PREMISE, TWO_PANEL_PRESET, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeImaging, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
});
afterEach(() => { lib.close(); });

interface Rig { runner: EpisodeRunner; queue: FakeQueue; claude: ScriptedEngine }

/** A runner on a FakeQueue. auto: llm.step and imaging jobs run by themselves; manual: jobs stay queued. */
function rig(opts: { auto?: boolean; responses?: Record<string, ScriptedResponse> } = {}): Rig {
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.responses });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.responses });
  const engines = new Engines({ settings: () => lib.store.settings.get(), claude, local });
  const queue = new FakeQueue(lib.store);
  const runner = new EpisodeRunner({ store: lib.store, bus, queue: queue.asQueue(), engines, newSeed: () => 1 });
  if (opts.auto !== false) {
    queue.on('llm.step', (job, signal) => runner.handleStepJob(fakeJobContext(lib.store, bus, queue, job, signal), job.payload as LlmStepPayload));
    fakeImaging(lib.store, queue);
  }
  return { runner, queue, claude };
}

function world() {
  const w = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, w.manga.id, 'Aiko');
  const input: EpisodeInput = { prompt: 'Aiko finds a cat in the rain', characterIds: [aiko.id], pages: 2, tone: '' };
  return { ...w, aiko, input };
}

const stepStatuses = (runId: string) => lib.store.episodes.require(runId).steps.map((s) => s.status);

describe('EpisodeRunner — flow', () => {
  it('review mode stops at the outline, with the premise written to the chapter', async () => {
    const { chapter, input } = world();
    const { runner, queue, claude } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    expect(stepStatuses(run.id)).toEqual(['done', 'awaiting-review', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 1 });
    expect(lib.store.chapters.require(chapter.id)).toMatchObject({ title: 'The Cat in the Rain', status: 'generating' });
    expect(claude.calls[0]).toMatchObject({ name: 'episode.premise', task: 'story' });
    expect(claude.calls[0]!.prompt).toContain('<context>');
    expect(claude.calls[0]!.system).toContain('in English');
    expect(queue.jobs('llm.step').map((j) => j.lane)).toEqual(['claude', 'claude']);
  });

  it('approving the outline creates the new characters, queues their portraits and continues to scripts', async () => {
    const { chapter, manga, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.approve(run.id);
    await queue.idle();
    const mika = lib.store.characters.listByManga(manga.id).find((c) => c.name === 'Mika')!;
    const portraits = queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait');
    expect(portraits.map((j) => (j.payload as { characterId: string }).characterId)).toEqual([mika.id, mika.id, mika.id, mika.id]);
    expect(portraits.every((j) => j.episodeRunId === run.id)).toBe(true);
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
    expect(storyPages(lib.store, chapter.id)).toHaveLength(2);
  });

  it('autopilot runs every step to the end and marks the chapter ready', async () => {
    const { chapter, manga, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
    expect(stepStatuses(run.id).every((s) => s === 'done')).toBe(true);
    const ch = lib.store.chapters.require(chapter.id);
    expect(ch.status).toBe('ready');
    const pages = storyPages(lib.store, chapter.id);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(lib.store.panels.listByPage(page.id).every((p) => p.activeImageId !== null && p.prompt.scene !== '')).toBe(true);
      expect(lib.store.frames.listByPage(page.id).length).toBeGreaterThan(0);
    }
    expect(lib.store.frames.listByPage(ch.coverPageId!).map((f) => f.kind)).toEqual(['title']);
    const mika = lib.store.characters.listByManga(manga.id).find((c) => c.name === 'Mika')!;
    expect(mika.refs.portrait).toBeDefined();
    const steps = queue.jobs('llm.step').map((j) => [(j.payload as { step: string }).step, j.lane, j.maxAttempts]);
    expect(steps).toEqual([
      ['premise', 'claude', 3], ['outline', 'claude', 3], ['breakdown', 'claude', 3], ['scripts', 'claude', 3],
      ['prompts', 'claude', 3], ['render', 'cpu', 1], ['lettering', 'cpu', 1],
    ]);
  });

  it('uses the lane of the engine chosen for each task', async () => {
    lib.store.settings.patch({ engine: { tasks: { prompts: 'local' } } });
    const { chapter, input } = world();
    const { runner, queue } = rig();
    runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const lanes = Object.fromEntries(queue.jobs('llm.step').map((j) => [(j.payload as { step: string }).step, j.lane]));
    expect(lanes).toMatchObject({ scripts: 'claude', prompts: 'gpu' });
  });

  it('"run to end" from a review point switches to autopilot and finishes', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    expect(runner.autopilot(run.id).mode).toBe('autopilot');
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
  });
});

describe('EpisodeRunner — guards', () => {
  it('start refuses a chapter that already has pages', () => {
    const { chapter, input } = world();
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const { runner } = rig({ auto: false });
    expect(() => runner.start(chapter.id, input, 'review')).toThrow(ConflictError);
    expect(lib.store.episodes.latestByChapter(chapter.id)).toBeNull();
  });

  it('start refuses a second active run and characters of another manga', () => {
    const { chapter, input } = world();
    const other = seedEpisodeWorld(lib.store, { mangaTitle: 'Other' });
    const stranger = seedCharacter(lib.store, other.manga.id, 'Stranger');
    const { runner } = rig({ auto: false });
    expect(() => runner.start(chapter.id, { ...input, characterIds: [stranger.id] }, 'review')).toThrow(ValidationError);
    runner.start(chapter.id, input, 'review');
    expect(() => runner.start(chapter.id, input, 'review')).toThrow('an episode run is already active for this chapter; cancel it first');
  });

  it('approve refuses a run that is not waiting for review', () => {
    const { chapter, input } = world();
    const { runner } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    expect(() => runner.approve(run.id)).toThrow('nothing to approve: the run is not waiting for review');
  });
});

describe('EpisodeRunner — failure, retry, edit, rerun, cancel', () => {
  it('a failing step fails the run with the engine message, and retrying it continues', async () => {
    let fail = true;
    const { chapter, input } = world();
    const { runner, queue } = rig({
      responses: {
        'episode.breakdown': (req) => {
          if (fail) throw new Error('model overloaded');
          return EPISODE_FAKE_RESPONSES['episode.breakdown']!(req);
        },
      },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const failed = runner.get(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.steps[2]).toMatchObject({ name: 'breakdown', status: 'failed', error: 'model overloaded' });
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
    fail = false;
    runner.rerun(run.id, 'breakdown', false);
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
  });

  it('edits are validated against the refined schema and premise edits reach the chapter', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.editOutput(run.id, 'premise', { ...PREMISE, title: 'A New Title' });
    expect(lib.store.chapters.require(chapter.id).title).toBe('A New Title');
    expect(runner.get(run.id).steps[0]!.output).toMatchObject({ title: 'A New Title' });
    expect(() => runner.editOutput(run.id, 'outline', { scenes: [], newCharacters: [] })).toThrow(ZodError);
    expect(() => runner.editOutput(run.id, 'render', { jobs: [], reviewed: 0, flagged: 0, rounds: 0 })).toThrow(ValidationError);
    expect(() => runner.editOutput(run.id, 'breakdown', { pages: [] })).toThrow('step breakdown has no output to edit (it is pending)');
  });

  it('re-running a step at or before scripts needs confirm once pages exist, then replaces them', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const before = storyPages(lib.store, chapter.id).map((p) => p.id);
    const err = (() => { try { runner.rerun(run.id, 'scripts', false); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(NeedsConfirmError);
    expect((err as NeedsConfirmError).removedPanelIds).toHaveLength(4);
    const rerun = runner.rerun(run.id, 'scripts', true);
    expect(rerun.steps.slice(3).every((s) => s.status === 'pending' || s.status === 'running')).toBe(true);
    await queue.idle();
    const after = storyPages(lib.store, chapter.id).map((p) => p.id);
    expect(runner.get(run.id).status).toBe('done');
    expect(after).toHaveLength(2);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it('an answer that stays invalid fails the step and keeps the raw output in the error', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ responses: { 'episode.premise': () => ({ title: '', synopsis: 'x' }) } });
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    const step = runner.get(run.id).steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.error).toContain('--- raw output ---');
    expect(step.error).toContain('"synopsis":"x"');
  });

  it('cancel stops the run, cancels its queued jobs and returns the chapter to draft', () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    const [job] = queue.jobs('llm.step');
    const cancelled = runner.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[0]).toMatchObject({ status: 'failed', error: 'Cancelled' });
    expect(lib.store.jobs.require(job!.id).status).toBe('cancelled');
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
  });
});

describe('EpisodeRunner — restart safety', () => {
  it('resume re-attaches to a queued step job instead of enqueueing a duplicate', () => {
    const { chapter, input } = world();
    const first = rig({ auto: false });
    first.runner.start(chapter.id, input, 'review');
    expect(first.queue.jobs('llm.step')).toHaveLength(1);
    const restarted = rig({ auto: false });
    expect(restarted.runner.resume()).toBe(1);
    expect(restarted.queue.jobs()).toEqual([]);
  });

  it('resume enqueues a pending current step and a running step whose job is gone', () => {
    const a = world();
    seedRun(lib.store, a.chapter.id, { outputs: { premise: PREMISE } });
    const b = seedEpisodeWorld(lib.store, { mangaTitle: 'Second' });
    const orphan = seedRun(lib.store, b.chapter.id);
    lib.store.episodes.update(orphan.id, { steps: orphan.steps.map((s, i) => (i === 0 ? { ...s, status: 'running', startedAt: '2026-09-27T00:00:00.000Z' } : s)) });
    const { runner, queue } = rig({ auto: false });
    expect(runner.resume()).toBe(2);
    expect(queue.jobs('llm.step').map((j) => (j.payload as { step: string }).step).sort()).toEqual(['outline', 'premise']);
  });

  it('a late result of a superseded job is discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { chapter, input } = world();
    const { runner, queue } = rig({
      auto: false,
      responses: { 'episode.premise': async (req) => { await gate; return EPISODE_FAKE_RESPONSES['episode.premise']!(req); } },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    const [old] = queue.jobs('llm.step');
    const pending = runner.handleStepJob(fakeJobContext(lib.store, bus, queue, old!), old!.payload as LlmStepPayload);
    runner.rerun(run.id, 'premise', false);
    release();
    await expect(pending).resolves.toEqual({ skipped: true });
    const after = runner.get(run.id);
    expect(after.steps[0]).toMatchObject({ status: 'running', output: null });
    expect(lib.store.chapters.require(chapter.id).title).toBe('Draft');
    expect(queue.jobs('llm.step')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/episode-runner.test.ts`
Expected: FAIL — `Failed to load url ../src/workflows/episode/runner.js`.

- [ ] **Step 3: Write `llm.ts`**

```ts
// packages/server/src/workflows/episode/llm.ts
import { STEP_TASK, type EpisodeRun } from '@manga/shared';
import { InvalidOutputError } from '../../engines/errors.js';
import type { Engines } from '../../engines/resolve.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { buildStepContext, templateVars } from './context.js';
import { loadStepPrompt, renderTemplate } from './prompts.js';
import { STEP_PROGRESS, type LlmStepName } from './steps.js';
import { validationSchema } from './validation.js';

/** Spec §13: after the correction round fails, the raw answer must be viewable in the stepper — it travels in the step error. */
export const RAW_OUTPUT_LIMIT = 4000;

/** One structured call; the engine's correction round sees the refined schema's messages (spec §3.2 structured.ts). */
export async function executeLlmStep(
  deps: { store: Store; engines: Pick<Engines, 'for'> }, ctx: JobContext, run: EpisodeRun, step: LlmStepName,
): Promise<unknown> {
  const task = STEP_TASK[step]!;
  const vars = templateVars(deps.store, run, buildStepContext(deps.store, run, step));
  const prompt = loadStepPrompt(step);
  const schema = validationSchema(deps.store, run, step);
  ctx.progress(STEP_PROGRESS[step]);
  try {
    const answer = await deps.engines.for(task).completeJson({
      name: `episode.${step}`, task, system: renderTemplate(prompt.system, vars), prompt: renderTemplate(prompt.user, vars),
      schema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    return schema.parse(answer);
  } catch (err) {
    if (err instanceof InvalidOutputError) {
      throw new PermanentError(`${err.message}\n--- raw output ---\n${err.raw.slice(0, RAW_OUTPUT_LIMIT)}`);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Write `runner.ts`**

```ts
// packages/server/src/workflows/episode/runner.ts
import {
  BreakdownOutputSchema, EDITABLE_STEPS, EPISODE_STEPS, OutlineOutputSchema, PremiseOutputSchema, PromptsOutputSchema,
  REVIEW_POINTS, STEP_TASK, ScriptsOutputSchema, panelIds, stepIndex,
  type Chapter, type EpisodeInput, type EpisodeRun, type EpisodeStepName, type ImageGeneratePayload, type Job, type LlmStepPayload,
} from '@manga/shared';
import { deletePage } from '../../domain/delete.js';
import { NeedsConfirmError } from '../../domain/pages.js';
import type { Engines } from '../../engines/resolve.js';
import { ConflictError, ValidationError } from '../../errors.js';
import type { EventBus } from '../../events/bus.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { emitEntity } from '../emit.js';
import { storyPages } from './chapter.js';
import { applyPremise, applyPrompts, applyScripts, createOutlineCharacters, materializeScripts } from './effects.js';
import { runLetteringStep } from './lettering.js';
import { executeLlmStep } from './llm.js';
import { runRenderStep, type DriverDeps, type QueueLike } from './render.js';
import { freshStep, freshSteps, monotonicIso, nowIso, patchStep, requireOutput } from './steps.js';
import { validationSchema } from './validation.js';

export interface RunnerDeps { store: Store; bus: EventBus; queue: QueueLike; engines: Pick<Engines, 'for' | 'laneFor'>; newSeed?: () => number }
export const PORTRAITS_PER_NEW_CHARACTER = 4;

type RunPatch = Partial<Omit<EpisodeRun, 'id' | 'chapterId' | 'createdAt'>>;
const ACTIVE: ReadonlySet<EpisodeRun['status']> = new Set(['running', 'awaiting-review']);

export class EpisodeRunner {
  private stopped = false;

  constructor(private readonly deps: RunnerDeps) {}

  get(runId: string): EpisodeRun {
    return this.deps.store.episodes.require(runId);
  }

  latest(chapterId: string): EpisodeRun | null {
    this.deps.store.chapters.require(chapterId);
    return this.deps.store.episodes.latestByChapter(chapterId);
  }

  start(chapterId: string, input: EpisodeInput, mode: EpisodeRun['mode']): EpisodeRun {
    const { store } = this.deps;
    const chapter = store.chapters.require(chapterId);
    const latest = store.episodes.latestByChapter(chapterId);
    if (latest && ACTIVE.has(latest.status)) throw new ConflictError('an episode run is already active for this chapter; cancel it first');
    if (storyPages(store, chapterId).length > 0) throw new ConflictError('the chapter already has pages; start the episode in an empty chapter');
    for (const id of input.characterIds) {
      if (store.characters.require(id).mangaId !== chapter.mangaId) throw new ValidationError(`character ${id} belongs to another manga`);
    }
    const run = store.episodes.create({ chapterId, input, mode, steps: freshSteps(), currentStep: 0, status: 'running' });
    this.emitRun(run, 'created');
    this.setChapterStatus(chapterId, 'generating');
    this.dispatch(run.id);
    return this.get(run.id);
  }

  approve(runId: string): EpisodeRun {
    const run = this.get(runId);
    const idx = run.currentStep;
    if (run.status !== 'awaiting-review' || run.steps[idx]?.status !== 'awaiting-review') {
      throw new ConflictError('nothing to approve: the run is not waiting for review');
    }
    const saved = this.save(run, { status: 'running', steps: patchStep(run.steps, idx, { status: 'done' }) });
    this.accept(saved, idx);
    return this.get(runId);
  }

  autopilot(runId: string): EpisodeRun {
    const run = this.get(runId);
    if (!ACTIVE.has(run.status)) throw new ConflictError(`the run is ${run.status}`);
    const saved = this.save(run, { mode: 'autopilot' });
    return saved.status === 'awaiting-review' ? this.approve(runId) : saved;
  }

  cancel(runId: string): EpisodeRun {
    const run = this.get(runId);
    if (!ACTIVE.has(run.status)) throw new ConflictError(`the run is already ${run.status}`);
    const steps = run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const, error: 'Cancelled', finishedAt: nowIso() } : s));
    const saved = this.save(run, { steps, status: 'cancelled' });
    this.cancelJobs(run.id);
    this.setChapterStatus(run.chapterId, 'draft');
    return saved;
  }

  editOutput(runId: string, name: EpisodeStepName, output: unknown): EpisodeRun {
    const run = this.get(runId);
    const idx = stepIndex(name);
    const step = run.steps[idx]!;
    if (!EDITABLE_STEPS.has(name)) throw new ValidationError(`the ${name} output is informational and cannot be edited`);
    if (step.status !== 'awaiting-review' && step.status !== 'done') {
      throw new ConflictError(`step ${name} has no output to edit (it is ${step.status})`);
    }
    const value = validationSchema(this.deps.store, run, name).parse(output); // ZodError → 400 validation
    const fx = { store: this.deps.store, bus: this.deps.bus };
    if (name === 'premise') applyPremise(fx, run.chapterId, PremiseOutputSchema.parse(value));
    if (name === 'scripts') applyScripts(fx, run.chapterId, ScriptsOutputSchema.parse(value));
    if (name === 'prompts') applyPrompts(fx, run.chapterId, PromptsOutputSchema.parse(value));
    const fresh = this.get(runId);
    return this.save(fresh, { steps: patchStep(fresh.steps, idx, { output: value }) });
  }

  rerun(runId: string, name: EpisodeStepName, confirm: boolean): EpisodeRun {
    const { store, bus } = this.deps;
    const run = this.get(runId);
    const idx = stepIndex(name);
    if (store.episodes.latestByChapter(run.chapterId)?.id !== run.id) throw new ConflictError('only the latest run of a chapter can be re-run');
    const target = run.steps[idx]!;
    if (idx > run.currentStep || target.status === 'pending') throw new ConflictError(`step ${name} has not run yet`);
    const pages = storyPages(store, run.chapterId);
    const replacesPages = idx <= stepIndex('scripts') && pages.length > 0;
    if (replacesPages && !confirm) throw new NeedsConfirmError(pages.flatMap((p) => panelIds(p.layout)));
    this.cancelJobs(run.id);
    if (replacesPages) {
      for (const page of pages) {
        deletePage(store, page.id);
        emitEntity(bus, 'page', page.id, 'deleted', page.mangaId);
      }
    }
    const retry = target.status === 'failed' && idx === run.currentStep; // continue where it stopped: keep the step's token
    const steps = run.steps.map((s, i) => {
      if (i < idx) return s;
      if (i === idx && retry) return { ...s, status: 'pending' as const, error: null, finishedAt: null };
      return freshStep(s.name);
    });
    this.save(this.get(runId), { steps, currentStep: idx, status: 'running' });
    this.setChapterStatus(run.chapterId, 'generating');
    this.dispatch(run.id);
    return this.get(run.id);
  }

  resume(): number {
    const { store } = this.deps;
    let resumed = 0;
    for (const manga of store.mangas.list()) {
      for (const chapter of store.chapters.listByManga(manga.id)) {
        const run = store.episodes.latestByChapter(chapter.id);
        const step = run?.steps[run.currentStep];
        if (!run || run.status !== 'running' || !step) continue;
        if (step.status === 'pending') {
          this.dispatch(run.id);
          resumed++;
        } else if (step.status === 'running') {
          const token = step.startedAt ?? monotonicIso();
          const job = this.findStepJob(run.id, step.name);
          if (job) this.watch(run.id, step.name, token, job.id);
          else this.enqueueStep(run.id, step.name, token);
          resumed++;
        }
      }
    }
    return resumed;
  }

  async handleStepJob(ctx: JobContext, payload: LlmStepPayload): Promise<unknown> {
    if (payload.type !== 'episode') throw new PermanentError(`not an episode step: ${payload.type}`);
    const idx = stepIndex(payload.step);
    const run = this.deps.store.episodes.get(payload.runId);
    const step = run?.steps[idx];
    if (!run || !step || run.status !== 'running' || run.currentStep !== idx || step.status !== 'running') return { skipped: true };
    const token = step.startedAt;
    const output = await this.execute(ctx, run, payload.step);
    const fresh = this.deps.store.episodes.get(run.id);
    const now = fresh?.steps[idx];
    if (!fresh || !now || fresh.status !== 'running' || now.status !== 'running' || now.startedAt !== token) return { skipped: true };
    this.applyResult(fresh, payload.step, output);
    this.complete(fresh.id, idx, output);
    return { step: payload.step };
  }

  stop(): void {
    this.stopped = true;
  }

  // ---- internals ----

  private execute(ctx: JobContext, run: EpisodeRun, name: EpisodeStepName): Promise<unknown> {
    if (name === 'render') return runRenderStep(this.driverDeps(), ctx, run);
    if (name === 'lettering') return runLetteringStep(this.deps, ctx, run);
    return executeLlmStep(this.deps, ctx, run, name);
  }

  private applyResult(run: EpisodeRun, name: EpisodeStepName, output: unknown): void {
    const fx = { store: this.deps.store, bus: this.deps.bus };
    if (name === 'premise') applyPremise(fx, run.chapterId, PremiseOutputSchema.parse(output));
    if (name === 'scripts') {
      materializeScripts(fx, run.chapterId, {
        breakdown: requireOutput(run, 'breakdown', BreakdownOutputSchema), scripts: ScriptsOutputSchema.parse(output),
        premise: requireOutput(run, 'premise', PremiseOutputSchema),
      });
    }
    if (name === 'prompts') applyPrompts(fx, run.chapterId, PromptsOutputSchema.parse(output));
  }

  private complete(runId: string, idx: number, output: unknown): void {
    const run = this.get(runId);
    const pause = REVIEW_POINTS.has(EPISODE_STEPS[idx]!) && run.mode === 'review';
    const steps = patchStep(run.steps, idx, { status: pause ? 'awaiting-review' : 'done', output, error: null, finishedAt: nowIso() });
    const saved = this.save(run, pause ? { steps, status: 'awaiting-review' } : { steps });
    if (!pause) this.accept(saved, idx);
  }

  private accept(run: EpisodeRun, idx: number): void {
    if (EPISODE_STEPS[idx] === 'outline') this.createCharacters(run);
    if (idx >= EPISODE_STEPS.length - 1) {
      this.save(this.get(run.id), { status: 'done' });
      this.setChapterStatus(run.chapterId, 'ready');
      return;
    }
    this.save(this.get(run.id), { currentStep: idx + 1 });
    this.dispatch(run.id);
  }

  /** Outline acceptance (spec §8): new characters + portrait variants; autopilot picks the first one at render time. */
  private createCharacters(run: EpisodeRun): void {
    const outline = requireOutput(run, 'outline', OutlineOutputSchema);
    const chapter = this.deps.store.chapters.require(run.chapterId);
    const created = createOutlineCharacters({ store: this.deps.store, bus: this.deps.bus }, chapter.mangaId, outline.newCharacters);
    for (const c of created) {
      for (let i = 0; i < PORTRAITS_PER_NEW_CHARACTER; i++) {
        const payload: ImageGeneratePayload = { target: 'character-portrait', characterId: c.id, seed: (c.seed + i) % 2 ** 32 };
        this.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id });
      }
    }
  }

  private dispatch(runId: string): void {
    if (this.stopped) return;
    const run = this.get(runId);
    const step = run.steps[run.currentStep];
    if (run.status !== 'running' || !step || step.status !== 'pending') return;
    const token = step.startedAt ?? monotonicIso();
    this.save(run, { steps: patchStep(run.steps, run.currentStep, { status: 'running', startedAt: token, error: null, finishedAt: null }) });
    this.enqueueStep(run.id, step.name, token);
  }

  private enqueueStep(runId: string, name: EpisodeStepName, token: string): void {
    const task = STEP_TASK[name];
    const payload: LlmStepPayload = { type: 'episode', runId, step: name };
    const job = this.deps.queue.enqueue(task
      ? { kind: 'llm.step', lane: this.deps.engines.laneFor(task), payload, episodeRunId: runId }
      : { kind: 'llm.step', lane: 'cpu', payload, episodeRunId: runId, maxAttempts: 1 });
    this.watch(runId, name, token, job.id);
  }

  private watch(runId: string, name: EpisodeStepName, token: string, jobId: string): void {
    void this.deps.queue.waitFor(jobId).then(
      (job) => { if (job.status !== 'succeeded') this.failStep(runId, name, token, job.status === 'cancelled' ? 'Cancelled' : job.error ?? 'Step failed'); },
      () => undefined,
    );
  }

  private failStep(runId: string, name: EpisodeStepName, token: string, error: string): void {
    if (this.stopped) return;
    const run = this.deps.store.episodes.get(runId);
    const idx = stepIndex(name);
    const step = run?.steps[idx];
    if (!run || !step || step.status !== 'running' || step.startedAt !== token) return;
    const status: EpisodeRun['status'] = run.status === 'running' ? 'failed' : run.status;
    this.save(run, { status, steps: patchStep(run.steps, idx, { status: 'failed', error, finishedAt: nowIso() }) });
    if (status === 'failed') this.setChapterStatus(run.chapterId, 'draft');
  }

  private findStepJob(runId: string, name: EpisodeStepName): Job | null {
    for (const status of ['queued', 'running'] as const) {
      const hit = this.deps.store.jobs.list({ status, limit: 10_000 }).find((j) => {
        const p = j.payload as { type?: string; step?: string } | null;
        return j.kind === 'llm.step' && j.episodeRunId === runId && p?.type === 'episode' && p.step === name;
      });
      if (hit) return hit;
    }
    return null;
  }

  private cancelJobs(runId: string): void {
    for (const status of ['queued', 'running'] as const) {
      for (const job of this.deps.store.jobs.list({ status, limit: 10_000 })) {
        if (job.episodeRunId !== runId) continue;
        try { this.deps.queue.cancel(job.id); } catch { /* finished meanwhile */ }
      }
    }
  }

  private driverDeps(): DriverDeps {
    const { store, bus, queue, engines, newSeed } = this.deps;
    return { store, bus, queue, engines, ...(newSeed ? { newSeed } : {}) };
  }

  private save(run: EpisodeRun, patch: RunPatch): EpisodeRun {
    const next = this.deps.store.episodes.update(run.id, patch);
    this.emitRun(next, 'updated');
    return next;
  }

  private emitRun(run: EpisodeRun, op: 'created' | 'updated'): void {
    emitEntity(this.deps.bus, 'episodeRun', run.id, op, this.deps.store.chapters.get(run.chapterId)?.mangaId ?? null);
  }

  private setChapterStatus(chapterId: string, status: Chapter['status']): void {
    const chapter = this.deps.store.chapters.update(chapterId, { status });
    emitEntity(this.deps.bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/episode-runner.test.ts`
Expected: PASS — `Tests  16 passed (16)`.

If `resume re-attaches…` fails because M1's `JobRepo.list` caps `limit` below 10 000, lower the limit in `findStepJob`/`cancelJobs` to the cap M1 enforces and rerun.

- [ ] **Step 6: Run the whole server suite**

Run: `npx vitest run packages/server`
Expected: all files pass (M1, M2 and M4 so far).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/workflows/episode/llm.ts packages/server/src/workflows/episode/runner.ts packages/server/test/episode-runner.test.ts
git commit -m "feat(server): EpisodeRunner — durable step machine with review points, autopilot, edit, rerun, cancel and resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Server — episode routes, `episodeModule`, `defaultModules`

**Files:**
- Create: `packages/server/src/workflows/episode/routes.ts`, `packages/server/src/workflows/episode/module.ts`
- Create: `packages/server/src/all-modules.ts`
- Modify: `packages/server/src/main.ts` (the `modules:` line and its imports)
- Create: `packages/server/test/helpers/m4-server.ts`
- Test: `packages/server/test/episode-routes.test.ts`

**Interfaces:**
- Consumes: `EpisodeRunner` (Task 9); `letterPage` (Task 7); `pageDetail` (`../../domain/pages.js`); `registerLlmStep` (`../../jobs/llm-step.js`); `servicesFor`, `M2Services` (`../../modules/services.js`); `aiModule`, `imagingModule`; `startServer`, `CoreDeps`, `AppModule` (`app.js`); M2 test helpers `startFakeComfy` (`test/fakes/fake-comfy.js`), `ComfyClient` (`src/imaging/comfy.js`).
- Produces:
  - `registerEpisodeRoutes(app, { store, bus, runner }): void` — the Contract B M4 rows except `/api/export`, plus `POST /api/pages/:id/auto-letter`
  - `episodeModule(deps: CoreDeps, services?: Pick<M2Services, 'engines'>): AppModule & { runner: EpisodeRunner }` — registers the `llm.step` type `'episode'` and the routes; `start()` → `runner.resume()`; `stop()` → `runner.stop()`
  - `defaultModules(deps: CoreDeps, services?: M2Services): AppModule[]` — `[aiModule, imagingModule, episodeModule]` (Task 14 appends `exportModule`)
  - test helper `startM4TestServer(opts?: { claude?; uiDir?; library? }) → M4TestServer { url; deps; library; claude; fake; api(method, path, body?); until(fn, timeoutMs?); close() }`

Errors need no mapping here: the runner throws M1's `ConflictError`/`ValidationError`/`NeedsConfirmError` (`HttpError` subclasses), `NotFoundError`, or a `ZodError`, and M1's error handler turns them into `ApiErrorBody` (409 `conflict`, 400 `validation`, 409 `needs_confirm` with `{removedPanelIds}`, 404 `not_found`). Bodyless POSTs (approve, autopilot, cancel, auto-letter) must accept no body, because the UI and CLI clients send none.

- [ ] **Step 1: Write the M4 test server helper**

```ts
// packages/server/test/helpers/m4-server.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@manga/shared';
import { defaultModules } from '../../src/all-modules.js';
import { startServer, type CoreDeps } from '../../src/app.js';
import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import { ComfyClient } from '../../src/imaging/comfy.js';
import { servicesFor } from '../../src/modules/services.js';
import { startFakeComfy, type FakeComfy } from '../fakes/fake-comfy.js';

export interface M4TestServer {
  url: string;
  deps: CoreDeps;
  library: string;
  claude: ScriptedEngine;
  fake: FakeComfy;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Polls `fn` every 50 ms until it returns something truthy. */
  until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface M4TestServerOptions {
  claude?: Record<string, ScriptedResponse>;
  /** Serve this built UI (export tests); default: no UI. */
  uiDir?: string | null;
  /** Reuse an existing library folder (restart tests); it is not deleted on close. */
  library?: string;
  config?: Partial<AppConfig>;
}

/** The whole app (defaultModules) on a temp library and a random port, with FakeComfy and scripted engines. */
export async function startM4TestServer(opts: M4TestServerOptions = {}): Promise<M4TestServer> {
  const library = opts.library ?? mkdtempSync(join(tmpdir(), 'manga-m4-server-'));
  const fake = await startFakeComfy();
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.claude });
  const started = await startServer({
    config: { libraryPath: library, port: 0, ...opts.config },
    uiDir: opts.uiDir ?? null,
    modules: (deps) => defaultModules(deps, servicesFor(deps, {
      fakes: false, claude, local, comfy: new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 }),
    })),
  });
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${started.url}${path}`, {
      method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const until = async <T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return {
    url: started.url, deps: started.deps, library, claude, fake, api, until,
    async close(): Promise<void> {
      await started.stop();
      await fake.close();
      if (!opts.library) rmSync(library, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/episode-routes.test.ts
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_SCRIPT, type ApiErrorBody, type Chapter, type EpisodeRun, type Manga, type PageDetail } from '@manga/shared';
import { seedEpisodeWorld, seedRun, TWO_PANEL_PRESET } from './helpers/episode-fixtures.js';
import { openTestLibrary } from './helpers/library.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function chapterOn(server: M4TestServer): Promise<{ manga: Manga; chapter: Chapter }> {
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: `Routes ${Date.now()}` })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  return { manga, chapter };
}

async function runUntil(server: M4TestServer, chapterId: string, status: EpisodeRun['status'], step?: number): Promise<EpisodeRun> {
  return server.until(async () => {
    const run = (await server.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;
    return run && run.status === status && (step === undefined || run.currentStep === step) ? run : null;
  });
}

describe('episode routes', { timeout: 90_000 }, () => {
  it('GET is null before a run; POST starts one that stops at the outline in review mode', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    expect(await s.api('GET', `/api/chapters/${chapter.id}/episode`)).toEqual({ status: 200, body: null });
    const started = await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 }, mode: 'review' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ chapterId: chapter.id, mode: 'review', input: { prompt: 'A cat', pages: 1, characterIds: [], tone: '' } });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.steps[0]!.status).toBe('done');
  });

  it('maps errors: 409 conflict, 404 not_found, 400 validation', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    const again = await s.api<ApiErrorBody>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'Again', pages: 1 } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
    expect((await s.api<ApiErrorBody>('POST', '/api/episodes/er_missing000/approve')).status).toBe(404);
    const badStep = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/colouring/rerun`, {});
    expect([badStep.status, badStep.body.error.code]).toEqual([400, 'validation']);
    const badInput = await s.api<ApiErrorBody>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: '', pages: 99 } });
    expect([badInput.status, badInput.body.error.code]).toEqual([400, 'validation']);
  });

  it('PUT output validates and applies the edit', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    const premise = { title: 'Edited', synopsis: 'S.', tone: 'calm', setting: 'Pier' };
    const ok = await s.api<EpisodeRun>('PUT', `/api/episodes/${run.id}/steps/premise/output`, { output: premise });
    expect(ok.status).toBe(200);
    expect(ok.body.steps[0]!.output).toEqual(premise);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.title).toBe('Edited');
    const bad = await s.api<ApiErrorBody>('PUT', `/api/episodes/${run.id}/steps/outline/output`, { output: { scenes: [], newCharacters: [] } });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'validation']);
  });

  it('rerun answers 409 needs_confirm with the panel ids, and replaces the pages with confirm', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect((await s.api('POST', `/api/episodes/${run.id}/approve`)).status).toBe(200);
    await runUntil(s, chapter.id, 'awaiting-review', 3);
    const refused = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/breakdown/rerun`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('needs_confirm');
    expect((refused.body.error.details as { removedPanelIds: string[] }).removedPanelIds).toHaveLength(2);
    const accepted = await s.api<EpisodeRun>('POST', `/api/episodes/${run.id}/steps/breakdown/rerun`, { confirm: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.currentStep).toBe(2);
    await runUntil(s, chapter.id, 'awaiting-review', 3);
  });

  it('autopilot and cancel', async () => {
    s = await startM4TestServer();
    const a = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${a.chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, a.chapter.id, 'awaiting-review', 1);
    const cancelled = await s.api<EpisodeRun>('POST', `/api/episodes/${run.id}/cancel`);
    expect([cancelled.status, cancelled.body.status]).toEqual([200, 'cancelled']);
    expect((await s.api<Chapter>('GET', `/api/chapters/${a.chapter.id}`)).body.status).toBe('draft');
    const b = await chapterOn(s);
    const second = (await s.api<EpisodeRun>('POST', `/api/chapters/${b.chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, b.chapter.id, 'awaiting-review', 1);
    expect((await s.api<EpisodeRun>('POST', `/api/episodes/${second.id}/autopilot`)).body.mode).toBe('autopilot');
    await runUntil(s, b.chapter.id, 'done');
    expect((await s.api<Chapter>('GET', `/api/chapters/${b.chapter.id}`)).body.status).toBe('ready');
  });

  it('auto-letter letters a page once', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: TWO_PANEL_PRESET })).body;
    const panel = page.panels[0]!;
    await s.api('PATCH', `/api/panels/${panel.id}`, {
      script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Rain.' }, { speakerId: null, kind: 'sfx', text: 'DRIP' }] },
    });
    const first = await s.api<PageDetail>('POST', `/api/pages/${page.page.id}/auto-letter`);
    expect(first.status).toBe(200);
    expect(first.body.frames.map((f) => f.kind)).toEqual(['narration', 'sfx']);
    const second = await s.api<PageDetail>('POST', `/api/pages/${page.page.id}/auto-letter`);
    expect(second.body.frames).toHaveLength(2);
    expect((await s.api('POST', '/api/pages/pg_missing000/auto-letter')).status).toBe(404);
  });

  it('resumes a running run when the server starts', async () => {
    const lib = openTestLibrary();
    const { chapter } = seedEpisodeWorld(lib.store);
    seedRun(lib.store, chapter.id, { input: { pages: 1 } });
    lib.store.close();
    s = await startM4TestServer({ library: lib.dir });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.steps[0]!.status).toBe('done');
    await s.close();
    s = null;
    rmSync(lib.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/episode-routes.test.ts`
Expected: FAIL — `Failed to load url ../../src/all-modules.js` (imported by the helper).

- [ ] **Step 4: Write the routes, the module and `defaultModules`**

```ts
// packages/server/src/workflows/episode/routes.ts
import type { FastifyInstance } from 'fastify';
import {
  EpisodeStepNameSchema, RerunStepSchema, StartEpisodeSchema, StepOutputSchema, type EpisodeRun, type PageDetail,
} from '@manga/shared';
import { letterPage } from '../../domain/lettering.js';
import { pageDetail } from '../../domain/pages.js';
import type { EventBus } from '../../events/bus.js';
import type { Store } from '../../store/index.js';
import { emitEntity } from '../emit.js';
import type { EpisodeRunner } from './runner.js';

interface IdParams { Params: { id: string } }
interface StepParams { Params: { id: string; step: string } }

export function registerEpisodeRoutes(app: FastifyInstance, deps: { store: Store; bus: EventBus; runner: EpisodeRunner }): void {
  const { store, bus, runner } = deps;

  app.post<IdParams>('/api/chapters/:id/episode', async (req): Promise<EpisodeRun> => {
    const body = StartEpisodeSchema.parse(req.body ?? {});
    return runner.start(req.params.id, body.input, body.mode);
  });
  app.get<IdParams>('/api/chapters/:id/episode', async (req): Promise<EpisodeRun | null> => runner.latest(req.params.id));

  app.post<IdParams>('/api/episodes/:id/approve', async (req): Promise<EpisodeRun> => runner.approve(req.params.id));
  app.post<IdParams>('/api/episodes/:id/autopilot', async (req): Promise<EpisodeRun> => runner.autopilot(req.params.id));
  app.post<IdParams>('/api/episodes/:id/cancel', async (req): Promise<EpisodeRun> => runner.cancel(req.params.id));

  app.put<StepParams>('/api/episodes/:id/steps/:step/output', async (req): Promise<EpisodeRun> => {
    const step = EpisodeStepNameSchema.parse(req.params.step);
    const { output } = StepOutputSchema.parse(req.body ?? {});
    return runner.editOutput(req.params.id, step, output);
  });
  app.post<StepParams>('/api/episodes/:id/steps/:step/rerun', async (req): Promise<EpisodeRun> => {
    const step = EpisodeStepNameSchema.parse(req.params.step);
    const { confirm } = RerunStepSchema.parse(req.body ?? {});
    return runner.rerun(req.params.id, step, confirm);
  });

  app.post<IdParams>('/api/pages/:id/auto-letter', async (req): Promise<PageDetail> => {
    const created = letterPage(store, req.params.id);
    const page = store.pages.require(req.params.id);
    for (const f of created) emitEntity(bus, 'textFrame', f.id, 'created', page.mangaId);
    if (created.length > 0) emitEntity(bus, 'page', page.id, 'updated', page.mangaId);
    return pageDetail(store, page.id);
  });
}
```

```ts
// packages/server/src/workflows/episode/module.ts
import type { AppModule, CoreDeps } from '../../app.js';
import { registerLlmStep } from '../../jobs/llm-step.js';
import { servicesFor, type M2Services } from '../../modules/services.js';
import { registerEpisodeRoutes } from './routes.js';
import { EpisodeRunner } from './runner.js';

/** Contract C.5: M4's episode module. Engines come from M2's shared service set. */
export function episodeModule(deps: CoreDeps, services: Pick<M2Services, 'engines'> = servicesFor(deps)): AppModule & { runner: EpisodeRunner } {
  const runner = new EpisodeRunner({ store: deps.store, bus: deps.bus, queue: deps.queue, engines: services.engines });
  return {
    name: 'episode',
    runner,
    register(app): void {
      registerLlmStep('episode', (ctx, payload) => runner.handleStepJob(ctx, payload));
      registerEpisodeRoutes(app, { store: deps.store, bus: deps.bus, runner });
    },
    start(): void {
      runner.resume(); // runs before queue.start() (startup order: listen → module start → queue.start)
    },
    stop(): void {
      runner.stop();
    },
  };
}
```

```ts
// packages/server/src/all-modules.ts
import type { AppModule, CoreDeps } from './app.js';
import { aiModule } from './modules/ai.js';
import { imagingModule } from './modules/imaging.js';
import { servicesFor, type M2Services } from './modules/services.js';
import { episodeModule } from './workflows/episode/module.js';

/** Every module of the app, sharing one M2 service set. Used by main.ts and the integration tests. */
export function defaultModules(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule[] {
  return [aiModule(deps, services), imagingModule(deps, services), episodeModule(deps, services)];
}
```

In `packages/server/src/main.ts`, replace the M2 line `modules: (d) => [aiModule(d), imagingModule(d)]` with:

```ts
  modules: (d) => defaultModules(d),
```

and replace the two M2 imports (`./modules/ai.js`, `./modules/imaging.js`) with:

```ts
import { defaultModules } from './all-modules.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/episode-routes.test.ts`
Expected: PASS — `Tests  7 passed (7)`.

Run: `npx tsc --build packages/server/tsconfig.json`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workflows/episode/routes.ts packages/server/src/workflows/episode/module.ts packages/server/src/all-modules.ts packages/server/src/main.ts packages/server/test/helpers/m4-server.ts packages/server/test/episode-routes.test.ts
git commit -m "feat(server): episode REST routes, auto-letter route, episodeModule and defaultModules wiring" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Server — full autopilot integration test

**Files:**
- Test: `packages/server/test/episode-autopilot.test.ts`

**Interfaces:**
- Consumes: `startM4TestServer` (Task 10) — the real `JobQueue`, M2's real job handlers against FakeComfy, `ScriptedEngine` with `FAKE_RESPONSES` (incl. Task 5's `episode.*`).
- Produces: nothing new; this is the end-to-end proof of spec §8 with fakes (MANGA_FAKES-style wiring).

- [ ] **Step 1: Write the test**

```ts
// packages/server/test/episode-autopilot.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Chapter, Character, EpisodeRun, Job, Manga, Page, PageDetail } from '@manga/shared';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const FINAL = new Set(['done', 'failed', 'cancelled']);

async function finished(server: M4TestServer, chapterId: string): Promise<EpisodeRun> {
  const run = await server.until(async () => {
    const r = (await server.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;
    return r && FINAL.has(r.status) ? r : null;
  }, 100_000);
  expect(run.status, JSON.stringify(run.steps.find((st) => st.status === 'failed') ?? null)).toBe('done');
  return run;
}

async function setup(server: M4TestServer, pages: number) {
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Дощ', language: 'uk' })).body;
  const aiko = (await server.api<Character>('POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko', appearanceTags: '1girl, short black hair' })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'Один' })).body;
  const run = (await server.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, {
    input: { prompt: 'Айко знаходить кота під дощем', characterIds: [aiko.id], pages }, mode: 'autopilot',
  })).body;
  return { manga, chapter, run };
}

describe('episode in autopilot (integration, fakes)', { timeout: 120_000 }, () => {
  it('turns one prompt into a lettered two-page chapter with a cover', async () => {
    s = await startM4TestServer();
    const { manga, chapter, run } = await setup(s, 2);
    await finished(s, chapter.id);

    const ch = (await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body;
    expect(ch).toMatchObject({ status: 'ready', title: 'Кіт під дощем' });
    expect(ch.coverPageId).not.toBeNull();

    const pages = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body;
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const detail = (await s.api<PageDetail>('GET', `/api/pages/${page.id}`)).body;
      expect(detail.panels).toHaveLength(2);
      for (const panel of detail.panels) {
        expect(panel.activeImageId).not.toBeNull();
        expect(detail.images[panel.activeImageId!]!.width).toBeGreaterThan(0);
        expect(panel.prompt.scene).not.toBe('');
      }
      expect(detail.frames.length).toBeGreaterThan(0);
      expect(detail.frames.some((f) => f.text.startsWith('Привіт'))).toBe(true);
    }

    const cover = (await s.api<PageDetail>('GET', `/api/pages/${ch.coverPageId}`)).body;
    expect(cover.panels[0]!.activeImageId).not.toBeNull();
    expect(cover.frames.map((f) => [f.kind, f.text])).toEqual([['title', 'Кіт під дощем']]);

    const characters = (await s.api<Character[]>('GET', `/api/mangas/${manga.id}/characters`)).body;
    expect(characters.find((c) => c.name === 'Mika')?.refs.portrait).toBeDefined();

    const jobs = (await s.api<Job[]>('GET', '/api/jobs?limit=200')).body.filter((j) => j.episodeRunId === run.id);
    const count = (kind: Job['kind']) => jobs.filter((j) => j.kind === kind).length;
    expect(count('llm.step')).toBe(7);
    expect(count('image.generate')).toBe(4 + 5); // Mika's portraits + 4 story panels + the cover
    expect(count('image.review')).toBe(5);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('re-running scripts needs confirm, then replaces the pages and finishes again', async () => {
    s = await startM4TestServer();
    const { chapter, run } = await setup(s, 1);
    await finished(s, chapter.id);
    const before = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => p.id);

    const refused = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/scripts/rerun`, {});
    expect([refused.status, refused.body.error.code]).toEqual([409, 'needs_confirm']);
    expect((await s.api('POST', `/api/episodes/${run.id}/steps/scripts/rerun`, { confirm: true })).status).toBe(200);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.status).toBe('generating');
    await finished(s, chapter.id);

    const after = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run packages/server/test/episode-autopilot.test.ts`
Expected: PASS — `Tests  2 passed (2)`. Everything it needs exists after Task 10, so a failure here is a real integration bug: read the step error printed by the `finished()` assertion, fix the owning task's code, and rerun that task's unit test before this one.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/episode-autopilot.test.ts
git commit -m "test(server): full autopilot episode run against FakeComfy and scripted engines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Server — export slugs and paths

**Files:**
- Create: `packages/server/src/export/slug.ts`, `packages/server/src/export/paths.ts`
- Test: `packages/server/test/export-paths.test.ts`

**Interfaces:**
- Consumes: `storyPages` (Task 4); `PermanentError` (`../jobs/index.js`); `Store`; `ExportRenderPayload`, `Chapter`, `Manga`, `Page`, `PageFormat` (`@manga/shared`).
- Produces:
  - `slug.ts`: `transliterate(text): string` (Ukrainian KMU-2010 table, word-initial `є ї й ю я` → `ye yi y yu ya`; also `ы э ъ ё`), `slugify(text, fallback): string` (ASCII `[a-z0-9-]`, ≤ 60 chars, never empty)
  - `paths.ts`: `printPx(format): { width; height }` (182×257 mm @ 300 dpi → 2150×3035), `chapterSlug(chapter)` (`<nn>-<slug>`), `exportDir(exportsRoot, manga, chapter | null, outDir?)`, `pageFileName(page, storyIndex, ext)` (`page-<nn>.<ext>` / `cover.<ext>`), `interface ExportItem { pageId: string; file: string }`, `interface ExportPlan { dir; items: ExportItem[]; chapterPdf: string | null; format: 'png' | 'pdf'; pageFormat: PageFormat }`, `planExport(store, payload: ExportRenderPayload): ExportPlan`

Layout (Global Constraints): `<library>/exports/<mangaSlug>/<chapterSlug>/page-<nn>.png|pdf`, `cover.png|pdf`, and `chapter.pdf`; a manga cover (chapterId null) goes to `<mangaSlug>/cover/`. `--out`/`outDir` replaces the whole directory. The chapter slug starts with the chapter number, so two chapters with the same title never share a folder.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/export-paths.test.ts
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT } from '@manga/shared';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { chapterSlug, exportDir, planExport, printPx } from '../src/export/paths.js';
import { slugify, transliterate } from '../src/export/slug.js';
import { PermanentError } from '../src/jobs/index.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

describe('slugs', () => {
  it('transliterates Ukrainian with word-initial forms', () => {
    expect(transliterate('Їжак і Юля')).toBe('yizhak i yulia');
    expect(transliterate('Щастя')).toBe('shchastia');
    expect(transliterate('Розділ перший')).toBe('rozdil pershyi');
  });

  it('slugify makes ASCII slugs and falls back when nothing is left', () => {
    expect(slugify('Кіт під дощем', 'x')).toBe('kit-pid-doshchem');
    expect(slugify('  Café Noir: Part 2! ', 'x')).toBe('cafe-noir-part-2');
    expect(slugify('Ґанок', 'x')).toBe('ganok');
    expect(slugify('!!!', 'chapter')).toBe('chapter');
    const long = slugify('word '.repeat(40), 'x');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });

  it('chapter dirs never collide', () => {
    const { chapter } = seedEpisodeWorld(lib.store, { chapterTitle: 'Rain' });
    const second = lib.store.chapters.create({ mangaId: chapter.mangaId, number: 2, title: 'Rain', synopsis: '', coverPageId: null, status: 'draft', order: 1 });
    expect([chapterSlug(chapter), chapterSlug(second)]).toEqual(['01-rain', '02-rain']);
  });
});

describe('export paths', () => {
  it('computes the print pixel size of the page format', () => {
    expect(printPx(DEFAULT_PAGE_FORMAT)).toEqual({ width: 2150, height: 3035 });
  });

  it('puts exports under <library>/exports/<manga>/<chapter>, or in outDir', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Кіт під дощем', chapterTitle: 'Розділ перший' });
    const root = lib.store.files.exportsDir();
    expect(exportDir(root, manga, chapter)).toBe(join(root, 'kit-pid-doshchem', '01-rozdil-pershyi'));
    expect(exportDir(root, manga, null)).toBe(join(root, 'kit-pid-doshchem', 'cover'));
    expect(exportDir(root, manga, chapter, 'out/here')).toBe(resolve('out/here'));
  });

  it('plans a single page and a whole chapter', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const second = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const dir = join(lib.store.files.exportsDir(), 'rain-town', '01-one');

    const one = planExport(lib.store, { target: { type: 'page', id: second.page.id }, format: 'png' });
    expect(one).toMatchObject({ dir, chapterPdf: null, format: 'png', items: [{ pageId: second.page.id, file: join(dir, 'page-02.png') }] });

    const all = planExport(lib.store, { target: { type: 'chapter', id: chapter.id }, format: 'pdf' });
    expect(all.items.map((i) => i.file)).toEqual([join(dir, 'cover.pdf'), join(dir, 'page-01.pdf'), join(dir, 'page-02.pdf')]);
    expect(all.items[0]!.pageId).toBe(cover.page.id);
    expect(all.chapterPdf).toBe(join(dir, 'chapter.pdf'));
  });

  it('refuses a chapter without pages', () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    expect(() => planExport(lib.store, { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).toThrow(PermanentError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/export-paths.test.ts`
Expected: FAIL — `Failed to load url ../src/export/paths.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/export/slug.ts
/** Ukrainian national transliteration (KMU 2010), plus a few Russian letters; lower-case output. */
const LETTERS: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'io', "'": '', '’': '', 'ʼ': '',
};
const WORD_INITIAL: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };

export function transliterate(text: string): string {
  let out = '';
  let inWord = false;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = (!inWord ? WORD_INITIAL[lower] : undefined) ?? LETTERS[lower];
    out += mapped ?? ch;
    inWord = /\p{L}/u.test(ch);
  }
  return out;
}

/** ASCII folder/file name: [a-z0-9-], at most 60 chars, never empty. */
export function slugify(text: string, fallback: string): string {
  const ascii = transliterate(text).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || fallback;
}
```

```ts
// packages/server/src/export/paths.ts
import { join, resolve } from 'node:path';
import type { Chapter, ExportRenderPayload, Manga, Page, PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import { storyPages } from '../workflows/episode/chapter.js';
import { slugify } from './slug.js';

export function printPx(format: PageFormat): { width: number; height: number } {
  return { width: Math.round((format.widthMm / 25.4) * format.dpi), height: Math.round((format.heightMm / 25.4) * format.dpi) };
}

export function chapterSlug(chapter: Chapter): string {
  return `${String(chapter.number).padStart(2, '0')}-${slugify(chapter.title, 'chapter')}`;
}

export function exportDir(exportsRoot: string, manga: Manga, chapter: Chapter | null, outDir?: string): string {
  if (outDir) return resolve(outDir);
  return join(exportsRoot, slugify(manga.title, `manga-${manga.id}`), chapter ? chapterSlug(chapter) : 'cover');
}

export function pageFileName(page: Page, storyIndex: number, ext: 'png' | 'pdf'): string {
  return page.kind === 'cover' ? `cover.${ext}` : `page-${String(storyIndex + 1).padStart(2, '0')}.${ext}`;
}

export interface ExportItem { pageId: string; file: string }
export interface ExportPlan { dir: string; items: ExportItem[]; chapterPdf: string | null; format: 'png' | 'pdf'; pageFormat: PageFormat }

/** Which pages go to which files. A chapter export is its cover (if any) followed by its story pages. */
export function planExport(store: Store, payload: ExportRenderPayload): ExportPlan {
  const ext = payload.format;
  if (payload.target.type === 'page') {
    const page = store.pages.require(payload.target.id);
    const manga = store.mangas.require(page.mangaId);
    const chapter = page.chapterId !== null ? store.chapters.require(page.chapterId) : null;
    const index = chapter ? storyPages(store, chapter.id).findIndex((p) => p.id === page.id) : 0;
    const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir);
    return { dir, items: [{ pageId: page.id, file: join(dir, pageFileName(page, Math.max(0, index), ext)) }], chapterPdf: null, format: ext, pageFormat: manga.pageFormat };
  }
  const chapter = store.chapters.require(payload.target.id);
  const manga = store.mangas.require(chapter.mangaId);
  const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir);
  const cover = chapter.coverPageId !== null ? store.pages.get(chapter.coverPageId) : null;
  const story = storyPages(store, chapter.id);
  if (!cover && story.length === 0) throw new PermanentError(`chapter ${chapter.id} has no pages to export`);
  const items: ExportItem[] = [
    ...(cover ? [{ pageId: cover.id, file: join(dir, pageFileName(cover, 0, ext)) }] : []),
    ...story.map((p, i) => ({ pageId: p.id, file: join(dir, pageFileName(p, i, ext)) })),
  ];
  return { dir, items, chapterPdf: ext === 'pdf' ? join(dir, 'chapter.pdf') : null, format: ext, pageFormat: manga.pageFormat };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/export-paths.test.ts`
Expected: PASS — `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/export/slug.ts packages/server/src/export/paths.ts packages/server/test/export-paths.test.ts
git commit -m "feat(server): export slugs (Ukrainian transliteration) and output paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Server — print-resolution planning and `printDetail`

**Files:**
- Create: `packages/server/src/export/hires.ts`
- Test: `packages/server/test/export-hires.test.ts`

**Interfaces:**
- Consumes: `printPx` (Task 12); `computeRects` (`@manga/shared`); `pageDetail` (`../domain/pages.js`); `Store`.
- Produces:
  - `interface UpscalePlan { panelId: string; imageId: string; factor: 2 | 4 }`
  - `bestUpscaled(store, panelId, parentImageId): Image | null` — the widest `upscaled` child owned by the panel
  - `planUpscales(store, detail: PageDetail, format: PageFormat): UpscalePlan[]` — spec §9.2: an active image whose cover-fitted pixels (× `imageTransform.scale`) fall under the printed panel size at the format's dpi gets one 2× (need ≤ 2) or 4× upscale; skipped when the image is itself upscaled or already has an upscaled child
  - `printDetail(store, pageId): PageDetail` — proposed contract change **C-1**: the page with each active image replaced by its best upscaled child (served by `GET /api/pages/:id/print`, Task 14)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/export-hires.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Image } from '@manga/shared';
import { createPage, pageDetail } from '../src/domain/pages.js';
import { bestUpscaled, planUpscales, printDetail } from '../src/export/hires.js';
import { seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedImage } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** A splash page (one panel ≈ 1914×2752 px at 300 dpi) whose panel shows an image of the given size. */
function splashWith(size: [number, number], scale = 1) {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  const detail = createPage(lib.store, chapter.id, 'splash');
  const panel = detail.panels[0]!;
  const image = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null, size);
  lib.store.panels.update(panel.id, { activeImageId: image.id, imageTransform: { x: 0, y: 0, scale } });
  return { manga, page: detail.page, panel, image };
}

function addUpscaled(parent: Image, width: number): Image {
  return lib.store.images.create({
    mangaId: parent.mangaId, ownerType: 'panel', ownerId: parent.ownerId, role: null, path: `mangas/${parent.mangaId}/images/up-${width}.png`,
    width, height: Math.round((parent.height * width) / parent.width), source: 'upscaled', parentImageId: parent.id, gen: null, review: null,
  });
}

describe('planUpscales', () => {
  it('asks for 4× when the image is far below print resolution', () => {
    const { manga, page, panel, image } = splashWith([512, 512]);
    expect(planUpscales(lib.store, pageDetail(lib.store, page.id), manga.pageFormat)).toEqual([{ panelId: panel.id, imageId: image.id, factor: 4 }]);
  });

  it('asks for 2× when doubling is enough, and 4× once the image is zoomed in', () => {
    const a = splashWith([1216, 1600]);
    expect(planUpscales(lib.store, pageDetail(lib.store, a.page.id), a.manga.pageFormat).map((p) => p.factor)).toEqual([2]);
    const b = splashWith([1216, 1600], 1.5);
    expect(planUpscales(lib.store, pageDetail(lib.store, b.page.id), b.manga.pageFormat).map((p) => p.factor)).toEqual([4]);
  });

  it('skips large images, upscaled images and images that already have an upscaled child', () => {
    const big = splashWith([4000, 6000]);
    expect(planUpscales(lib.store, pageDetail(lib.store, big.page.id), big.manga.pageFormat)).toEqual([]);
    const done = splashWith([512, 512]);
    addUpscaled(done.image, 2048);
    expect(planUpscales(lib.store, pageDetail(lib.store, done.page.id), done.manga.pageFormat)).toEqual([]);
    const up = addUpscaled(splashWith([512, 512]).image, 2048);
    const upPanel = lib.store.panels.require(up.ownerId);
    lib.store.panels.update(upPanel.id, { activeImageId: up.id });
    expect(planUpscales(lib.store, pageDetail(lib.store, upPanel.pageId), done.manga.pageFormat)).toEqual([]);
  });
});

describe('printDetail', () => {
  it('swaps each active image for its widest upscaled child and leaves the stored page alone', () => {
    const { page, panel, image } = splashWith([512, 512]);
    addUpscaled(image, 1024);
    const wide = addUpscaled(image, 2048);
    expect(bestUpscaled(lib.store, panel.id, image.id)?.id).toBe(wide.id);
    const print = printDetail(lib.store, page.id);
    expect(print.panels[0]!.activeImageId).toBe(wide.id);
    expect(print.images[wide.id]).toMatchObject({ width: 2048, source: 'upscaled' });
    expect(pageDetail(lib.store, page.id).panels[0]!.activeImageId).toBe(image.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/export-hires.test.ts`
Expected: FAIL — `Failed to load url ../src/export/hires.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/export/hires.ts
import { computeRects, type Image, type PageDetail, type PageFormat, type Panel } from '@manga/shared';
import { pageDetail } from '../domain/pages.js';
import type { Store } from '../store/index.js';
import { printPx } from './paths.js';

export interface UpscalePlan { panelId: string; imageId: string; factor: 2 | 4 }

export function bestUpscaled(store: Store, panelId: string, parentImageId: string): Image | null {
  return store.images.listByOwner('panel', panelId)
    .filter((i) => i.source === 'upscaled' && i.parentImageId === parentImageId)
    .sort((a, b) => b.width - a.width)[0] ?? null;
}

/** Spec §9.2: images printed under the format's dpi get one upscale, cached as an 'upscaled' child. */
export function planUpscales(store: Store, detail: PageDetail, format: PageFormat): UpscalePlan[] {
  const px = printPx(format);
  const rects = new Map(computeRects(detail.page.layout, format).map((r) => [r.panelId, r.rect]));
  const plans: UpscalePlan[] = [];
  for (const panel of detail.panels) {
    if (panel.activeImageId === null) continue;
    const image = detail.images[panel.activeImageId] ?? store.images.get(panel.activeImageId);
    const rect = rects.get(panel.id);
    if (!image || !rect || image.source === 'upscaled' || bestUpscaled(store, panel.id, image.id)) continue;
    // cover-fit: the image is scaled by max(rectW/imgW, rectH/imgH), then by the user's zoom
    const need = Math.max((rect.w * px.width) / image.width, (rect.h * px.height) / image.height) * panel.imageTransform.scale;
    if (need <= 1) continue;
    plans.push({ panelId: panel.id, imageId: image.id, factor: need <= 2 ? 2 : 4 });
  }
  return plans;
}

/** GET /api/pages/:id/print (proposed contract change C-1). */
export function printDetail(store: Store, pageId: string): PageDetail {
  const detail = pageDetail(store, pageId);
  const images = { ...detail.images };
  const panels = detail.panels.map((panel): Panel => {
    if (panel.activeImageId === null) return panel;
    const up = bestUpscaled(store, panel.id, panel.activeImageId);
    if (!up) return panel;
    images[up.id] = up;
    return { ...panel, activeImageId: up.id };
  });
  return { ...detail, panels, images };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/export-hires.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/export/hires.ts packages/server/test/export-hires.test.ts
git commit -m "feat(server): print-resolution upscale planning and the print page view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Server — export job, Chromium renderer, PDF merge, `POST /api/export`

**Files:**
- Create: `packages/server/src/export/pdf.ts`, `packages/server/src/export/browser.ts`, `packages/server/src/export/job.ts`, `packages/server/src/export/routes.ts`, `packages/server/src/export/module.ts`
- Modify: `packages/server/src/all-modules.ts` (append `exportModule`)
- Test: `packages/server/test/export-job.test.ts`

**Interfaces:**
- Consumes: `planExport`, `printPx`, `ExportItem` (Task 12); `planUpscales`, `printDetail` (Task 13); `QueueLike` (Task 8); `pageDetail`; `ExportSchema`, `ExportRenderPayload`, `ExportRenderResult`, `ImageUpscalePayload`, `JobRef`, `PageDetail` (`@manga/shared`); `playwright` (`chromium`, `errors`), `pdf-lib`.
- Produces:
  - `pdf.ts`: `mergePdfs(inputs: string[], outPath: string): Promise<string>`
  - `browser.ts`: `RENDER_TIMEOUT_MS = 60_000`; `interface RenderRequest { baseUrl; items: ExportItem[]; format; pageFormat; signal; onPage?(done, total); timeoutMs? }`; `type PageRenderer = (req) => Promise<string[]>`; `pdfScale(format): number`; `renderWithChromium: PageRenderer`
  - `job.ts`: `interface ExportJobDeps { baseUrl(): string; render?: PageRenderer; probeUi?(baseUrl): Promise<void> }`; `probeUi(baseUrl)`; `exportJobHandler(deps): JobHandler`
  - `routes.ts`: `registerExportRoutes(app, { store, queue })` — `POST /api/export` → `JobRef` (`export.render`, lane `cpu`, `maxAttempts: 1`), `GET /api/pages/:id/print` → `PageDetail`
  - `module.ts`: `exportModule(deps: CoreDeps, opts?: Omit<ExportJobDeps, 'baseUrl'>): AppModule`

Export job (spec §10, brief): plan files → upscale-on-demand (`image.upscale` on `gpu` for each `planUpscales` entry, once per image; a failed upscale only downgrades that image) → check the UI is built (`GET /render/page/probe` must answer HTML) → launch Chromium **once** per job → for each page open `http://127.0.0.1:<bound port>/render/page/<id>?hires=1` at the print pixel size (2150×3035), wait for `window.__MANGA_RENDER_READY__ === true` or M3's `window.__MANGA_RENDER_ERROR__` string (error → `PermanentError` at once; 60 s without either → `PermanentError` naming the page) → PNG via `page.screenshot({fullPage:false})`, or PDF via `page.pdf({ width:'182mm', height:'257mm', printBackground:true, pageRanges:'1' })` from the page format, scaled by `pdfScale` so the 2150-px layout fits 182 mm while text stays vector → for a chapter PDF, merge the page PDFs into `chapter.pdf` with pdf-lib. Result: `ExportRenderResult { files }` (chapter.pdf last).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/export-job.test.ts
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_PAGE_FORMAT, type ApiErrorBody, type Chapter, type ExportRenderResult, type Job, type JobRef, type Manga, type PageDetail } from '@manga/shared';
import { encodeSolidPng } from '../src/dev/png.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { pdfScale, type PageRenderer } from '../src/export/browser.js';
import { exportJobHandler, probeUi } from '../src/export/job.js';
import { mergePdfs } from '../src/export/pdf.js';
import { EventBus } from '../src/events/bus.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';
import { seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let server: M4TestServer | null = null;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(async () => {
  lib.close();
  await server?.close();
  server = null;
});

async function onePagePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([515.9, 728.5]);
  await writeFile(path, await doc.save());
}

/** Writes a real (tiny) file per item, like Chromium would. */
function stubRenderer(rendered: string[]): PageRenderer {
  return async (req) => {
    for (const item of req.items) {
      if (req.format === 'pdf') await onePagePdf(item.file);
      else await writeFile(item.file, encodeSolidPng(8, 8, [0, 0, 0]));
      rendered.push(item.pageId);
      req.onPage?.(rendered.length, req.items.length);
    }
    return req.items.map((i) => i.file);
  };
}

function exportContext(payload: unknown, queue = new FakeQueue(lib.store), progress: string[] = []) {
  const job = lib.store.jobs.insert({ kind: 'export.render', lane: 'cpu', payload, priority: 0, maxAttempts: 1, nextRunAt: new Date().toISOString(), episodeRunId: null });
  return fakeJobContext(lib.store, new EventBus(), queue, job, undefined, progress);
}

const noProbe = async (): Promise<void> => undefined;

describe('pdf helpers', () => {
  it('merges page PDFs in order', async () => {
    const a = join(lib.dir, 'a.pdf');
    const b = join(lib.dir, 'b.pdf');
    await onePagePdf(a);
    await onePagePdf(b);
    const out = await mergePdfs([a, b], join(lib.dir, 'all.pdf'));
    expect((await PDFDocument.load(await readFile(out))).getPageCount()).toBe(2);
  });

  it('scales the print-pixel layout onto the paper width', () => {
    expect(pdfScale(DEFAULT_PAGE_FORMAT)).toBeCloseTo(687.87 / 2150, 4);
  });
});

describe('exportJobHandler', () => {
  it('exports a chapter as page PDFs plus a merged chapter.pdf, cover first', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const rendered: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer(rendered), probeUi: noProbe });
    const result = (await handler(exportContext({ target: { type: 'chapter', id: chapter.id }, format: 'pdf' }))) as ExportRenderResult;
    const dir = join(lib.dir, 'exports', 'rain-town', '01-one');
    expect(result.files).toEqual(['cover.pdf', 'page-01.pdf', 'page-02.pdf', 'chapter.pdf'].map((f) => join(dir, f)));
    expect(rendered[0]).toBe(cover.page.id);
    expect((await PDFDocument.load(await readFile(join(dir, 'chapter.pdf')))).getPageCount()).toBe(3);
  });

  it('exports one page as PNG into outDir', async () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const page = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const out = join(lib.dir, 'custom-out');
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer([]), probeUi: noProbe });
    const result = (await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png', outDir: out }))) as ExportRenderResult;
    expect(result.files).toEqual([join(out, 'page-01.png')]);
    expect(existsSync(result.files[0]!)).toBe(true);
  });

  it('upscales low-resolution images before rendering', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const page = createPage(lib.store, chapter.id, 'splash');
    const panel = page.panels[0]!;
    const small = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null, [512, 512]);
    lib.store.panels.update(panel.id, { activeImageId: small.id });
    const queue = new FakeQueue(lib.store).on('image.upscale', (job) => {
      const p = job.payload as { imageId: string; factor: number };
      const up = lib.store.images.create({
        mangaId: manga.id, ownerType: 'panel', ownerId: panel.id, role: null, path: 'mangas/x/images/up.png',
        width: 512 * p.factor, height: 512 * p.factor, source: 'upscaled', parentImageId: p.imageId, gen: null, review: null,
      });
      return { imageId: up.id };
    });
    const progress: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer([]), probeUi: noProbe });
    await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png' }, queue, progress));
    expect(queue.jobs('image.upscale').map((j) => [j.lane, j.payload])).toEqual([['gpu', { imageId: small.id, factor: 4 }]]);
    expect(progress[0]).toBe('Upscaling 1 images for print');
  });

  it('refuses to export when the UI is not built', async () => {
    server = await startM4TestServer({ uiDir: null });
    await expect(probeUi(server.url)).rejects.toThrow('The UI is not built (packages/ui/dist is missing): run "npm run build" before exporting');
  });
});

describe('export routes', { timeout: 60_000 }, () => {
  it('POST /api/export validates, queues an export.render job on the cpu lane, and the job reports a missing UI', async () => {
    server = await startM4TestServer({ uiDir: null });
    const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Export' })).body;
    const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
    await server.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: TWO_PANEL_PRESET });
    expect((await server.api<ApiErrorBody>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'tiff' })).status).toBe(400);
    expect((await server.api<ApiErrorBody>('POST', '/api/export', { target: { type: 'chapter', id: 'ch_missing000' } })).status).toBe(404);
    const { body } = await server.api<JobRef>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id } });
    const job = await server.until(async () => {
      const j = (await server!.api<Job>('GET', `/api/jobs/${body.jobId}`)).body;
      return j.status === 'failed' || j.status === 'succeeded' ? j : null;
    });
    expect(job).toMatchObject({ kind: 'export.render', lane: 'cpu', status: 'failed' });
    expect(job.error).toContain('The UI is not built');
  });

  it('GET /api/pages/:id/print serves the print view', async () => {
    server = await startM4TestServer({ uiDir: null });
    const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Print' })).body;
    const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
    const page = (await server.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: 'splash' })).body;
    const store = server.deps.store;
    const panel = page.panels[0]!;
    const base = seedImage(store, manga.id, { type: 'panel', id: panel.id }, null, [512, 512]);
    store.panels.update(panel.id, { activeImageId: base.id });
    const up = store.images.create({
      mangaId: manga.id, ownerType: 'panel', ownerId: panel.id, role: null, path: base.path, width: 2048, height: 2048,
      source: 'upscaled', parentImageId: base.id, gen: null, review: null,
    });
    const print = (await server.api<PageDetail>('GET', `/api/pages/${page.page.id}/print`)).body;
    expect(print.panels[0]!.activeImageId).toBe(up.id);
    expect((await server.api<PageDetail>('GET', `/api/pages/${page.page.id}`)).body.panels[0]!.activeImageId).toBe(base.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/export-job.test.ts`
Expected: FAIL — `Failed to load url ../src/export/browser.js`.

- [ ] **Step 3: Write `pdf.ts` and `browser.ts`**

```ts
// packages/server/src/export/pdf.ts
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/** Spec §10: "A chapter PDF is the page PDFs merged with pdf-lib". */
export async function mergePdfs(inputs: string[], outPath: string): Promise<string> {
  const doc = await PDFDocument.create();
  for (const file of inputs) {
    const src = await PDFDocument.load(await readFile(file));
    for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
  }
  await writeFile(outPath, await doc.save());
  return outPath;
}
```

```ts
// packages/server/src/export/browser.ts
import { chromium, errors, type Browser } from 'playwright';
import type { PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import { printPx, type ExportItem } from './paths.js';

export const RENDER_TIMEOUT_MS = 60_000;

export interface RenderRequest {
  baseUrl: string; items: ExportItem[]; format: 'png' | 'pdf'; pageFormat: PageFormat; signal: AbortSignal;
  onPage?(done: number, total: number): void; timeoutMs?: number;
}
export type PageRenderer = (req: RenderRequest) => Promise<string[]>;

/** The print route lays the page out at print pixels (2150 px wide); page.pdf must shrink that onto 182 mm (= 687.9 CSS px). */
export function pdfScale(format: PageFormat): number {
  const cssWidth = (format.widthMm / 25.4) * 96;
  return Math.min(2, Math.max(0.1, cssWidth / printPx(format).width));
}

/** One Chromium per export job; one tab reused for every page. */
export const renderWithChromium: PageRenderer = async (req) => {
  const px = printPx(req.pageFormat);
  const timeout = req.timeoutMs ?? RENDER_TIMEOUT_MS;
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new PermanentError(`Could not start Chromium for export (run "npx playwright install chromium"): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const context = await browser.newContext({ viewport: { width: px.width, height: px.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const files: string[] = [];
    for (const [i, item] of req.items.entries()) {
      if (req.signal.aborted) throw new PermanentError('Export cancelled');
      req.onPage?.(i, req.items.length);
      await page.goto(`${req.baseUrl}/render/page/${item.pageId}?hires=1`, { waitUntil: 'load' });
      try {
        // M3's print route sets __MANGA_RENDER_READY__ when fonts and images are in, or __MANGA_RENDER_ERROR__ (a string) when loading failed.
        await page.waitForFunction('window.__MANGA_RENDER_READY__ === true || typeof window.__MANGA_RENDER_ERROR__ === "string"', undefined, { timeout });
      } catch (err) {
        if (err instanceof errors.TimeoutError) throw new PermanentError(`Export render timed out after ${Math.round(timeout / 1000)} s on page ${item.pageId}`);
        throw err;
      }
      const renderError = (await page.evaluate('window.__MANGA_RENDER_ERROR__ ?? null')) as string | null;
      if (renderError !== null) throw new PermanentError(`Export failed on page ${item.pageId}: ${renderError}`);
      if (req.format === 'png') {
        await page.screenshot({ path: item.file, fullPage: false, type: 'png' });
      } else {
        await page.emulateMedia({ media: 'screen' });
        await page.pdf({
          path: item.file, width: `${req.pageFormat.widthMm}mm`, height: `${req.pageFormat.heightMm}mm`, printBackground: true,
          pageRanges: '1', margin: { top: '0', right: '0', bottom: '0', left: '0' }, scale: pdfScale(req.pageFormat),
        });
      }
      files.push(item.file);
    }
    req.onPage?.(req.items.length, req.items.length);
    return files;
  } finally {
    await browser.close();
  }
};
```

- [ ] **Step 4: Write `job.ts`, `routes.ts` and `module.ts`**

```ts
// packages/server/src/export/job.ts
import { mkdir } from 'node:fs/promises';
import { ExportSchema, type ExportRenderPayload, type ExportRenderResult, type ImageUpscalePayload } from '@manga/shared';
import { pageDetail } from '../domain/pages.js';
import { PermanentError, type JobContext, type JobHandler } from '../jobs/index.js';
import { renderWithChromium, type PageRenderer } from './browser.js';
import { planUpscales, type UpscalePlan } from './hires.js';
import { planExport } from './paths.js';
import { mergePdfs } from './pdf.js';

export interface ExportJobDeps { baseUrl(): string; render?: PageRenderer; probeUi?(baseUrl: string): Promise<void> }

/** The print route is a UI route: without packages/ui/dist the server answers JSON 404 and Chromium would wait 60 s for nothing. */
export async function probeUi(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/render/page/probe`).catch(() => null);
  const type = res?.headers.get('content-type') ?? '';
  if (!res?.ok || !type.includes('text/html')) {
    throw new PermanentError('The UI is not built (packages/ui/dist is missing): run "npm run build" before exporting');
  }
}

async function ensureHires(ctx: JobContext, pageIds: string[]): Promise<void> {
  const seen = new Set<string>();
  const plans: UpscalePlan[] = [];
  for (const id of pageIds) {
    const detail = pageDetail(ctx.store, id);
    const format = ctx.store.mangas.require(detail.page.mangaId).pageFormat;
    for (const plan of planUpscales(ctx.store, detail, format)) {
      if (!seen.has(plan.imageId)) { seen.add(plan.imageId); plans.push(plan); }
    }
  }
  if (plans.length === 0) return;
  const label = `Upscaling ${plans.length} images for print`;
  ctx.progress(label, 0, plans.length);
  let done = 0;
  let failed = 0;
  await Promise.all(plans.map(async (p) => {
    const payload: ImageUpscalePayload = { imageId: p.imageId, factor: p.factor };
    const job = await ctx.queue.waitFor(ctx.queue.enqueue({ kind: 'image.upscale', lane: 'gpu', payload }).id);
    if (job.status !== 'succeeded') failed++;
    ctx.progress(label, ++done, plans.length);
  }));
  ctx.signal.throwIfAborted();
  if (failed > 0) ctx.progress(`${failed} upscales failed; those images export at their base resolution`);
}

export function exportJobHandler(deps: ExportJobDeps): JobHandler {
  return async (ctx): Promise<ExportRenderResult> => {
    const payload = ExportSchema.parse(ctx.job.payload) as ExportRenderPayload;
    const plan = planExport(ctx.store, payload);
    await ensureHires(ctx, plan.items.map((i) => i.pageId));
    const baseUrl = deps.baseUrl();
    await (deps.probeUi ?? probeUi)(baseUrl);
    await mkdir(plan.dir, { recursive: true });
    const files = await (deps.render ?? renderWithChromium)({
      baseUrl, items: plan.items, format: plan.format, pageFormat: plan.pageFormat, signal: ctx.signal,
      onPage: (i, n) => ctx.progress(`Rendering page ${Math.min(i + 1, n)}/${n}`, i, n),
    });
    if (plan.chapterPdf) {
      ctx.progress('Merging the chapter PDF');
      files.push(await mergePdfs(files, plan.chapterPdf));
    }
    return { files };
  };
}
```

```ts
// packages/server/src/export/routes.ts
import type { FastifyInstance } from 'fastify';
import { ExportSchema, type ExportRenderPayload, type JobRef, type PageDetail } from '@manga/shared';
import type { JobQueue } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import { printDetail } from './hires.js';

export function registerExportRoutes(app: FastifyInstance, deps: { store: Store; queue: JobQueue }): void {
  app.post('/api/export', async (req): Promise<JobRef> => {
    const body = ExportSchema.parse(req.body ?? {});
    if (body.target.type === 'page') deps.store.pages.require(body.target.id);
    else deps.store.chapters.require(body.target.id);
    const payload: ExportRenderPayload = { target: body.target, format: body.format, ...(body.outDir ? { outDir: body.outDir } : {}) };
    return { jobId: deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload, maxAttempts: 1 }).id };
  });

  app.get<{ Params: { id: string } }>('/api/pages/:id/print', async (req): Promise<PageDetail> => printDetail(deps.store, req.params.id));
}
```

```ts
// packages/server/src/export/module.ts
import type { FastifyInstance } from 'fastify';
import type { AppModule, CoreDeps } from '../app.js';
import { exportJobHandler, type ExportJobDeps } from './job.js';
import { registerExportRoutes } from './routes.js';

/** Contract C.5: M4's export module. Chromium talks to this very server, on the port it is actually bound to. */
export function exportModule(deps: CoreDeps, opts: Omit<ExportJobDeps, 'baseUrl'> = {}): AppModule {
  let app: FastifyInstance | null = null;
  const baseUrl = (): string => {
    const address = app?.server.address();
    const port = address && typeof address === 'object' ? address.port : deps.config.port;
    return `http://127.0.0.1:${port}`;
  };
  return {
    name: 'export',
    register(instance): void {
      app = instance;
      deps.queue.register('export.render', exportJobHandler({ ...opts, baseUrl }));
      registerExportRoutes(instance, { store: deps.store, queue: deps.queue });
    },
  };
}
```

In `packages/server/src/all-modules.ts` add the import and append the module:

```ts
import { exportModule } from './export/module.js';
```

```ts
  return [aiModule(deps, services), imagingModule(deps, services), episodeModule(deps, services), exportModule(deps)];
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/export-job.test.ts`
Expected: PASS — `Tests  8 passed (8)`.

Run: `npx vitest run packages/server`
Expected: all server test files pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/export packages/server/src/all-modules.ts packages/server/test/export-job.test.ts
git commit -m "feat(server): export.render job — upscale on demand, Chromium PNG/PDF, pdf-lib chapter merge, POST /api/export" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Server — real-browser export test

**Files:**
- Test: `packages/server/test/export-render.test.ts`

**Interfaces:**
- Consumes: `startM4TestServer({ uiDir })` (Task 10), the built UI (`packages/ui/dist`, M3 + Tasks 17–20), Playwright Chromium (Task 1).
- Produces: proof that the real renderer produces a 2150×3035 PNG and a 182×257 mm PDF from the M3 print route.

This test needs `npm run build` first (the server serves `packages/ui/dist`). It is skipped, with a visible reason, when the build is missing, so `npm test` stays green on a fresh clone; Task 21's E2E run always has the build.

- [ ] **Step 1: Write the test**

```ts
// packages/server/test/export-render.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { EMPTY_SCRIPT, type Chapter, type ExportRenderResult, type Job, type JobRef, type Manga, type PageDetail } from '@manga/shared';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

const UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const HAS_UI = existsSync(`${UI_DIR}/index.html`);

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function job(server: M4TestServer, id: string): Promise<Job> {
  return server.until(async () => {
    const j = (await server.api<Job>('GET', `/api/jobs/${id}`)).body;
    return ['succeeded', 'failed', 'cancelled'].includes(j.status) ? j : null;
  }, 150_000);
}

describe.skipIf(!HAS_UI)('export with real Chromium (needs `npm run build`)', { timeout: 180_000 }, () => {
  it('exports a page PNG at print size and a chapter PDF at 182×257 mm', async () => {
    s = await startM4TestServer({ uiDir: UI_DIR });
    const manga = (await s.api<Manga>('POST', '/api/mangas', { title: 'Export', language: 'uk' })).body;
    const chapter = (await s.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'Один' })).body;
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' })).body;
    const panel = page.panels[0]!;
    await s.api('PATCH', `/api/panels/${panel.id}`, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Привіт, світе!' }] } });
    const gen = (await s.api<JobRef>('POST', `/api/panels/${panel.id}/generate`, {})).body;
    expect((await job(s, gen.jobId)).status).toBe('succeeded');
    await s.api('POST', `/api/pages/${page.page.id}/auto-letter`);

    const png = await job(s, (await s.api<JobRef>('POST', '/api/export', { target: { type: 'page', id: page.page.id }, format: 'png' })).body.jobId);
    expect(png.status, png.error ?? '').toBe('succeeded');
    const [pngFile] = (png.result as ExportRenderResult).files;
    const bytes = readFileSync(pngFile!);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2150, 3035]);

    const pdf = await job(s, (await s.api<JobRef>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).body.jobId);
    expect(pdf.status, pdf.error ?? '').toBe('succeeded');
    const files = (pdf.result as ExportRenderResult).files;
    expect(files.at(-1)!.endsWith('chapter.pdf')).toBe(true);
    const doc = await PDFDocument.load(readFileSync(files.at(-1)!));
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo((182 / 25.4) * 72, 0);
    expect(height).toBeCloseTo((257 / 25.4) * 72, 0);
    const upscaled = (await s.api<unknown[]>('GET', `/api/panels/${panel.id}/images`)).body as Array<{ source: string }>;
    expect(upscaled.some((i) => i.source === 'upscaled')).toBe(true);
  });
});
```

- [ ] **Step 2: Build the UI and run it**

```bash
npm run build
npx vitest run packages/server/test/export-render.test.ts
```

Expected: PASS — `Tests  1 passed (1)`. If the M3 print route is not yet switched to `?hires=1` (Task 17) the test still passes (it only checks sizes and that an upscale happened). If it reports "timed out after 60 s on page …", open `http://127.0.0.1:<port>/render/page/<id>` from a dev server and check the browser console: the M3 route must set `window.__MANGA_RENDER_READY__` after fonts and images load.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/export-render.test.ts
git commit -m "test(server): real Chromium export of a page PNG and a chapter PDF" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: CLI — `episode`, `export` and `text auto`

**Files:**
- Create: `packages/cli/src/episode-format.ts`, `packages/cli/src/follow.ts`
- Create: `packages/cli/src/commands/episode.ts`, `packages/cli/src/commands/export.ts`, `packages/cli/src/commands/text-auto.ts`
- Modify: `packages/cli/src/program.ts` (three imports, three `register…` calls after M2's `registerAiCommands(program, ctx)`)
- Test: `packages/cli/test/episode-format.test.ts`, `packages/cli/test/episode-commands.test.ts`

**Interfaces:**
- Consumes: `CliContext` (`../context.js`: `api`, `json`, `wait`, `io`, `out`, `waitJobs`, `resolve`), `ApiClient`, `ApiError` (`../client.js`), `CliError` (`../errors.js`), `parseList` (`../args.js`), `table` (`../format.js`); the Task 10/14 routes; server test helper `startM4TestServer`.
- Produces:
  - `episode-format.ts`: `formatRun(run): string` (header + step table), `runLine(run): string`
  - `follow.ts`: `interface FollowOptions { intervalMs?; onChange?(run); signal?; sleep?(ms) }`, `followRun(api: Pick<ApiClient, 'get'>, chapterId, opts?): Promise<EpisodeRun>` — polls `GET /api/chapters/:id/episode` until `awaiting-review`, `done`, `failed` or `cancelled`
  - `registerEpisodeCommands(program, ctx)`: `episode start <chapter> --prompt .. [--pages 8] [--chars a,b] [--tone ..] [--autopilot]`, `episode status <chapter>`, `episode approve <chapter>`, `episode autopilot <chapter>` ("run to end"), `episode edit <chapter> <step> --file x.json`, `episode rerun <chapter> <step> [--confirm]`, `episode cancel <chapter>`; with the global `--wait`, start/approve/autopilot/rerun follow the run until it stops (progress lines on stderr unless `--json`)
  - `registerExportCommands(program, ctx)`: `export <chapter|page> [--format pdf|png] [--out <dir>]` — refs starting with `pg_` are pages, anything else goes through the chapter resolver; `--out` is resolved against the CLI's cwd; `--wait` waits for the job and prints the files
  - `registerTextAutoCommand(program, ctx)`: `text auto <page>` added to the existing `text` group (proposed C-6)
  - `exportTargetType(ref): 'page' | 'chapter'`

- [ ] **Step 1: Write the failing pure test**

```ts
// packages/cli/test/episode-format.test.ts
import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { exportTargetType } from '../src/commands/export.js';
import { formatRun, runLine } from '../src/episode-format.js';
import { followRun } from '../src/follow.js';

const T = '2026-09-27T10:11:12.000Z';
function run(status: EpisodeRun['status'], currentStep: number, stepStatus: EpisodeRun['steps'][number]['status'] = 'running'): EpisodeRun {
  return {
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode: 'review', currentStep, status,
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < currentStep ? 'done' : i === currentStep ? stepStatus : 'pending', output: null,
      error: i === currentStep && stepStatus === 'failed' ? 'model overloaded' : null, startedAt: i <= currentStep ? T : null, finishedAt: i < currentStep ? T : null,
    })),
    createdAt: T, updatedAt: T,
  };
}

describe('episode formatting', () => {
  it('prints a header and one row per step', () => {
    const text = formatRun(run('failed', 2, 'failed'));
    const lines = text.split('\n');
    expect(lines[0]).toBe('er_1  failed  review');
    expect(lines[1]).toMatch(/^#\s+step\s+status\s+started\s+finished\s+error$/);
    expect(lines[2]).toMatch(/^1\s+premise\s+done\s+10:11:12\s+10:11:12/);
    expect(lines[4]).toMatch(/^3\s+breakdown\s+failed <\s+10:11:12\s+-\s+model overloaded$/);
    expect(lines).toHaveLength(9);
  });

  it('summarises the current step in one line', () => {
    expect(runLine(run('awaiting-review', 1, 'awaiting-review'))).toBe('awaiting-review: outline awaiting-review');
  });

  it('classifies export targets', () => {
    expect(exportTargetType('pg_abc')).toBe('page');
    expect(exportTargetType('ch_abc')).toBe('chapter');
    expect(exportTargetType('My Manga/2')).toBe('chapter');
  });
});

describe('followRun', () => {
  it('polls until the run stops, reporting each change once', async () => {
    const sequence = [run('running', 0), run('running', 0), run('running', 1), run('awaiting-review', 1, 'awaiting-review')];
    const api = { get: async <T>(): Promise<T> => sequence.shift() as T };
    const seen: string[] = [];
    const sleeps: number[] = [];
    const final = await followRun(api, 'ch_1', { intervalMs: 5, onChange: (r) => seen.push(runLine(r)), sleep: async (ms) => { sleeps.push(ms); } });
    expect(final.status).toBe('awaiting-review');
    expect(seen).toEqual(['running: premise running', 'running: outline running', 'awaiting-review: outline awaiting-review']);
    expect(sleeps).toEqual([5, 5, 5]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/cli/test/episode-format.test.ts`
Expected: FAIL — `Failed to load url ../src/commands/export.js`.

- [ ] **Step 3: Write the formatting and follow helpers**

```ts
// packages/cli/src/episode-format.ts
import type { EpisodeRun } from '@manga/shared';
import { table } from './format.js';

const clock = (iso: string | null): string => (iso ? iso.slice(11, 19) : '-');

/** Header line (id, status, mode) and a step table; "<" marks the current step of an unfinished run. */
export function formatRun(run: EpisodeRun): string {
  const rows = run.steps.map((s, i) => [
    String(i + 1), s.name, `${s.status}${i === run.currentStep && run.status !== 'done' ? ' <' : ''}`,
    clock(s.startedAt), clock(s.finishedAt), s.error ?? '',
  ]);
  return `${run.id}  ${run.status}  ${run.mode}\n${table(rows, ['#', 'step', 'status', 'started', 'finished', 'error'])}`;
}

export function runLine(run: EpisodeRun): string {
  const step = run.steps[run.currentStep];
  return `${run.status}: ${step ? `${step.name} ${step.status}` : '-'}`;
}
```

```ts
// packages/cli/src/follow.ts
import type { EpisodeRun } from '@manga/shared';
import type { ApiClient } from './client.js';

const SETTLED: ReadonlySet<EpisodeRun['status']> = new Set(['awaiting-review', 'done', 'failed', 'cancelled']);

export interface FollowOptions {
  intervalMs?: number;
  onChange?(run: EpisodeRun): void;
  signal?: AbortSignal;
  sleep?(ms: number): Promise<void>;
}

/** `--wait` for episodes: poll the chapter's latest run until it waits for review or ends. */
export async function followRun(api: Pick<ApiClient, 'get'>, chapterId: string, opts: FollowOptions = {}): Promise<EpisodeRun> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = '';
  for (;;) {
    const run = await api.get<EpisodeRun | null>(`/api/chapters/${chapterId}/episode`);
    if (!run) throw new Error(`chapter ${chapterId} has no episode run`);
    const key = `${run.status}:${run.currentStep}:${run.steps[run.currentStep]?.status ?? ''}`;
    if (key !== last) {
      last = key;
      opts.onChange?.(run);
    }
    if (SETTLED.has(run.status) || opts.signal?.aborted) return run;
    await sleep(opts.intervalMs ?? 1000);
  }
}
```

- [ ] **Step 4: Write the commands**

```ts
// packages/cli/src/commands/episode.ts
import { readFile } from 'node:fs/promises';
import { InvalidArgumentError, type Command } from 'commander';
import { EPISODE_STEPS, EpisodeStepNameSchema, type EpisodeRun, type EpisodeStepName } from '@manga/shared';
import { parseList } from '../args.js';
import { ApiError } from '../client.js';
import type { CliContext } from '../context.js';
import { formatRun, runLine } from '../episode-format.js';
import { CliError } from '../errors.js';
import { followRun } from '../follow.js';

function parsePages(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 1 || n > 30) throw new InvalidArgumentError('expected a whole number from 1 to 30');
  return n;
}

function parseStep(value: string): EpisodeStepName {
  const parsed = EpisodeStepNameSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(`expected one of: ${EPISODE_STEPS.join(', ')}`);
  return parsed.data;
}

async function latestRun(c: CliContext, chapterId: string): Promise<EpisodeRun> {
  const run = await c.api.get<EpisodeRun | null>(`/api/chapters/${chapterId}/episode`);
  if (!run) throw new CliError(`chapter ${chapterId} has no episode run; start one with "manga episode start"`);
  return run;
}

/** Prints the run; with --wait, first follows it until it stops at a review point or ends. */
async function show(c: CliContext, chapterId: string, run: EpisodeRun): Promise<void> {
  const final = c.wait
    ? await followRun(c.api, chapterId, {
      onChange: (r) => { if (!c.json) c.io.stderr(`${runLine(r)}\n`); },
      ...(c.io.signal ? { signal: c.io.signal } : {}),
    })
    : run;
  c.out(final, () => formatRun(final));
}

export function registerEpisodeCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const episode = program.command('episode').description('Generate a chapter from one prompt, step by step (spec §8)');

  episode.command('start')
    .description('Start an episode run in an empty chapter')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .requiredOption('--prompt <text>', 'what happens in the chapter')
    .option('--pages <n>', 'number of pages, 1-30', parsePages, 8)
    .option('--chars <list>', 'characters to use: comma-separated names or ids', parseList)
    .option('--tone <text>', 'tone, e.g. "tense, melancholic"', '')
    .option('--autopilot', 'run every step without stopping at review points')
    .action(async (chapterRef: string, opts: { prompt: string; pages: number; chars?: string[]; tone: string; autopilot?: boolean }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const characterIds: string[] = [];
      for (const ref of opts.chars ?? []) characterIds.push((await c.resolve.character(ref, chapter.mangaId)).id);
      const run = await c.api.post<EpisodeRun>(`/api/chapters/${chapter.id}/episode`, {
        input: { prompt: opts.prompt, pages: opts.pages, characterIds, tone: opts.tone }, mode: opts.autopilot ? 'autopilot' : 'review',
      });
      await show(c, chapter.id, run);
    });

  episode.command('status')
    .description('Show the steps of the latest run')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .action(async (chapterRef: string) => {
      const c = await ctx();
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      c.out(run, () => formatRun(run));
    });

  for (const [name, description] of [['approve', 'Accept the step waiting for review and continue'], ['autopilot', 'Run to the end without stopping']] as const) {
    episode.command(name)
      .description(description)
      .argument('<chapter>', 'chapter id or <manga>/<number>')
      .action(async (chapterRef: string) => {
        const c = await ctx();
        const chapter = await c.resolve.chapter(chapterRef);
        const run = await latestRun(c, chapter.id);
        await show(c, chapter.id, await c.api.post<EpisodeRun>(`/api/episodes/${run.id}/${name}`));
      });
  }

  episode.command('edit')
    .description('Replace a step output with the JSON in a file')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .argument('<step>', EPISODE_STEPS.join('|'), parseStep)
    .requiredOption('--file <path>', 'JSON file holding the new output of the step')
    .action(async (chapterRef: string, step: EpisodeStepName, opts: { file: string }) => {
      const c = await ctx();
      let output: unknown;
      try {
        output = JSON.parse(await readFile(opts.file, 'utf8'));
      } catch (err) {
        throw new CliError(`cannot read ${opts.file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      const next = await c.api.put<EpisodeRun>(`/api/episodes/${run.id}/steps/${step}/output`, { output });
      c.out(next, () => formatRun(next));
    });

  episode.command('rerun')
    .description('Run a step again, and every step after it')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .argument('<step>', EPISODE_STEPS.join('|'), parseStep)
    .option('--confirm', "allow replacing the chapter's pages")
    .action(async (chapterRef: string, step: EpisodeStepName, opts: { confirm?: boolean }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const run = await latestRun(c, chapter.id);
      let next: EpisodeRun;
      try {
        next = await c.api.post<EpisodeRun>(`/api/episodes/${run.id}/steps/${step}/rerun`, { confirm: opts.confirm === true });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'needs_confirm') {
          const n = (err.details as { removedPanelIds?: string[] } | undefined)?.removedPanelIds?.length ?? 0;
          throw new CliError(`re-running ${step} replaces the chapter's pages (${n} panels); add --confirm`);
        }
        throw err;
      }
      await show(c, chapter.id, next);
    });

  episode.command('cancel')
    .description('Cancel the running episode and its jobs')
    .argument('<chapter>', 'chapter id or <manga>/<number>')
    .action(async (chapterRef: string) => {
      const c = await ctx();
      const run = await latestRun(c, (await c.resolve.chapter(chapterRef)).id);
      const next = await c.api.post<EpisodeRun>(`/api/episodes/${run.id}/cancel`);
      c.out(next, () => formatRun(next));
    });
}
```

```ts
// packages/cli/src/commands/export.ts
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
      const { jobId } = await c.api.post<JobRef>('/api/export', {
        target: { type, id }, format: opts.format, ...(opts.out ? { outDir: resolve(opts.out) } : {}),
      });
      if (!c.wait) {
        c.out({ jobId }, () => `export queued as ${jobId}; add --wait to wait for the files`);
        return;
      }
      const [job] = await c.waitJobs([jobId]);
      if (!job || job.status !== 'succeeded') throw new CliError(`export ${job?.status ?? 'failed'}: ${job?.error ?? 'unknown error'}`);
      const { files } = job.result as ExportRenderResult;
      c.out({ jobId, files }, () => files.join('\n'));
    });
}
```

```ts
// packages/cli/src/commands/text-auto.ts
import type { Command } from 'commander';
import type { PageDetail } from '@manga/shared';
import type { CliContext } from '../context.js';

/** Spec §12 `manga text auto <page>`: added to M1's `text` group (created when absent, e.g. in tests). */
export function registerTextAutoCommand(program: Command, ctx: () => Promise<CliContext>): void {
  const text = program.commands.find((cmd) => cmd.name() === 'text') ?? program.command('text').description('Text frames');
  text.command('auto')
    .description('Place text frames for every dialogue line of the page that has none yet')
    .argument('<page>', 'page id')
    .action(async (pageRef: string) => {
      const c = await ctx();
      const pageId = (await c.resolve.page(pageRef)).page.id;
      const detail = await c.api.post<PageDetail>(`/api/pages/${pageId}/auto-letter`);
      c.out(detail, () => `${detail.frames.length} frames on ${pageId}`);
    });
}
```

In `packages/cli/src/program.ts`, add the imports next to the others and register the groups right after `registerAiCommands(program, ctx);`:

```ts
import { registerEpisodeCommands } from './commands/episode.js';
import { registerExportCommands } from './commands/export.js';
import { registerTextAutoCommand } from './commands/text-auto.js';
```

```ts
  registerEpisodeCommands(program, ctx);
  registerExportCommands(program, ctx);
  registerTextAutoCommand(program, ctx);
```

- [ ] **Step 5: Run the pure test to verify it passes**

Run: `npx vitest run packages/cli/test/episode-format.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 6: Write the command test against a real server**

```ts
// packages/cli/test/episode-commands.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SCRIPT, type Chapter, type Character, type EpisodeRun, type Job, type Manga, type PageDetail } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { registerEpisodeCommands } from '../src/commands/episode.js';
import { registerExportCommands } from '../src/commands/export.js';
import { registerTextAutoCommand } from '../src/commands/text-auto.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/errors.js';
import { startM4TestServer, type M4TestServer } from '../../server/test/helpers/m4-server.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function testContext(baseUrl: string, outputs: unknown[], stderr: string[], wait: boolean): CliContext {
  const api = new ApiClient(baseUrl);
  return {
    api, json: false, wait, baseUrl,
    io: { stdout: () => undefined, stderr: (t) => { stderr.push(t); } },
    out: (data) => { outputs.push(data); },
    waitJobs: async (ids) => {
      const done: Job[] = [];
      for (const id of ids) {
        for (;;) {
          const job = await api.get<Job>(`/api/jobs/${id}`);
          if (TERMINAL.has(job.status)) { done.push(job); break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return done;
    },
    resolve: {
      manga: (ref) => api.get(`/api/mangas/${ref}`),
      character: async (ref, mangaRef) => {
        const list = await api.get<Character[]>(`/api/mangas/${mangaRef}/characters`);
        const hit = list.find((c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase());
        if (!hit) throw new Error(`no character ${ref}`);
        return hit;
      },
      chapter: (ref) => api.get(`/api/chapters/${ref}`),
      page: (id) => api.get(`/api/pages/${id}`),
      panel: (id) => api.get(`/api/panels/${id}`),
      frame: (id) => api.get(`/api/frames/${id}`),
    },
  };
}

let s: M4TestServer;
let outputs: unknown[];
let stderr: string[];
beforeEach(async () => {
  s = await startM4TestServer();
  outputs = [];
  stderr = [];
});
afterEach(async () => { await s.close(); });

function manga(wait = false): Command {
  const ctx = testContext(s.url, outputs, stderr, wait);
  const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride();
  root.command('text'); // M1's group
  registerEpisodeCommands(root, async () => ctx);
  registerExportCommands(root, async () => ctx);
  registerTextAutoCommand(root, async () => ctx);
  return root;
}
const run = (args: string[], wait = false) => manga(wait).parseAsync(args, { from: 'user' });
const last = <T>() => outputs.at(-1) as T;

async function world(): Promise<{ chapter: Chapter; aiko: Character }> {
  const m = (await s.api<Manga>('POST', '/api/mangas', { title: `CLI ${Date.now()}` })).body;
  const aiko = (await s.api<Character>('POST', `/api/mangas/${m.id}/characters`, { name: 'Aiko' })).body;
  const chapter = (await s.api<Chapter>('POST', `/api/mangas/${m.id}/chapters`, { title: 'One' })).body;
  return { chapter, aiko };
}

async function awaitingAt(chapterId: string, step: number): Promise<void> {
  await s.until(async () => {
    const r = (await s.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;
    return r?.status === 'awaiting-review' && r.currentStep === step;
  });
}

describe('manga episode …', { timeout: 90_000 }, () => {
  it('start --autopilot --wait follows the run to the end', async () => {
    const { chapter, aiko } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat in the rain', '--pages', '1', '--chars', 'aiko', '--autopilot'], true);
    const final = last<EpisodeRun>();
    expect(final.status).toBe('done');
    expect(final.input).toMatchObject({ pages: 1, characterIds: [aiko.id] });
    expect(stderr.at(-1)).toBe('done: lettering done\n');
  });

  it('start stops at review points; status prints; approve --wait continues to the next one', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat']);
    expect(last<EpisodeRun>().mode).toBe('review');
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'status', chapter.id]);
    expect(last<EpisodeRun>().currentStep).toBe(1);
    await run(['episode', 'approve', chapter.id], true);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
  });

  it('edit reads the output from a JSON file; rerun needs --confirm once pages exist', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '1']);
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'approve', chapter.id], true);
    const file = join(mkdtempSync(join(tmpdir(), 'manga-cli-')), 'premise.json');
    writeFileSync(file, JSON.stringify({ title: 'From a file', synopsis: 'S.', tone: 'calm', setting: 'Pier' }));
    await run(['episode', 'edit', chapter.id, 'premise', '--file', file]);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.title).toBe('From a file');
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow(CliError);
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow("re-running breakdown replaces the chapter's pages (2 panels); add --confirm");
    await run(['episode', 'rerun', chapter.id, 'breakdown', '--confirm'], true);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
  });

  it('cancel stops the run', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat']);
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'cancel', chapter.id]);
    expect(last<EpisodeRun>().status).toBe('cancelled');
  });

  it('rejects a bad step name and a bad page count as usage errors', async () => {
    const { chapter } = await world();
    await expect(run(['episode', 'rerun', chapter.id, 'colouring'])).rejects.toBeInstanceOf(CommanderError);
    await expect(run(['episode', 'start', chapter.id, '--prompt', 'x', '--pages', '0'])).rejects.toBeInstanceOf(CommanderError);
  });
});

describe('manga export / text auto', { timeout: 60_000 }, () => {
  it('export prints the job id, and with --wait reports why the job failed', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    await run(['export', chapter.id, '--format', 'png']);
    expect(last<{ jobId: string }>().jobId).toMatch(/^jb_/);
    await expect(run(['export', chapter.id], true)).rejects.toThrow('export failed: The UI is not built');
  });

  it('text auto letters a page', async () => {
    const { chapter } = await world();
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' })).body;
    await s.api('PATCH', `/api/panels/${page.panels[0]!.id}`, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Rain.' }] } });
    await run(['text', 'auto', page.page.id]);
    expect(last<PageDetail>().frames.map((f) => f.text)).toEqual(['Rain.']);
  });
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `npx vitest run packages/cli/test/episode-commands.test.ts`
Expected: PASS — `Tests  7 passed (7)`.

Run: `npx tsc --build packages/cli/tsconfig.json`
Expected: no output (exit 0).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/episode-format.ts packages/cli/src/follow.ts packages/cli/src/commands/episode.ts packages/cli/src/commands/export.ts packages/cli/src/commands/text-auto.ts packages/cli/src/program.ts packages/cli/test/episode-format.test.ts packages/cli/test/episode-commands.test.ts
git commit -m "feat(cli): manga episode start|status|approve|autopilot|edit|rerun|cancel, manga export, manga text auto" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: UI — the print route uses print-resolution images

**Files:**
- Create: `packages/ui/src/render/printDetail.ts`
- Modify: `packages/ui/src/render/RenderPage.tsx` (M3 Task 12: one import line and the `usePageDetail(pageId)` line)
- Test: `packages/ui/test/print-detail.test.ts`

**Interfaces:**
- Consumes: `api` (`../api`), `qk` (`../queryKeys`), `GET /api/pages/:id/print` (Task 14).
- Produces: `printDetailPath(pageId, hires): string`, `printDetailKey(pageId, hires): readonly unknown[]`, `usePrintDetail(pageId: string | undefined, hires: boolean)` — proposed contract change **C-1**: `/render/page/:pageId?hires=1` renders the upscaled children the exporter prepared. The hires key extends `qk.page(id)`, so M3's `page` entity events still invalidate it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/test/print-detail.test.ts
import { describe, expect, it } from 'vitest';
import { printDetailKey, printDetailPath } from '../src/render/printDetail';

describe('print detail', () => {
  it('uses the print view only with ?hires=1', () => {
    expect(printDetailPath('pg_1', true)).toBe('/api/pages/pg_1/print');
    expect(printDetailPath('pg_1', false)).toBe('/api/pages/pg_1');
  });

  it('keeps the normal page key, and nests the hires key under it', () => {
    expect(printDetailKey('pg_1', false)).toEqual(['page', 'pg_1']);
    expect(printDetailKey('pg_1', true)).toEqual(['page', 'pg_1', 'print']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/ui/test/print-detail.test.ts`
Expected: FAIL — `Failed to resolve import "../src/render/printDetail"`.

- [ ] **Step 3: Write the hook and switch the print route to it**

```ts
// packages/ui/src/render/printDetail.ts
import { useQuery } from '@tanstack/react-query';
import type { PageDetail } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';

/** Contract change C-1: the exporter opens /render/page/:id?hires=1, which reads the print view with upscaled images. */
export function printDetailPath(pageId: string, hires: boolean): string {
  return hires ? `/api/pages/${pageId}/print` : `/api/pages/${pageId}`;
}

export function printDetailKey(pageId: string, hires: boolean): readonly unknown[] {
  return hires ? [...qk.page(pageId), 'print'] : qk.page(pageId);
}

export const usePrintDetail = (pageId: string | undefined, hires: boolean) =>
  useQuery({
    queryKey: printDetailKey(pageId ?? '', hires),
    queryFn: () => api.get<PageDetail>(printDetailPath(pageId ?? '', hires)),
    enabled: !!pageId,
  });
```

In `packages/ui/src/render/RenderPage.tsx` replace

```tsx
  const detail = usePageDetail(pageId);
```

with

```tsx
  const detail = usePrintDetail(pageId, search.get('hires') === '1');
```

and the queries import line `import { useManga, usePageDetail } from '../queries';` with:

```tsx
import { useManga } from '../queries';
import { usePrintDetail } from './printDetail';
```

(`search` is already declared above `detail` in M3's component.)

- [ ] **Step 4: Run the test and the type check**

Run: `npx vitest run packages/ui/test/print-detail.test.ts`
Expected: PASS — `Tests  2 passed (2)`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/render/printDetail.ts packages/ui/src/render/RenderPage.tsx packages/ui/test/print-detail.test.ts
git commit -m "feat(ui): print route reads upscaled images with ?hires=1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: UI — `EpisodePanel` stepper

**Files:**
- Create: `packages/ui/src/episode/episodeView.ts`, `packages/ui/src/episode/JsonForm.tsx`, `packages/ui/src/episode/episode.css`
- Replace: `packages/ui/src/chapter/EpisodePanel.tsx` (M3's `null` stub; same name and props)
- Modify: `packages/ui/src/ui/icons.ts` (add icons)
- Test: `packages/ui/test/episode-view.test.ts`

**Interfaces:**
- Consumes: `api`, `ApiError` (`../api`); `qk.episode` (`../queryKeys`; M3 invalidates `['episode']` on every `episodeRun` event, so no polling is needed); `IconButton`, `StatusLoader`, `errorText` (`../ui/*`); `cx` (`../lib/cx`); `EPISODE_STEPS`, `EDITABLE_STEPS` (`@manga/shared`).
- Produces:
  - `episodeView.ts`: `STEP_LABEL`, `isLive(run)`, `currentStepName(run)`, `runLabel(run)`, `interface StepActions { approve; autopilot; cancel; rerun; edit }`, `stepActions(run, selected)`, `rerunLabel(run, selected)`, `parseDraft(text): { ok: true; value } | { ok: false; error }`
  - `JsonForm({ value, onChange, readOnly, label? })` — edits any step output as nested fields (strings, numbers, booleans, lists, objects)
  - `EpisodePanel({ chapterId }): JSX.Element | null` (M3 slot signature) — `null` until the chapter has a run; then a collapsible stepper: status loader / chip, the seven steps as tabs with status icons, and for the selected step its output as an editable form (or raw JSON), with icon buttons Continue, Run to end, Cancel episode, Re-run/Retry, Edit as JSON, Save changes
- DOM hooks for E2E: `[data-testid="episode-panel"]`, `[data-testid="episode-status"]` (text = `runLabel`), `[data-testid="episode-step-error"]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/test/episode-view.test.ts
import { describe, expect, it } from 'vitest';
import { EPISODE_STEPS, type EpisodeRun } from '@manga/shared';
import { currentStepName, isLive, parseDraft, rerunLabel, runLabel, stepActions } from '../src/episode/episodeView';

type StepStatus = EpisodeRun['steps'][number]['status'];
function run(status: EpisodeRun['status'], currentStep: number, current: StepStatus, mode: EpisodeRun['mode'] = 'review'): EpisodeRun {
  return {
    id: 'er_1', chapterId: 'ch_1', input: { prompt: 'p', characterIds: [], pages: 1, tone: '' }, mode, currentStep, status,
    steps: EPISODE_STEPS.map((name, i) => ({
      name, status: i < currentStep ? 'done' : i === currentStep ? current : 'pending',
      output: i <= currentStep ? { any: 'thing' } : null, error: null, startedAt: null, finishedAt: null,
    })),
    createdAt: '', updatedAt: '',
  };
}

describe('episode view', () => {
  it('labels the run by what it is doing', () => {
    expect(runLabel(run('running', 3, 'running'))).toBe('Writing the scripts');
    expect(runLabel(run('awaiting-review', 1, 'awaiting-review'))).toBe('Review: outline');
    expect(runLabel(run('failed', 5, 'failed'))).toBe('Failed at images');
    expect(runLabel(run('done', 6, 'done'))).toBe('Chapter ready');
    expect(runLabel(run('cancelled', 0, 'failed'))).toBe('Cancelled');
    expect(currentStepName(run('running', 4, 'running'))).toBe('prompts');
    expect(isLive(run('awaiting-review', 1, 'awaiting-review'))).toBe(true);
    expect(isLive(run('done', 6, 'done'))).toBe(false);
  });

  it('enables actions for a run waiting at a review point', () => {
    const r = run('awaiting-review', 3, 'awaiting-review');
    expect(stepActions(r, 'scripts')).toEqual({ approve: true, autopilot: true, cancel: true, rerun: true, edit: true });
    expect(stepActions(r, 'premise')).toMatchObject({ rerun: true, edit: true });
    expect(stepActions(r, 'prompts')).toMatchObject({ rerun: false, edit: false });
  });

  it('never edits informational steps and hides run-to-end in autopilot', () => {
    const r = run('running', 6, 'running', 'autopilot');
    expect(stepActions(r, 'render')).toEqual({ approve: false, autopilot: false, cancel: true, rerun: true, edit: false });
    expect(stepActions(r, 'lettering')).toMatchObject({ edit: false });
    expect(stepActions(run('done', 6, 'done'), 'premise')).toMatchObject({ cancel: false, approve: false, edit: true });
  });

  it('calls a re-run of the failed current step a retry', () => {
    expect(rerunLabel(run('failed', 5, 'failed'), 'render')).toBe('Retry this step');
    expect(rerunLabel(run('failed', 5, 'failed'), 'outline')).toBe('Re-run from here (later steps run again)');
  });

  it('parses raw JSON edits', () => {
    expect(parseDraft('{"title":"x"}')).toEqual({ ok: true, value: { title: 'x' } });
    expect(parseDraft('{oops')).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/ui/test/episode-view.test.ts`
Expected: FAIL — `Failed to resolve import "../src/episode/episodeView"`.

- [ ] **Step 3: Write `episodeView.ts`**

```ts
// packages/ui/src/episode/episodeView.ts
import { EDITABLE_STEPS, EPISODE_STEPS, type EpisodeRun, type EpisodeStepName } from '@manga/shared';

export const STEP_LABEL: Record<EpisodeStepName, string> = {
  premise: 'Premise', outline: 'Outline', breakdown: 'Pages', scripts: 'Scripts', prompts: 'Prompts', render: 'Images', lettering: 'Lettering',
};

const WORKING: Record<EpisodeStepName, string> = {
  premise: 'Writing the premise', outline: 'Writing the outline', breakdown: 'Planning the pages', scripts: 'Writing the scripts',
  prompts: 'Writing image prompts', render: 'Rendering images', lettering: 'Lettering',
};

export function isLive(run: EpisodeRun): boolean {
  return run.status === 'running' || run.status === 'awaiting-review';
}

export function currentStepName(run: EpisodeRun): EpisodeStepName {
  return EPISODE_STEPS[run.currentStep] ?? 'lettering';
}

export function runLabel(run: EpisodeRun): string {
  const step = currentStepName(run);
  switch (run.status) {
    case 'running': return WORKING[step];
    case 'awaiting-review': return `Review: ${STEP_LABEL[step].toLowerCase()}`;
    case 'failed': return `Failed at ${STEP_LABEL[step].toLowerCase()}`;
    case 'done': return 'Chapter ready';
    case 'cancelled': return 'Cancelled';
  }
}

export interface StepActions { approve: boolean; autopilot: boolean; cancel: boolean; rerun: boolean; edit: boolean }

/** Mirrors the server's rules (Task 9) so buttons are only enabled when the call can succeed. */
export function stepActions(run: EpisodeRun, selected: EpisodeStepName): StepActions {
  const idx = EPISODE_STEPS.indexOf(selected);
  const step = run.steps[idx];
  const live = isLive(run);
  return {
    approve: run.status === 'awaiting-review',
    autopilot: live && run.mode === 'review',
    cancel: live,
    rerun: step !== undefined && idx <= run.currentStep && step.status !== 'pending',
    edit: step !== undefined && EDITABLE_STEPS.has(selected) && (step.status === 'done' || step.status === 'awaiting-review'),
  };
}

export function rerunLabel(run: EpisodeRun, selected: EpisodeStepName): string {
  const idx = EPISODE_STEPS.indexOf(selected);
  return idx === run.currentStep && run.steps[idx]?.status === 'failed' ? 'Retry this step' : 'Re-run from here (later steps run again)';
}

export function parseDraft(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ui/test/episode-view.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

- [ ] **Step 5: Add the icons**

In `packages/ui/src/ui/icons.ts`, add these names to the `export { … } from 'lucide-react'` list (alphabetical order, skipping any already present): `Braces`, `ChevronRight`, `Circle`, `CirclePause`, `Copy`, `FastForward`, `File as FileIcon`, `FileImage`, `Files`, `FileText`, `MessageSquareText`, `Play`, `Save`, `Square`.

- [ ] **Step 6: Write `JsonForm.tsx`, the panel and its styles**

```tsx
// packages/ui/src/episode/JsonForm.tsx
import type { ReactElement } from 'react';

export interface JsonFormProps { value: unknown; onChange(value: unknown): void; readOnly: boolean; label?: string }

/** Edits any step output in place: strings, numbers and booleans become inputs; lists and objects nest. Shape changes go through "Edit as JSON". */
export function JsonForm({ value, onChange, readOnly, label = 'output' }: JsonFormProps): ReactElement {
  if (typeof value === 'string') {
    const long = value.length > 48 || value.includes('\n');
    return long
      ? <textarea className="textarea jf-text" aria-label={label} value={value} readOnly={readOnly} rows={Math.min(6, Math.ceil(value.length / 48) + 1)} onChange={(e) => onChange(e.target.value)} />
      : <input className="input" aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />;
  }
  if (typeof value === 'number') {
    return <input className="input jf-num" type="number" aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  }
  if (typeof value === 'boolean') {
    return <input type="checkbox" aria-label={label} checked={value} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (value === null || value === undefined) return <span className="muted" aria-label={label}>—</span>;
  if (Array.isArray(value)) {
    return (
      <ol className="jf-list" aria-label={label}>
        {value.map((item, i) => (
          <li key={i}>
            <JsonForm value={item} label={`${label} ${i + 1}`} readOnly={readOnly} onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))} />
          </li>
        ))}
      </ol>
    );
  }
  const obj = value as Record<string, unknown>;
  return (
    <div className="jf-obj">
      {Object.entries(obj).map(([key, v]) => (
        <div key={key} className="jf-field">
          <span className="jf-key">{key}</span>
          <JsonForm value={v} label={key} readOnly={readOnly} onChange={(next) => onChange({ ...obj, [key]: next })} />
        </div>
      ))}
    </div>
  );
}
```

```tsx
// packages/ui/src/chapter/EpisodePanel.tsx
import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EpisodeRun, EpisodeStepName } from '@manga/shared';
import { api, ApiError } from '../api';
import { JsonForm } from '../episode/JsonForm';
import { STEP_LABEL, currentStepName, parseDraft, rerunLabel, runLabel, stepActions } from '../episode/episodeView';
import '../episode/episode.css';
import { cx } from '../lib/cx';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import {
  Braces, ChevronDown, ChevronRight, Circle, CircleCheck, CirclePause, CircleX, FastForward, LoaderCircle, Play, RotateCcw, Save, Square,
} from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { errorText } from '../ui/toasts';

const STATUS_ICON = { pending: Circle, running: LoaderCircle, 'awaiting-review': CirclePause, done: CircleCheck, failed: CircleX } as const;

/** M4 slot (Contract E): the episode stepper. Renders nothing until the chapter has a run. */
export function EpisodePanel({ chapterId }: { chapterId: string }): JSX.Element | null {
  const qc = useQueryClient();
  const { data: run } = useQuery({
    queryKey: qk.episode(chapterId),
    queryFn: () => api.get<EpisodeRun | null>(`/api/chapters/${chapterId}/episode`),
  });
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<EpisodeStepName | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [raw, setRaw] = useState<string | null>(null); // non-null: raw JSON mode
  const [error, setError] = useState<string | null>(null);

  const selected = picked ?? (run ? currentStepName(run) : 'premise');
  const step = run?.steps.find((s) => s.name === selected);
  const stepKey = `${run?.id ?? ''}:${selected}:${step?.status ?? ''}:${step?.finishedAt ?? ''}`;
  // Reset the form only when the step itself changes, not on every refetch of the run.
  useEffect(() => {
    setDraft(step?.output ?? null);
    setRaw(null);
    setError(null);
  }, [stepKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useMutation({
    mutationFn: (call: () => Promise<EpisodeRun>) => call(),
    onSuccess: (next) => { qc.setQueryData(qk.episode(chapterId), next); setError(null); },
    onError: (err) => setError(errorText(err)),
  });

  if (!run) return null;
  const actions = stepActions(run, selected);
  const post = (path: string) => (): Promise<EpisodeRun> => api.post<EpisodeRun>(`/api/episodes/${run.id}${path}`);
  const rerun = async (): Promise<EpisodeRun> => {
    const url = `/api/episodes/${run.id}/steps/${selected}/rerun`;
    try {
      return await api.post<EpisodeRun>(url, { confirm: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'needs_confirm'
        && window.confirm('This replaces the pages of the chapter, including edits made in the editor. Continue?')) {
        return api.post<EpisodeRun>(url, { confirm: true });
      }
      throw err;
    }
  };
  const save = async (): Promise<EpisodeRun> => {
    let output = draft;
    if (raw !== null) {
      const parsed = parseDraft(raw);
      if (!parsed.ok) throw new Error(`Invalid JSON: ${parsed.error}`);
      output = parsed.value;
    }
    return api.put<EpisodeRun>(`/api/episodes/${run.id}/steps/${selected}/output`, { output });
  };

  return (
    <section className="episode" data-testid="episode-panel" aria-label="Episode">
      <header className="episode__head">
        <IconButton icon={open ? ChevronDown : ChevronRight} size="sm" label={open ? 'Collapse episode' : 'Expand episode'} onClick={() => setOpen((o) => !o)} />
        {run.status === 'running'
          ? <span data-testid="episode-status" className="episode__status"><StatusLoader label={runLabel(run)} /></span>
          : <span data-testid="episode-status" className={cx('status-chip', 'episode__status', `episode__status--${run.status}`)}>{runLabel(run)}</span>}
        <span className="spacer" />
        <IconButton icon={Play} size="sm" tone="primary" label="Continue" disabled={!actions.approve} busy={act.isPending} onClick={() => act.mutate(post('/approve'))} />
        <IconButton icon={FastForward} size="sm" label="Run to end" disabled={!actions.autopilot} onClick={() => act.mutate(post('/autopilot'))} />
        <IconButton icon={Square} size="sm" tone="danger" label="Cancel episode" disabled={!actions.cancel} onClick={() => act.mutate(post('/cancel'))} />
      </header>
      {open && (
        <>
          <ol className="episode__steps" role="tablist" aria-label="Episode steps">
            {run.steps.map((s) => {
              const Icon = STATUS_ICON[s.status];
              return (
                <li key={s.name}>
                  <button
                    type="button" role="tab" aria-selected={s.name === selected} aria-label={`${STEP_LABEL[s.name]}: ${s.status}`}
                    data-tip={`${STEP_LABEL[s.name]}: ${s.status}`} className={cx('episode__step', `episode__step--${s.status}`, s.name === selected && 'is-on')}
                    onClick={() => setPicked(s.name)}
                  >
                    <Icon size={14} className={s.status === 'running' ? 'spin' : undefined} aria-hidden />
                    <span>{STEP_LABEL[s.name]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="episode__body" role="tabpanel" aria-label={STEP_LABEL[selected]}>
            <div className="row">
              <IconButton icon={RotateCcw} size="sm" label={rerunLabel(run, selected)} disabled={!actions.rerun} onClick={() => act.mutate(rerun)} />
              <IconButton icon={Braces} size="sm" label={raw === null ? 'Edit as JSON' : 'Edit as form'} active={raw !== null} disabled={!actions.edit}
                onClick={() => setRaw(raw === null ? JSON.stringify(draft, null, 2) : null)} />
              <IconButton icon={Save} size="sm" tone="primary" label="Save changes" disabled={!actions.edit} onClick={() => act.mutate(save)} />
            </div>
            {step?.error && <p className="error-text episode__error" data-testid="episode-step-error">{step.error}</p>}
            {error && <p className="error-text">{error}</p>}
            {step?.output == null
              ? <p className="muted">{step?.status === 'running' ? 'Working…' : 'No output yet'}</p>
              : raw !== null
                ? <textarea className="textarea episode__json" aria-label="Step output as JSON" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
                : <JsonForm value={draft} onChange={setDraft} readOnly={!actions.edit} label={STEP_LABEL[selected]} />}
          </div>
        </>
      )}
    </section>
  );
}
```

```css
/* packages/ui/src/episode/episode.css */
.episode { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2); border-bottom: 1px solid var(--border-1); background: var(--surface); }
.episode__head { display: flex; align-items: center; gap: var(--sp-1); min-height: var(--control-h); }
.episode__status--done { background: color-mix(in oklab, var(--ok) 16%, transparent); color: var(--ok); }
.episode__status--failed, .episode__status--cancelled { background: var(--danger-wash); color: var(--danger); }
.episode__status--awaiting-review { background: var(--accent-wash); color: var(--accent); }
.episode__steps { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.episode__step { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 var(--sp-2); border: 1px solid var(--border-1); border-radius: var(--r-full); background: transparent; color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; }
.episode__step:hover { background: var(--hover-wash); }
.episode__step.is-on { border-color: var(--accent); color: var(--text-1); }
.episode__step--done svg { color: var(--ok); }
.episode__step--failed svg { color: var(--danger); }
.episode__step--awaiting-review svg, .episode__step--running svg { color: var(--accent); }
.episode__body { display: flex; flex-direction: column; gap: var(--sp-2); max-height: 42vh; overflow: auto; }
.episode__json { min-height: 220px; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); }
.episode__error { max-height: 160px; overflow: auto; white-space: pre-wrap; font-size: var(--fs-xs); }
.jf-obj { display: flex; flex-direction: column; gap: var(--sp-1); }
.jf-field { display: grid; grid-template-columns: 96px 1fr; gap: var(--sp-2); align-items: start; }
.jf-key { padding-top: 5px; color: var(--text-3); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.jf-list { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding-left: var(--sp-4); }
.jf-list > li { padding-left: var(--sp-1); border-left: 1px solid var(--border-1); }
.jf-num { max-width: 88px; }
.jf-text { resize: vertical; }
```

- [ ] **Step 7: Type-check and try it**

Run: `npm run typecheck`
Expected: exit 0. (If `tsc` says an icon is not exported by `lucide-react`, fix only `src/ui/icons.ts`, as M3 Task 4 describes.)

Run `npm run dev`, create a chapter in a manga with fakes (`MANGA_FAKES=1`), then run `manga episode start <manga>/1 --prompt "A cat" --pages 1` from another shell: the chapter screen shows the stepper, stops at "Review: outline", the outline form is editable, "Continue" moves on and the page list fills in at "Review: scripts".

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/episode packages/ui/src/chapter/EpisodePanel.tsx packages/ui/src/ui/icons.ts packages/ui/test/episode-view.test.ts
git commit -m "feat(ui): EpisodePanel stepper with editable step outputs, continue, run to end, re-run and cancel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: UI — `CreateChapterAiSection`

**Files:**
- Create: `packages/ui/src/chapter/aiSection.ts`
- Replace: `packages/ui/src/chapter/CreateChapterAiSection.tsx` (M3's `null` stub; same name, same exported `CreateChapterAiSectionProps`)
- Modify: `packages/ui/src/episode/episode.css` (append the section styles)
- Test: `packages/ui/test/ai-section.test.ts`

**Interfaces:**
- Consumes: M3's slot contract — `CreateChapterAiSection(props: { mangaId: string; onChange(start: ((chapterId: string) => Promise<void>) | null): void })`; `CreateChapterModal` awaits `start(chapter.id)` after creating the chapter and before navigating (no change to the modal). `useCharacters` (`../queries`), `api`, `Field`, `IconButton`, icons.
- Produces:
  - `aiSection.ts`: `interface AiChapterInput { open; prompt; pages; tone; characterIds; autopilot }`, `EMPTY_AI_INPUT`, `clampPages(n)`, `toggleId(ids, id)`, `toStartEpisode(v): z.input<typeof StartEpisodeSchema> | null`
  - the section: a "Generate with AI" toggle; when open, fields "Episode prompt", "Pages", "Tone", a character toggle group "Characters" and an autopilot toggle button (label starts with "Autopilot"). It calls `onChange(start)` whenever the input changes: `start` POSTs `/api/chapters/:id/episode`; `null` when closed or the prompt is empty.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/test/ai-section.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_AI_INPUT, clampPages, toStartEpisode, toggleId } from '../src/chapter/aiSection';

describe('AI section model', () => {
  it('starts nothing while closed or without a prompt', () => {
    expect(toStartEpisode(EMPTY_AI_INPUT)).toBeNull();
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: '   ' })).toBeNull();
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: false, prompt: 'A cat' })).toBeNull();
  });

  it('builds the StartEpisode body', () => {
    expect(toStartEpisode({ open: true, prompt: '  A cat in the rain ', pages: 3, tone: ' gentle ', characterIds: ['cr_a'], autopilot: true })).toEqual({
      input: { prompt: 'A cat in the rain', pages: 3, tone: 'gentle', characterIds: ['cr_a'] }, mode: 'autopilot',
    });
    expect(toStartEpisode({ ...EMPTY_AI_INPUT, open: true, prompt: 'x' })?.mode).toBe('review');
  });

  it('keeps pages within 1..30 and toggles characters', () => {
    expect([clampPages(0), clampPages(31), clampPages(Number.NaN), clampPages(4.6)]).toEqual([1, 30, 8, 5]);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/ui/test/ai-section.test.ts`
Expected: FAIL — `Failed to resolve import "../src/chapter/aiSection"`.

- [ ] **Step 3: Write the model and the section**

```ts
// packages/ui/src/chapter/aiSection.ts
import type { z } from 'zod';
import type { StartEpisodeSchema } from '@manga/shared';

export type StartEpisodeBody = z.input<typeof StartEpisodeSchema>;

export interface AiChapterInput { open: boolean; prompt: string; pages: number; tone: string; characterIds: string[]; autopilot: boolean }

export const EMPTY_AI_INPUT: AiChapterInput = { open: false, prompt: '', pages: 8, tone: '', characterIds: [], autopilot: false };

/** EpisodeInputSchema allows 1..30 pages; an unreadable number falls back to the default 8. */
export function clampPages(n: number): number {
  if (!Number.isFinite(n)) return 8;
  return Math.min(30, Math.max(1, Math.round(n)));
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export function toStartEpisode(v: AiChapterInput): StartEpisodeBody | null {
  const prompt = v.prompt.trim();
  if (!v.open || prompt === '') return null;
  return {
    input: { prompt, pages: clampPages(v.pages), tone: v.tone.trim(), characterIds: v.characterIds },
    mode: v.autopilot ? 'autopilot' : 'review',
  };
}
```

```tsx
// packages/ui/src/chapter/CreateChapterAiSection.tsx
import { useEffect, useState, type JSX } from 'react';
import type { EpisodeRun } from '@manga/shared';
import { api } from '../api';
import '../episode/episode.css';
import { useCharacters } from '../queries';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { ChevronDown, ChevronRight, FastForward, Sparkles } from '../ui/icons';
import { EMPTY_AI_INPUT, clampPages, toStartEpisode, toggleId, type AiChapterInput } from './aiSection';

export interface CreateChapterAiSectionProps {
  mangaId: string;
  /** Register the function that starts an episode for the new chapter, or null to create a plain chapter. */
  onChange(start: ((chapterId: string) => Promise<void>) | null): void;
}

/** M4 slot (Contract E): the collapsible "Generate with AI" section of CreateChapterModal (spec §11). */
export function CreateChapterAiSection({ mangaId, onChange }: CreateChapterAiSectionProps): JSX.Element {
  const characters = useCharacters(mangaId);
  const [value, setValue] = useState<AiChapterInput>(EMPTY_AI_INPUT);
  const set = (patch: Partial<AiChapterInput>): void => setValue((v) => ({ ...v, ...patch }));

  useEffect(() => {
    const body = toStartEpisode(value);
    onChange(body ? async (chapterId) => { await api.post<EpisodeRun>(`/api/chapters/${chapterId}/episode`, body); } : null);
  }, [value, onChange]);

  return (
    <div className="ai-section">
      <button type="button" className="ai-section__toggle" aria-expanded={value.open} onClick={() => set({ open: !value.open })}>
        <Sparkles size={14} aria-hidden />
        <span>Generate with AI</span>
        {value.open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      </button>
      {value.open && (
        <div className="stack ai-section__body">
          <Field label="Episode prompt">
            <textarea className="textarea" rows={3} value={value.prompt} placeholder="What happens in this chapter?" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <div className="row">
            <Field label="Pages" inline>
              <input className="input ai-section__pages" type="number" min={1} max={30} value={value.pages} onChange={(e) => set({ pages: clampPages(Number(e.target.value)) })} />
            </Field>
            <Field label="Tone" inline>
              <input className="input" value={value.tone} placeholder="optional" onChange={(e) => set({ tone: e.target.value })} />
            </Field>
            <span className="spacer" />
            <IconButton
              icon={FastForward} size="sm" active={value.autopilot}
              label={value.autopilot ? 'Autopilot: on, runs every step without stopping' : 'Autopilot: off, stops at each review point'}
              onClick={() => set({ autopilot: !value.autopilot })}
            />
          </div>
          {(characters.data?.length ?? 0) > 0 && (
            <div className="ai-section__chars" role="group" aria-label="Characters">
              {characters.data!.map((c) => (
                <button key={c.id} type="button" className="chip" aria-pressed={value.characterIds.includes(c.id)}
                  onClick={() => set({ characterIds: toggleId(value.characterIds, c.id) })}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Append to `packages/ui/src/episode/episode.css`:

```css
.ai-section { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--border-1); }
.ai-section__toggle { display: inline-flex; align-items: center; gap: var(--sp-1); align-self: flex-start; padding: 2px var(--sp-1); border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.ai-section__toggle:hover { color: var(--text-1); }
.ai-section__pages { width: 64px; }
.ai-section__chars { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.chip { height: 24px; padding: 0 var(--sp-2); border: 1px solid var(--border-2); border-radius: var(--r-full); background: transparent; color: var(--text-2); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.chip[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-wash); color: var(--text-1); }
```

- [ ] **Step 4: Run the test and the type check**

Run: `npx vitest run packages/ui/test/ai-section.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/chapter/aiSection.ts packages/ui/src/chapter/CreateChapterAiSection.tsx packages/ui/src/episode/episode.css packages/ui/test/ai-section.test.ts
git commit -m "feat(ui): Generate-with-AI section of the create chapter modal starts an episode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: UI — export popover and auto-letter button

**Files:**
- Create: `packages/ui/src/editor/exportView.ts`, `packages/ui/src/editor/AutoLetterButton.tsx`
- Replace: `packages/ui/src/editor/ExportButton.tsx` (M3's disabled stub; keeps the `target` prop, adds an optional `pageId`)
- Modify: `packages/ui/src/editor/EditorToolbar.tsx` (M3 Task 18: pass `pageId` to `ExportButton`; add `AutoLetterButton` after the add-frame buttons)
- Modify: `packages/ui/src/episode/episode.css` (append the export styles)
- Test: `packages/ui/test/export-view.test.ts`

**Interfaces:**
- Consumes: M3's `ExportButton({ target: { type: 'page' | 'chapter'; id: string } | null })` slot (chapter mode passes the chapter, cover mode the cover page); `EditorToolbarProps.detail` (current `PageDetail | null`); `api`, `useJobs`, `waitForJob`, `TERMINAL` (`../jobs/jobView`), `Popover`, `Segmented`, `IconButton`, `StatusLoader`, `errorText`, `qk.page`.
- Produces:
  - `exportView.ts`: `type ExportScope = 'page' | 'chapter'`, `interface ExportChoice { scope; format: 'pdf' | 'png' }`, `defaultScope(target)`, `exportRequest(choice, target, pageId): { target; format } | null`, `exportFiles(job): string[]`, `fileName(path)`
  - `ExportButton({ target, pageId? })` — icon button "Export" opening a popover: Format (PDF/PNG), Scope (Current page / Whole chapter), "Start export"; shows the job's live status, the error, or the written files (`[data-testid="export-file"]`, full path in `data-path` and the tooltip, plus "Copy path")
  - `AutoLetterButton({ pageId })` — icon button "Auto-letter page" → `POST /api/pages/:id/auto-letter`, then refreshes `qk.page(pageId)`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/test/export-view.test.ts
import { describe, expect, it } from 'vitest';
import type { Job } from '@manga/shared';
import { defaultScope, exportFiles, exportRequest, fileName } from '../src/editor/exportView';

const chapter = { type: 'chapter' as const, id: 'ch_1' };
const cover = { type: 'page' as const, id: 'pg_cover' };

describe('export view', () => {
  it('defaults to the whole chapter in the chapter editor and to the page in the cover editor', () => {
    expect(defaultScope(chapter)).toBe('chapter');
    expect(defaultScope(cover)).toBe('page');
    expect(defaultScope(null)).toBe('page');
  });

  it('builds the POST /api/export body for the chosen scope', () => {
    expect(exportRequest({ scope: 'chapter', format: 'pdf' }, chapter, 'pg_3')).toEqual({ target: chapter, format: 'pdf' });
    expect(exportRequest({ scope: 'page', format: 'png' }, chapter, 'pg_3')).toEqual({ target: { type: 'page', id: 'pg_3' }, format: 'png' });
    expect(exportRequest({ scope: 'page', format: 'pdf' }, cover, null)).toEqual({ target: cover, format: 'pdf' });
    expect(exportRequest({ scope: 'page', format: 'pdf' }, chapter, null)).toBeNull();
    expect(exportRequest({ scope: 'chapter', format: 'pdf' }, cover, 'pg_cover')).toBeNull();
  });

  it('lists the files of a finished export', () => {
    const job = { status: 'succeeded', result: { files: ['C:\\lib\\exports\\a\\01-x\\page-01.pdf', '/tmp/x/chapter.pdf'] } } as unknown as Job;
    expect(exportFiles(job)).toEqual(['C:\\lib\\exports\\a\\01-x\\page-01.pdf', '/tmp/x/chapter.pdf']);
    expect(exportFiles({ ...job, status: 'failed' })).toEqual([]);
    expect(exportFiles(undefined)).toEqual([]);
    expect(exportFiles(job).map(fileName)).toEqual(['page-01.pdf', 'chapter.pdf']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/ui/test/export-view.test.ts`
Expected: FAIL — `Failed to resolve import "../src/editor/exportView"`.

- [ ] **Step 3: Write the model, the two buttons and the toolbar change**

```ts
// packages/ui/src/editor/exportView.ts
import type { ExportRenderResult, Job } from '@manga/shared';

export type ExportScope = 'page' | 'chapter';
export interface ExportChoice { scope: ExportScope; format: 'pdf' | 'png' }
export type ExportTarget = { type: 'page' | 'chapter'; id: string } | null;

export function defaultScope(target: ExportTarget): ExportScope {
  return target?.type === 'chapter' ? 'chapter' : 'page';
}

/** Body of POST /api/export, or null when the chosen scope has nothing to export. */
export function exportRequest(choice: ExportChoice, target: ExportTarget, pageId: string | null): { target: { type: ExportScope; id: string }; format: 'pdf' | 'png' } | null {
  if (choice.scope === 'chapter') return target?.type === 'chapter' ? { target, format: choice.format } : null;
  const id = pageId ?? (target?.type === 'page' ? target.id : null);
  return id ? { target: { type: 'page', id }, format: choice.format } : null;
}

export function exportFiles(job: Job | undefined | null): string[] {
  if (!job || job.status !== 'succeeded') return [];
  return (job.result as ExportRenderResult | null)?.files ?? [];
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
```

```tsx
// packages/ui/src/editor/ExportButton.tsx
import { useRef, useState, type JSX } from 'react';
import type { Job, JobRef } from '@manga/shared';
import { api } from '../api';
import '../episode/episode.css';
import { waitForJob } from '../events';
import { useJobs } from '../queries';
import { IconButton } from '../ui/IconButton';
import { Copy, Download, FileIcon, FileImage, Files, FileText, Play } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { Segmented } from '../ui/Segmented';
import { StatusLoader } from '../ui/StatusLoader';
import { errorText } from '../ui/toasts';
import { defaultScope, exportFiles, exportRequest, fileName, type ExportChoice, type ExportTarget } from './exportView';

/** M4 slot (Contract E): PNG/PDF export of the current page or the whole chapter (spec §10). */
export function ExportButton({ target, pageId = null }: { target: ExportTarget; pageId?: string | null }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ExportChoice>({ scope: defaultScope(target), format: 'pdf' });
  const [jobId, setJobId] = useState<string | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobs = useJobs();
  const live = jobs.data?.find((j) => j.id === jobId);
  const request = exportRequest(choice, target, pageId);
  const running = jobId !== null && finished === null;

  const start = async (): Promise<void> => {
    if (!request) return;
    setError(null);
    setFinished(null);
    try {
      const { jobId: id } = await api.post<JobRef>('/api/export', request);
      setJobId(id);
      setFinished(await waitForJob(id));
    } catch (err) {
      setError(errorText(err));
      setJobId(null);
    }
  };

  return (
    <>
      <IconButton ref={anchor} icon={Download} label="Export" active={open} disabled={target === null && pageId === null} onClick={() => setOpen((o) => !o)} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Export" align="end" className="export-pop">
        <div className="stack">
          <Segmented label="Format" value={choice.format} onChange={(format) => setChoice({ ...choice, format })}
            options={[{ value: 'pdf', label: 'PDF', icon: FileText }, { value: 'png', label: 'PNG', icon: FileImage }]} />
          <Segmented label="Scope" value={choice.scope} onChange={(scope) => setChoice({ ...choice, scope })}
            options={[
              { value: 'page', label: 'Current page', icon: FileIcon },
              ...(target?.type === 'chapter' ? [{ value: 'chapter' as const, label: 'Whole chapter', icon: Files }] : []),
            ]} />
          <div className="row">
            <IconButton icon={Play} tone="primary" label="Start export" disabled={request === null} busy={running} onClick={() => void start()} />
          </div>
          {running && <StatusLoader label={live?.progress?.label ?? 'Waiting for the export queue'} value={live?.progress?.value} max={live?.progress?.max} />}
          {finished?.status === 'failed' && <p className="error-text">{finished.error}</p>}
          {error && <p className="error-text">{error}</p>}
          {exportFiles(finished).map((file) => (
            <div key={file} className="row export-file" data-testid="export-file" data-path={file}>
              <span className="export-file__name" data-tip={file}>{fileName(file)}</span>
              <IconButton icon={Copy} size="sm" label="Copy path" onClick={() => void navigator.clipboard.writeText(file)} />
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
```

```tsx
// packages/ui/src/editor/AutoLetterButton.tsx
import { useState, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PageDetail } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { MessageSquareText } from '../ui/icons';
import { errorText, pushToast } from '../ui/toasts';

/** Spec §9.3 "auto-letter" button: frames for every dialogue line of the page that has none yet. */
export function AutoLetterButton({ pageId }: { pageId: string | null }): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    if (!pageId) return;
    setBusy(true);
    try {
      const detail = await api.post<PageDetail>(`/api/pages/${pageId}/auto-letter`);
      qc.setQueryData(qk.page(pageId), detail);
    } catch (err) {
      pushToast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return <IconButton icon={MessageSquareText} label="Auto-letter page" disabled={pageId === null} busy={busy} onClick={() => void run()} />;
}
```

In `packages/ui/src/editor/EditorToolbar.tsx` (M3 Task 18):

1. Add the import next to `import { ExportButton } from './ExportButton';`:

```tsx
import { AutoLetterButton } from './AutoLetterButton';
```

2. Right after the `{kinds.map((k) => ( … ))}` block of add-frame buttons, add:

```tsx
      <AutoLetterButton pageId={p.detail?.page.id ?? null} />
```

3. Replace `<ExportButton target={p.exportTarget} />` with:

```tsx
      <ExportButton target={p.exportTarget} pageId={p.detail?.page.id ?? null} />
```

Append to `packages/ui/src/episode/episode.css`:

```css
.export-pop { width: 280px; padding: var(--sp-3); }
.export-file { justify-content: space-between; font-size: var(--fs-sm); }
.export-file__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Run the test and the type check**

Run: `npx vitest run packages/ui/test/export-view.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Try it**

With `npm run dev` and the UI built at least once (`npm run build`, the exporter needs `packages/ui/dist`): open a chapter, click "Export", choose PDF + Whole chapter, click "Start export": the status line walks through "Rendering page n/N" and "Merging the chapter PDF", then the file names appear; "Auto-letter page" adds bubbles to a page whose panels have dialogue.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/editor/exportView.ts packages/ui/src/editor/ExportButton.tsx packages/ui/src/editor/AutoLetterButton.tsx packages/ui/src/editor/EditorToolbar.tsx packages/ui/src/episode/episode.css packages/ui/test/export-view.test.ts
git commit -m "feat(ui): export popover (PNG/PDF, page/chapter) and auto-letter button in the editor toolbar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: E2E — autopilot chapter from the UI, then PDF export from the toolbar

**Files:**
- Create: `e2e/episode-export.spec.ts`

**Interfaces:**
- Consumes: M3's `playwright.config.ts` (built server with `MANGA_FAKES=1` on :4399, `MANGA_E2E_LIBRARY`, one worker) and `e2e/helpers.ts` (`collectErrors`); M3 labels "New chapter", "Title", "Create chapter", "Page N"; the M4 labels and hooks from Tasks 18–20 ("Generate with AI", "Episode prompt", "Pages", group "Characters", "Autopilot…", `episode-panel`, `episode-status`, "Export", radios "PDF" / "Whole chapter", "Start export", `export-file` with `data-path`).
- Produces: spec §14 E2E #4 ("export PDF") and #5 ("an episode run in autopilot with a fake engine").

- [ ] **Step 1: Write the spec**

```ts
// e2e/episode-export.spec.ts
import { existsSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

test('a chapter generated in autopilot from the create modal exports as one PDF', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page, { ignoreResourceErrors: true });
  const manga = (await (await request.post('/api/mangas', { data: { title: `E2E Episode ${Date.now()}` } })).json()) as { id: string };
  await request.post(`/api/mangas/${manga.id}/characters`, { data: { name: 'Aiko', appearanceTags: '1girl, short black hair' } });

  // Create the chapter with the AI section in autopilot
  await page.goto(`/m/${manga.id}`);
  await page.getByRole('button', { name: 'New chapter' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Rain');
  await page.getByRole('button', { name: 'Generate with AI' }).click();
  await page.getByLabel('Episode prompt').fill('Aiko finds a lost cat in the rain');
  await page.getByLabel('Pages', { exact: true }).fill('2');
  await page.getByRole('group', { name: 'Characters' }).getByRole('button', { name: 'Aiko' }).click();
  await page.getByRole('button', { name: /^Autopilot/ }).click();
  await page.getByRole('button', { name: 'Create chapter' }).click();
  await expect(page).toHaveURL(/\/c\/ch_[a-z2-7]+/);

  // The stepper follows the run to the end; the page list fills in
  await expect(page.getByTestId('episode-panel')).toBeVisible();
  await expect(page.getByTestId('episode-status')).toHaveText('Chapter ready', { timeout: 200_000 });
  await expect(page.getByLabel('Page 2', { exact: true })).toBeVisible();

  // Export the whole chapter as PDF from the toolbar
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('radio', { name: 'PDF' }).click();
  await page.getByRole('radio', { name: 'Whole chapter' }).click();
  await page.getByRole('button', { name: 'Start export' }).click();
  const files = page.getByTestId('export-file');
  await expect(files.last()).toBeVisible({ timeout: 120_000 });
  const paths = await files.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['path'] ?? ''));
  const chapterPdf = paths.find((p) => p.endsWith('chapter.pdf'));
  expect(chapterPdf, paths.join('\n')).toBeDefined();
  expect(existsSync(chapterPdf!)).toBe(true);
  expect(statSync(chapterPdf!).size).toBeGreaterThan(1_000);
  expect(paths.filter((p) => /page-\d\d\.pdf$/.test(p))).toHaveLength(2);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run the E2E suite**

Run: `npm run e2e`
Expected: M3's specs and `episode-export.spec.ts` pass (`3 passed` or more; the count includes M3's specs). The root `e2e` script builds everything first, so the built server contains M4. If a label lookup fails, open the trace (`npx playwright show-trace test-results/**/trace.zip`) and compare with the labels listed under **Interfaces** — change the component, not the test, when an M4 label differs.

- [ ] **Step 3: Commit**

```bash
git add e2e/episode-export.spec.ts
git commit -m "test(e2e): autopilot chapter from the create modal, exported as PDF from the toolbar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: Live smoke test and contract update

**Files:**
- Create: `scripts/smoke.mjs`
- Modify: `package.json` (root: add the `smoke` script)

**Interfaces:**
- Consumes: the built server (`packages/server/dist/main.js`) and UI (`packages/ui/dist`), the real `claude` CLI (logged in), the real ComfyUI in `claude-image-gen` (auto-started by M2's launcher), the REST API.
- Produces: `npm run smoke` (spec §14 "Live smoke", manual, not part of `npm test`): one manga, one character with a picked portrait, a 1-page chapter generated in autopilot, exported as chapter PNGs and a chapter PDF; the script prints the file paths.

- [ ] **Step 1: Write the smoke script**

```js
// scripts/smoke.mjs
// Live smoke test (spec §14): real Claude + real ComfyUI. Manual; not part of `npm test`.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverMain = join(root, 'packages', 'server', 'dist', 'main.js');
if (!existsSync(serverMain) || !existsSync(join(root, 'packages', 'ui', 'dist', 'index.html'))) {
  console.error('Build first: npm run build');
  process.exit(2);
}

const library = process.env.SMOKE_LIBRARY ?? mkdtempSync(join(tmpdir(), 'manga-smoke-'));
const port = Number(process.env.SMOKE_PORT ?? 4398);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, MANGA_LIBRARY: library, MANGA_PORT: String(port) };
delete env.MANGA_FAKES;
const server = spawn(process.execPath, [serverMain], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const res = await fetch(base + path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try { await api('GET', '/api/health'); return; } catch { await sleep(500); }
  }
  throw new Error('the server did not start within 60 s');
}

async function waitJob(id, label) {
  let last = '';
  for (;;) {
    const job = await api('GET', `/api/jobs/${id}`);
    const now = job.progress?.label ?? job.status;
    if (now !== last) { console.log(`[${label}] ${now}`); last = now; }
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await sleep(2000);
  }
}

async function main() {
  await waitHealth();
  console.log('status:', JSON.stringify(await api('GET', '/api/status')));
  const manga = await api('POST', '/api/mangas', { title: 'Smoke Test', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset: 'manga-bw' });
  const aiko = await api('POST', `/api/mangas/${manga.id}/characters`, {
    name: 'Aiko', role: 'main', personality: 'curious, brave', speechStyle: 'casual, short sentences',
    appearanceTags: '1girl, short black hair, bob cut, brown eyes, school uniform, sailor collar',
  });
  const { jobIds } = await api('POST', `/api/characters/${aiko.id}/portraits`, { n: 1 });
  const portrait = await waitJob(jobIds[0], 'portrait');
  if (portrait.status !== 'succeeded') throw new Error(`portrait failed: ${portrait.error}`);
  await api('POST', `/api/characters/${aiko.id}/refs/portrait`, { imageId: portrait.result.imageId });

  const chapter = await api('POST', `/api/mangas/${manga.id}/chapters`, { title: 'Smoke' });
  await api('POST', `/api/chapters/${chapter.id}/episode`, {
    input: { prompt: 'Aiko finds a stray kitten on a rainy evening and decides to take it home. Tell it on one page in exactly two panels.', characterIds: [aiko.id], pages: 1, tone: 'gentle' },
    mode: 'autopilot',
  });
  const t0 = Date.now();
  let lastKey = '';
  for (;;) {
    const run = await api('GET', `/api/chapters/${chapter.id}/episode`);
    const step = run.steps[run.currentStep];
    const key = `${run.status} ${step?.name} ${step?.status}`;
    if (key !== lastKey) { console.log(`[episode ${Math.round((Date.now() - t0) / 1000)} s] ${key}`); lastKey = key; }
    if (run.status === 'failed') throw new Error(`episode failed at ${step?.name}: ${step?.error}`);
    if (run.status === 'cancelled') throw new Error('episode was cancelled');
    if (run.status === 'done') break;
    if (Date.now() - t0 > 45 * 60_000) throw new Error('episode did not finish within 45 minutes');
    await sleep(3000);
  }

  const png = await waitJob((await api('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'png' })).jobId, 'export png');
  const pdf = await waitJob((await api('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).jobId, 'export pdf');
  for (const job of [png, pdf]) if (job.status !== 'succeeded') throw new Error(`export failed: ${job.error}`);

  console.log('\nSMOKE OK');
  console.log('library:', library);
  for (const file of [...png.result.files, ...pdf.result.files]) console.log('file:', file);
}

main().then(
  () => { server.kill(); process.exit(0); },
  (err) => { console.error('SMOKE FAILED:', err.message); console.error('library:', library); server.kill(); process.exit(1); },
);
```

- [ ] **Step 2: Add the root script**

In the root `package.json` `scripts`, add (M3 already added `e2e`):

```json
    "smoke": "node scripts/smoke.mjs"
```

- [ ] **Step 3: Run the smoke test**

Prerequisites: `claude` is logged in (run `claude` once if not), the models from P1 are in `claude-image-gen/models`, and nothing else is using the GPU.

```bash
npm run build
npm run smoke
```

Expected: progress lines (`[portrait] …`, `[episode 12 s] running premise running`, … `[episode … s] done lettering done`, `[export png] Rendering page 2/2`, …), then `SMOKE OK`, the library path, and `file:` lines for `cover.png`, `page-01.png`, `cover.pdf`, `page-01.pdf` and `chapter.pdf`. It takes several minutes (Claude for five steps, ComfyUI for portraits, panels, the cover, reviews and upscales).

- [ ] **Step 4: Look at the result**

Open the two exported PNGs with the Read tool (the `file:` lines ending in `cover.png` and `page-01.png`) and judge them against the spec:
- every panel shows art that matches its script (Aiko, a kitten, rain, evening), in black-and-white manga style;
- no letters, captions or fake speech bubbles inside the generated images (spec §1 core rule);
- speech bubbles are inside their panels, start on the right (RTL), do not cover faces badly, tails point toward the speaker, the text is readable English and fits its bubble;
- the cover shows Aiko with the chapter title as an overlay frame, not painted into the image;
- the page is 2150×3035 (the Read tool shows the size).

Write the verdict (pass, or the list of problems with the file and panel) in the task report. A visual problem is a bug in the owning task (prompts: Task 4; placement: Task 3; render/review: Task 8; export: Task 14): fix it there, re-run that task's tests, then re-run the smoke test.

- [ ] **Step 5: Run everything once more**

```bash
npm run typecheck
npm test
npm run e2e
```

Expected: all three exit 0 (`npm test` includes `export-render.test.ts` now that `packages/ui/dist` exists).

- [ ] **Step 6: Confirm the contract already records M4's changes**

The C-1…C-7 notes at the top of this plan were copied into `docs/superpowers/plans/2026-09-27-00-contracts.md` during planning. Confirm, and change nothing if all are present:

```bash
grep -n "api/pages/:id/print\|409 \`conflict\` if the chapter\|M4 episode job lanes\|text auto\|hires=1\|AutoLetterButton\|defaultModules\|\`episode\` and \`letter\`" docs/superpowers/plans/2026-09-27-00-contracts.md
```

Expected: matches for all eight patterns. If one is missing, add it in the wording of the C-notes at the top of this plan.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke.mjs package.json
git commit -m "chore: live smoke test (real Claude + ComfyUI)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage (M4)

| Spec | Where |
|---|---|
| §8 steps, outputs, review points, "written to the chapter", outline → characters + portraits, breakdown preset validation, scripts materialization, render with cover + estimate, lettering → ready | Tasks 2, 4, 6, 8, 9 |
| §8 review rounds and retry strategy by issue | Task 8 (`retryPatch`, `runRenderStep`) |
| §8 review mode vs autopilot, first portrait canonical in autopilot | Tasks 8, 9 |
| §8 edit and re-run (confirm after materialization), resumability, failed step with retry | Tasks 9, 10, 18 |
| §9.3 auto-placement + "auto-letter" button | Tasks 3, 7, 10, 20 |
| §9.2 print upscale at export | Tasks 13, 14, 17 |
| §10 export PNG/PDF, chapter merge, output location, `--out` | Tasks 12, 14, 15 |
| §11 Create Chapter "Generate with AI", episode stepper | Tasks 18, 19 |
| §12 `episode …`, `export …`, `text auto` | Task 16 |
| §13 invalid AI output after correction, restart mid-run, export timeout with page id | Tasks 2/4 (refined schemas), 9 (resume), 14 (timeout, render error) |
| §14 unit (episode machine, auto-letter), integration, E2E #4/#5, live smoke | Tasks 2–16, 21, 22 |
