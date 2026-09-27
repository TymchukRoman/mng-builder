# M2 — AI Engines and Imaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate character portraits, character sheets and panel images from the `manga` CLI against the real ComfyUI and the real `claude` CLI, with AI-written panel prompts, appearance tags and image review — and test all of it with fakes.

**Architecture:** Two app modules plug into M1's server. `aiModule` owns the text engines (`claude -p` stream-json child process and native ollama `/api/chat`), the structured-output layer (extract → zod → one correction round) and the `llm.step` dispatcher. `imagingModule` owns the ComfyUI HTTP+WebSocket client, the detached launcher, one TypeScript graph builder per recipe, the routing function and `generateImage` (the only code that creates generated Image rows). Job handlers glue store rows to recipes; routes only validate and enqueue. `MANGA_FAKES=1` swaps in an in-process FakeComfy and scripted engines.

**Tech Stack:** TypeScript 5.9 ESM, Node 25.2.1, Fastify 5, zod 4 (`z.toJSONSchema`), `ws` 8, better-sqlite3 (via M1's store), vitest 3.2.4, commander 14.

**Spec:** `docs/superpowers/specs/2026-09-27-manga-builder-design.md` (§3.2, §6, §7, §13, §14). **Binding contracts:** `docs/superpowers/plans/2026-09-27-00-contracts.md` (this plan is milestone M2; it consumes Contract A, C.1–C.5 and D from M1 and creates C.6, C.7, the `llm.step` dispatcher, the M2 rows of Contract B and the M2 CLI commands).

## Global Constraints

Copied verbatim from the contracts file ("Global constraints (all milestones)"):

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

M2-specific constraints (from the spec and the brief):

- Machine: Windows 11, shell commands in this plan are Git Bash. Node 25.2.1. `claude --version` is **2.1.281** (`C:\Users\roman\.local\bin\claude.exe`, a native exe → `spawn(..., { shell: false })` works).
- Every child process is spawned with `windowsHide: true` (`HIDDEN` / `HIDDEN_DETACHED` from `src/util/hidden.ts`).
- The `claude` child never gets `ANTHROPIC_*` variables (subscription auth) and never `--bare`.
- Tests live next to their package: `packages/server/test/**`, `packages/cli/test/**`. Test helpers live in `packages/server/test/helpers/`, fakes in `packages/server/test/fakes/`.
- Every commit uses `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (two `-m` flags produce the required blank line).

## Review Focus

The five uncovered inputs most likely to bite a real user; each now has a pinning test in the owning task:

1. **Server started from inside a Claude Code session** (env has `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_CODE_*`): the `claude -p` child must not inherit them, or it silently uses the host's session instead of the subscription login. → Task 6, test "never passes ANTHROPIC_* or host-session variables to the child".
2. **Ukrainian (Cyrillic) text in panel scripts** must reach `claude` byte-exact through stdin on Windows and ollama through JSON. → Task 6 (stdin assertion) and Task 7 (`Привіт` in the chat body).
3. **ComfyUI restarting or crashing mid-job** (connection refused while polling `/history`) must be a retryable `TransientError`, not a permanent failure. → Task 11, test "turns a vanished server mid-run into a TransientError".
4. **Cancelling a job whose prompt is still queued inside ComfyUI** must delete that prompt from ComfyUI's queue and interrupt only that `prompt_id`, never someone else's run. → Task 11, test "cancels only its own prompt".
5. **A panel whose script references a deleted character, or characters without refs,** must still generate (prompt-only routing) instead of crashing. → Task 17, test "ignores deleted characters and characters without refs".

## Contract notes (deviations needing sign-off, all additive)

These are implemented by this plan because M2 cannot work without them; they must be copied into `docs/superpowers/plans/2026-09-27-00-contracts.md` when M2 lands (Task 24, Step 1):

1. `store.images.create` accepts an optional explicit `id` (M2 writes the PNG to `<imageId>.png` before the row exists). Task 1 verifies/patches M1.
2. `GET /api/recipes` is registered **only** by M2's imaging module (Fastify cannot re-register a route M1 already owns). Task 1 removes M1's `[]` stub.
3. M2 modules set `deps.statusProviders.claude/ollama/comfy` inside their factory/`register` (the object stays mutable).
4. `aiModule(deps, services?)` / `imagingModule(deps, services?)`: the optional second argument (default `servicesFor(deps)`, memoised per `CoreDeps`) lets tests inject fakes. `main.ts` still calls `aiModule(d)` / `imagingModule(d)` exactly as the contract says.
5. `ComfyClient` constructor takes an optional `pollMs`; `interrupt(promptId?)` takes an optional prompt id (targeted interrupt).
6. `packages/server/src/jobs/index.ts` and `packages/server/src/store/index.ts` are barrels re-exporting the C.4/C.1 names (created in Task 1 if M1 did not).
7. The `claude` child's env drops `ANTHROPIC_*`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_EFFORT`, `CLAUDE_PREVIEW_CLASSIFIER_FLOOR` (extends "never set ANTHROPIC_*").
8. The `claude` child uses `--tools ""` (text) / `--tools Read` (vision) — an allowlist, available in 2.1.281 — plus `--system-prompt`, `--permission-mode dontAsk`, `--no-session-persistence`, `--disable-slash-commands`, and the prompt is written to **stdin** (no 32 K command-line limit).

---

## File Structure

`packages/server/`:

| File | Responsibility |
|---|---|
| `package.json` (modify) | add `ws`, `@types/ws` |
| `src/jobs/index.ts` (create if missing) | barrel for M1's job names (`TransientError`, `PermanentError`, `GpuArbiter`, `JobQueue`, `JobContext`, `JobHandler`, …) |
| `src/store/index.ts` (create if missing) | barrel for M1's store names (`openStore`, `NotFoundError`, `Store`, …) |
| `src/util/hidden.ts` | `HIDDEN`, `HIDDEN_DETACHED` spawn options (copied from cleopatra) |
| `src/util/abort.ts` | `abortError`, abortable `sleep` |
| `src/engines/types.ts` | `JsonRequest`, `TextEngine` (C.6) |
| `src/engines/errors.ts` | `EngineUnavailableError`, `InvalidOutputError`, `QuotaExceededError` |
| `src/engines/resolve.ts` | `resolveEngine`, `Engines` |
| `src/engines/scripted.ts` | `ScriptedEngine` |
| `src/engines/structured.ts` | `extractJson`, `parseAgainst`, `jsonSchemaOf`, `withJsonInstruction`, `completeStructured` |
| `src/engines/claude-stream.ts` | stream-json classifier, NDJSON splitter, accumulator (trimmed from cleopatra); also the spec's "`quota.ts`" role: `rate_limit_event` parsing (the lane pause itself is wired in `modules/services.ts`) |
| `src/engines/claude.ts` | `ClaudeEngine`, `buildClaudeArgs`, `claudeEnv`, `LOGIN_HINT` |
| `src/engines/ollama.ts` | `OllamaEngine` (native `/api/chat`, `unload`, `health`) |
| `src/prompts/*.md` | system prompts: `panel-prompt-tags`, `panel-prompt-natural`, `appearance`, `review` |
| `src/prompts/load.ts` | `loadPrompt` (reads the `.md` at runtime from `src/prompts`) |
| `src/prompts/sanitize.ts` | `sanitizeTags`, `sanitizeSentences`, `normalizeAppearanceTags` |
| `src/prompts/script-block.ts` | `scriptBlock` — panel script as prompt text |
| `src/dev/fake-responses.ts` | `FAKE_RESPONSES` |
| `src/dev/png.ts` | `encodeSolidPng`, `crc32` |
| `src/dev/fake-comfy.ts` | `startFakeComfy`, `fakeOutputSize`, `FakeComfy` |
| `src/imaging/comfy-graph.ts` | `ComfyGraph`, `Link`, `nodesOf` |
| `src/imaging/png-size.ts` | `pngSize` |
| `src/imaging/launcher.ts` | `ComfyLauncher` |
| `src/imaging/comfy.ts` | `ComfyClient`, `ComfyRejectedError`, `stageLabel`, `formatRejection`, `executionError` |
| `src/imaging/recipes/{types,graph,models,sdxl}.ts` | recipe types, graph builder, model file names, shared SDXL builder |
| `src/imaging/recipes/{anime,anime-ref,anime-pose,anime-refine,qwen-edit-ref,klein-ref,anima,anima-turbo,upscale}.ts` | one file per recipe id |
| `src/imaging/recipes/index.ts` | `RECIPES`, `recipeInfo` |
| `src/imaging/route.ts` | `routeRecipe`, `refineFor`, `promptStyleFor` |
| `src/imaging/size.ts` | `panelAspect`, `panelSize`, `PORTRAIT_SIZE` |
| `src/imaging/image-row.ts` | `createImageWithId` |
| `src/imaging/generate.ts` | `generateImage`, `randomSeed`, `DEFAULT_REF_WEIGHT` |
| `src/jobs/llm-step.ts` | `registerLlmStep`, `llmStepJobHandler` |
| `src/handlers/types.ts` | `HandlerServices` |
| `src/handlers/context.ts` | `panelContext`, `pickRefs`, `pickRefImages`, `emitEntity`, `nonEmpty` |
| `src/handlers/panel-image.ts` | `generatePanelImage` |
| `src/handlers/character-images.ts` | `generatePortrait`, `generateSlot`, `generateCharacterRefs` |
| `src/handlers/review.ts` | `reviewImage`, `reviewRequest`, `ReviewOutputSchema` |
| `src/handlers/upscale.ts` | `upscaleImage` |
| `src/handlers/panel-prompt.ts` | `panelPromptStep`, `panelPromptRequest` |
| `src/handlers/appearance.ts` | `appearanceStep` |
| `src/handlers/index.ts` | job-handler factories for the four imaging job kinds |
| `src/modules/services.ts` | `M2Services`, `M2Options`, `servicesFor` |
| `src/modules/ai.ts` | `aiModule` |
| `src/modules/imaging.ts` | `imagingModule` |
| `src/api/reply.ts` | `sendError`, `zodMessage` |
| `src/api/imaging-routes.ts` | recipes, portraits, sheet, panel generate, panel review |
| `src/api/ai-routes.ts` | suggest-appearance, panel prompt |
| `src/main.ts` (modify) | `modules: (d) => [aiModule(d), imagingModule(d)]` |

`packages/server/test/`: `fixtures/claude/*.ndjson`, `fakes/{fake-claude.mjs,fake-ollama.ts,fake-comfy.ts}`, `helpers/{library.ts,seed.ts,job-context.ts,handler-services.ts,comfy-root.ts,m2-server.ts}`, and one `*.test.ts` per task.

`packages/cli/`: `src/commands/ai.ts` (new), the CLI entry that calls `register*Commands` (modify), `test/ai-commands.test.ts`.

---

### Task 1: M1 preflight, dependencies and barrels

M2 relies on a handful of M1 behaviours that the contract implies but does not spell out. This task pins them with a test and fixes M1 where it differs.

**Files:**
- Modify: `packages/server/package.json` (dependencies)
- Create if missing: `packages/server/src/jobs/index.ts`, `packages/server/src/store/index.ts`
- Modify if needed: M1's images repository `create`, M1's `startServer` URL computation, M1's `/api/recipes` registration (see Step 4)
- Test: `packages/server/test/m2-preflight.test.ts`

**Interfaces:**
- Consumes (M1, Contract C.1–C.5): `openStore`, `Store`, `NotFoundError`, `createPage`, `EventBus`, `GpuArbiter`, `JobQueue`, `TransientError`, `PermanentError`, `startServer`, `CoreDeps`.
- Produces: import paths every later task uses — `../jobs/index.js`, `../store/index.js`, `../events/bus.js`, `../domain/pages.js`, `../app.js` (relative to `src/<dir>/`); `ws` available to `@manga/server`.

- [ ] **Step 1: Add the WebSocket client/server dependency**

```bash
cd /c/Users/roman/Dev/Exalink/manga-builder
npm install ws@^8.18.3 -w @manga/server
npm install -D @types/ws@^8.18.1 -w @manga/server
```

Expected: both commands end with `added N packages` (or `up to date`) and `packages/server/package.json` lists `"ws": "^8.18.3"` in `dependencies` and `"@types/ws": "^8.18.1"` in `devDependencies`. If `@types/ws@^8.18.1` does not resolve, install the newest `@types/ws@8` and note it in the commit.

- [ ] **Step 2: Make sure the jobs and store barrels exist**

```bash
ls packages/server/src/jobs/index.ts packages/server/src/store/index.ts
```

If both exist, check they export the names below (`grep -n "TransientError\|PermanentError\|GpuArbiter\|JobQueue" packages/server/src/jobs/index.ts`, `grep -n "openStore\|NotFoundError" packages/server/src/store/index.ts`) and skip to Step 3.

For a missing barrel, list the files that define the contract names:

```bash
grep -lE "export (class|function|interface|type) (TransientError|PermanentError|GpuArbiter|GpuOwner|JobQueue|JobContext|JobHandler|EnqueueInput)\b" packages/server/src/jobs/*.ts
grep -lE "export (class|function|interface|type) (openStore|NotFoundError|Store|Repo|JobRepo|LibraryFiles)\b" packages/server/src/store/*.ts
```

Create the barrel with one `export *` line per file printed (example for files named `errors.ts`, `gpu.ts`, `queue.ts`; use the real names from the grep):

```ts
// packages/server/src/jobs/index.ts
export * from './errors.js';
export * from './gpu.js';
export * from './queue.js';
```

```ts
// packages/server/src/store/index.ts
export * from './open.js';
export * from './types.js';
```

Never add `llm-step.ts` (Task 16) to the jobs barrel: it imports from the barrel.

- [ ] **Step 3: Write the preflight test**

```ts
// packages/server/test/m2-preflight.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, STYLE_PRESETS } from '@manga/shared';
import { startServer } from '../src/app.js';
import { openStore } from '../src/store/index.js';
import { GpuArbiter, JobQueue, PermanentError, TransientError } from '../src/jobs/index.js';
import { EventBus } from '../src/events/bus.js';
import { createPage } from '../src/domain/pages.js';

const dirs: string[] = [];
function tempLibrary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manga-pre-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function seedManga(store: ReturnType<typeof openStore>) {
  const preset = STYLE_PRESETS['manga-bw']!;
  return store.mangas.create({
    title: 'Preflight', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
}

describe('M1 behaviours M2 relies on', () => {
  it('images.create keeps an explicit id', () => {
    const store = openStore(tempLibrary());
    try {
      const manga = seedManga(store);
      const rel = store.files.writeImage(manga.id, 'im_preflight01', new Uint8Array([1, 2, 3]));
      const image = store.images.create({
        id: 'im_preflight01', mangaId: manga.id, ownerType: 'character', ownerId: 'cr_preflight1', role: null,
        path: rel, width: 1, height: 1, source: 'uploaded', parentImageId: null, gen: null, review: null,
      } as Parameters<typeof store.images.create>[0]);
      expect(image.id).toBe('im_preflight01');
      expect(image.path).toBe(store.files.imageRel(manga.id, 'im_preflight01'));
    } finally {
      store.close();
    }
  });

  it('createPage creates a Panel row for every layout leaf', () => {
    const store = openStore(tempLibrary());
    try {
      const manga = seedManga(store);
      const chapter = store.chapters.create({
        mangaId: manga.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0,
      });
      const detail = createPage(store, chapter.id, '2x2');
      expect(detail.panels).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('startServer honours port 0 and lets a module factory replace status providers', async () => {
    const server = await startServer({
      config: { libraryPath: tempLibrary(), port: 0 },
      modules: (deps) => {
        deps.statusProviders.comfy = async () => ({ ok: true, detail: 'preflight' });
        return [];
      },
    });
    try {
      expect(new URL(server.url).port).not.toBe('0');
      const status = (await (await fetch(`${server.url}/api/status`)).json()) as { comfy: unknown };
      expect(status.comfy).toEqual({ ok: true, detail: 'preflight' });
    } finally {
      await server.stop();
    }
  });

  it('lets a module own GET /api/recipes (M1 only adds a [] fallback when nobody did)', async () => {
    const recipesModule = {
      name: 'preflight-recipes',
      register(app: import('fastify').FastifyInstance) {
        app.get('/api/recipes', async () => [{ id: 'anime' }]);
      },
    };
    const server = await startServer({ config: { libraryPath: tempLibrary(), port: 0 }, modules: () => [recipesModule] });
    try {
      const res = await fetch(`${server.url}/api/recipes`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: 'anime' }]);
    } finally {
      await server.stop();
    }
  });

  it('exposes the job primitives with the contract shapes', () => {
    const store = openStore(tempLibrary());
    try {
      expect(new TransientError('x')).toBeInstanceOf(Error);
      expect(new PermanentError('x')).toBeInstanceOf(Error);
      const queue = new JobQueue({ store, bus: new EventBus(), gpu: new GpuArbiter() });
      queue.pauseLane('claude', new Date('2100-01-01T00:00:00.000Z'), 'preflight');
      expect(queue.pausedLanes()).toEqual([{ lane: 'claude', until: '2100-01-01T00:00:00.000Z', reason: 'preflight' }]);
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 4: Run it and fix M1 where it differs**

Run: `npx vitest run packages/server/test/m2-preflight.test.ts`

Expected with M1 as planned: `Tests  5 passed (5)`. M1's plan already covers explicit ids, port 0, mutable status providers and both barrels, and it does not register `/api/recipes`. If anything fails, fix it as follows and re-run:

- **`lets a module own GET /api/recipes`**, failing with a Fastify "already declared" error: M1 registered the route after all. Find it with `grep -rn "api/recipes" packages/server/src packages/server/test`, delete that route and any M1 test that expects `[]` from it, then re-run.
- **`images.create keeps an explicit id`** fails with a different id — open the file printed by `grep -rln "images" packages/server/src/store | xargs grep -ln "newId('im')"` and change the create function so the id comes from the input when present:
  ```ts
  // inside the images repo create(input): widen the input type to `NewImage & { id?: string }`
  const id = input.id ?? newId('im');
  ```
- **`startServer honours port 0 …`** fails on the port — in `packages/server/src/app.ts` build the returned `url` from the bound address instead of the config:
  ```ts
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;
  ```
  If it fails on the status body, make `StatusProviders` a plain mutable object created per `startServer` call and have `/api/status` call `deps.statusProviders.<name>()` at request time.
- **`exposes the job primitives …`** fails — fix the barrel from Step 2 (a missing `export *` line).

Run again: `npx vitest run packages/server/test/m2-preflight.test.ts`
Expected: `Tests  5 passed (5)`. Then `npm test` — Expected: all M1 tests still pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — Expected: exit code 0.

```bash
git add packages/server/package.json package-lock.json packages/server/src packages/server/test/m2-preflight.test.ts
git commit -m "chore(server): M2 preflight — ws dependency, barrels, M1 behaviours pinned" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Engine contracts — types, errors, resolveEngine, Engines, ScriptedEngine

**Files:**
- Create: `packages/server/src/util/hidden.ts`, `packages/server/src/util/abort.ts`
- Create: `packages/server/src/engines/types.ts`, `errors.ts`, `resolve.ts`, `scripted.ts`
- Create: `packages/server/src/dev/fake-responses.ts`
- Test: `packages/server/test/engines-resolve.test.ts`

**Interfaces:**
- Consumes: `TransientError`, `PermanentError` (`../jobs/index.js`); `EngineName`, `Lane`, `ServiceState`, `Settings`, `Task` (`@manga/shared`).
- Produces (Contract C.6):
  - `interface JsonRequest<T> { name; task; system; prompt; schema: z.ZodType<T>; images?; signal?; onProgress? }`
  - `interface TextEngine { readonly name: EngineName; completeJson<T>(req: JsonRequest<T>): Promise<T>; health(): Promise<ServiceState> }`
  - `class EngineUnavailableError extends PermanentError`, `class InvalidOutputError extends PermanentError { raw: string }`, `class QuotaExceededError extends TransientError { resetsAt: string | null }`
  - `resolveEngine(settings, task): EngineName`; `class Engines { for(task): TextEngine; laneFor(task): Lane }`
  - `class ScriptedEngine implements TextEngine { calls: JsonRequest<unknown>[] }`, `type ScriptedResponse`
  - `FAKE_RESPONSES: Record<string, ScriptedResponse>` with keys `panel-prompt`, `appearance`, `review`
  - `HIDDEN`, `HIDDEN_DETACHED`; `abortError(signal)`, `sleep(ms, signal?)`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/engines-resolve.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type Settings } from '@manga/shared';
import { Engines, resolveEngine } from '../src/engines/resolve.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { EngineUnavailableError, InvalidOutputError, QuotaExceededError } from '../src/engines/errors.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { abortError, sleep } from '../src/util/abort.js';

const withEngine = (engine: Settings['engine']): Settings => ({ ...DEFAULT_SETTINGS, engine });

describe('resolveEngine', () => {
  it('falls back to the global mode', () => {
    expect(resolveEngine(withEngine({ mode: 'claude', tasks: {} }), 'story')).toBe('claude');
    expect(resolveEngine(withEngine({ mode: 'local', tasks: {} }), 'review')).toBe('local');
  });

  it('lets a per-task override win', () => {
    const settings = withEngine({ mode: 'claude', tasks: { review: 'local' } });
    expect(resolveEngine(settings, 'review')).toBe('local');
    expect(resolveEngine(settings, 'prompts')).toBe('claude');
    expect(resolveEngine(withEngine({ mode: 'local', tasks: { story: 'claude' } }), 'story')).toBe('claude');
  });
});

describe('Engines', () => {
  it('reads the settings on every call and maps local work to the gpu lane', () => {
    const claude = new ScriptedEngine('claude', {});
    const local = new ScriptedEngine('local', {});
    let settings = withEngine({ mode: 'claude', tasks: {} });
    const engines = new Engines({ settings: () => settings, claude, local });
    expect(engines.for('prompts')).toBe(claude);
    expect(engines.laneFor('prompts')).toBe('claude');
    settings = withEngine({ mode: 'local', tasks: {} });
    expect(engines.for('prompts')).toBe(local);
    expect(engines.laneFor('prompts')).toBe('gpu');
  });
});

describe('ScriptedEngine', () => {
  const schema = z.object({ scene: z.string() });
  const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'S', prompt: 'P', schema };

  it('answers by request name and validates against the schema', async () => {
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 'solo' }) });
    await expect(engine.completeJson(req)).resolves.toEqual({ scene: 'solo' });
    expect(engine.calls.map((c) => c.name)).toEqual(['panel-prompt']);
  });

  it('fails clearly without a scripted answer', async () => {
    const err = await new ScriptedEngine('local', {}).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('Scripted local engine has no response for "panel-prompt"');
  });

  it('rejects answers that do not match the schema', async () => {
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 3 }) });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).raw).toBe('{"scene":3}');
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 'x' }) });
    await expect(engine.completeJson({ ...req, signal: controller.signal })).rejects.toThrow();
    expect(engine.calls).toHaveLength(1);
  });

  it('reports healthy', async () => {
    await expect(new ScriptedEngine('local', {}).health()).resolves.toEqual({ ok: true, detail: 'scripted local engine (fakes)' });
  });
});

describe('errors and abort helpers', () => {
  it('quota errors are transient and carry the reset time', () => {
    const err = new QuotaExceededError('2100-01-01T00:00:00.000Z');
    expect(err).toBeInstanceOf(TransientError);
    expect(err.resetsAt).toBe('2100-01-01T00:00:00.000Z');
    expect(err.message).toBe('Claude quota exhausted until 2100-01-01T00:00:00.000Z');
  });

  it('abortError prefers the signal reason and sleep stops on abort', async () => {
    const controller = new AbortController();
    const reason = new Error('stop now');
    setTimeout(() => controller.abort(reason), 10);
    await expect(sleep(5_000, controller.signal)).rejects.toBe(reason);
    expect(abortError(undefined).message).toBe('Cancelled');
  });

  it('FAKE_RESPONSES covers the M2 request names', () => {
    expect(Object.keys(FAKE_RESPONSES).sort()).toEqual(['appearance', 'panel-prompt', 'review']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/engines-resolve.test.ts`
Expected: FAIL — `Failed to load url ../src/engines/resolve.js` (module does not exist).

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/util/hidden.ts
/**
 * Spawn options that never draw a console window. Copied from cleopatra
 * (packages/gateway/src/util/hidden.ts). A console-less parent — the detached
 * server — spawning a console program makes Windows open a new console window
 * unless CREATE_NO_WINDOW (`windowsHide`) is set. Spread into every spawn.
 */
export const HIDDEN = { windowsHide: true } as const;

/** For a child that must outlive this process. On Windows `detached` alone flashes a window. */
export const HIDDEN_DETACHED = { ...HIDDEN, detached: true } as const;
```

```ts
// packages/server/src/util/abort.ts
/** The error to throw when `signal` aborted: its reason if that is an Error, else a plain "Cancelled". */
export function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

/** setTimeout as a promise that rejects with `abortError(signal)` when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

```ts
// packages/server/src/engines/types.ts
import type { z } from 'zod';
import type { EngineName, ServiceState, Task } from '@manga/shared';

export interface JsonRequest<T> {
  /** Stable id for logs and fakes, e.g. 'panel-prompt', 'appearance', 'review', 'episode.premise'. */
  name: string;
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Absolute file paths (vision). */
  images?: string[];
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
}

export interface TextEngine {
  readonly name: EngineName;
  completeJson<T>(req: JsonRequest<T>): Promise<T>;
  health(): Promise<ServiceState>;
}
```

```ts
// packages/server/src/engines/errors.ts
import { PermanentError, TransientError } from '../jobs/index.js';

/** The engine cannot run at all (binary missing, not logged in, ollama down, model not pulled). Never retried. */
export class EngineUnavailableError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** The model's answer did not match the schema even after the correction round. `raw` keeps the last answer. */
export class InvalidOutputError extends PermanentError {
  constructor(message: string, public raw: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

/** Claude reported an exhausted quota window. Retried after the claude lane resumes. */
export class QuotaExceededError extends TransientError {
  constructor(public resetsAt: string | null) {
    super(resetsAt ? `Claude quota exhausted until ${resetsAt}` : 'Claude quota exhausted');
    this.name = 'QuotaExceededError';
  }
}
```

```ts
// packages/server/src/engines/resolve.ts
import type { EngineName, Lane, Settings, Task } from '@manga/shared';
import type { TextEngine } from './types.js';

export function resolveEngine(settings: Settings, task: Task): EngineName {
  return settings.engine.tasks[task] ?? settings.engine.mode;
}

export class Engines {
  constructor(private readonly opts: { settings: () => Settings; claude: TextEngine; local: TextEngine }) {}

  for(task: Task): TextEngine {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? this.opts.claude : this.opts.local;
  }

  /** Claude work runs in the 'claude' lane; local LLM work shares the GPU with ComfyUI. */
  laneFor(task: Task): Lane {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? 'claude' : 'gpu';
  }
}
```

```ts
// packages/server/src/engines/scripted.ts
import type { EngineName, ServiceState } from '@manga/shared';
import { EngineUnavailableError, InvalidOutputError } from './errors.js';
import type { JsonRequest, TextEngine } from './types.js';

export type ScriptedResponse = (req: JsonRequest<unknown>) => unknown;

/** A fake engine: answers are looked up by `JsonRequest.name`, then validated like a real answer. */
export class ScriptedEngine implements TextEngine {
  readonly calls: Array<JsonRequest<unknown>> = [];

  constructor(
    readonly name: EngineName,
    private readonly responses: Record<string, ScriptedResponse>,
  ) {}

  async completeJson<T>(req: JsonRequest<T>): Promise<T> {
    this.calls.push(req as JsonRequest<unknown>);
    req.signal?.throwIfAborted();
    const respond = this.responses[req.name];
    if (!respond) throw new EngineUnavailableError(`Scripted ${this.name} engine has no response for "${req.name}"`);
    req.onProgress?.(`Asking the scripted ${this.name} engine`);
    const raw: unknown = await respond(req as JsonRequest<unknown>);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidOutputError(`${req.name}: scripted answer does not match the schema: ${parsed.error.message}`, JSON.stringify(raw));
    }
    return parsed.data;
  }

  async health(): Promise<ServiceState> {
    return { ok: true, detail: `scripted ${this.name} engine (fakes)` };
  }
}
```

```ts
// packages/server/src/dev/fake-responses.ts
import type { JsonRequest } from '../engines/types.js';

/** Canned answers for MANGA_FAKES=1 and tests, keyed by JsonRequest.name. M4 adds 'episode.*' entries. */
export const FAKE_RESPONSES: Record<string, (req: JsonRequest<unknown>) => unknown> = {
  'panel-prompt': () => ({ scene: 'solo, standing, school rooftop, chain-link fence, sunset, wind' }),
  appearance: () => ({ appearanceTags: '1girl, silver hair, long hair, twintails, amber eyes, red scarf, school uniform, pleated skirt' }),
  review: () => ({ pass: true, issues: [] }),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/engines-resolve.test.ts`
Expected: PASS — `Tests  11 passed (11)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/util packages/server/src/engines packages/server/src/dev/fake-responses.ts packages/server/test/engines-resolve.test.ts
git commit -m "feat(server): engine contracts, resolveEngine, ScriptedEngine and fake responses" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Structured output — extract, validate, one correction round

**Files:**
- Create: `packages/server/src/engines/structured.ts`
- Test: `packages/server/test/structured.test.ts`

**Interfaces:**
- Consumes: `InvalidOutputError` (Task 2), `JsonRequest` (Task 2).
- Produces:
  - `extractJson(text: string): string | null` (copied from cleopatra `engines/local.ts:175`)
  - `type Parsed<T> = { ok: true; data: T } | { ok: false; problems: string }`; `parseAgainst<T>(raw, schema): Parsed<T>`
  - `jsonSchemaOf<T>(schema: z.ZodType<T>): Record<string, unknown>`; `withJsonInstruction<T>(system, schema): string`
  - `correctionPrompt(prompt, raw, problems): string`
  - `type Ask = (input: { system: string; prompt: string }) => Promise<string>`; `completeStructured<T>(ask: Ask, req: JsonRequest<T>): Promise<T>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/structured.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeStructured, extractJson, jsonSchemaOf, parseAgainst, withJsonInstruction } from '../src/engines/structured.js';
import { InvalidOutputError } from '../src/engines/errors.js';

describe('extractJson (from cleopatra)', () => {
  it('finds an object among prose', () => expect(extractJson('Sure! {"a":1} hope that helps')).toBe('{"a":1}'));
  it('handles nesting a regex would get wrong', () => expect(extractJson('x {"a":{"b":2}} y')).toBe('{"a":{"b":2}}'));
  it('is not fooled by braces inside strings', () => expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}'));
  it('survives a thinking preamble and fences', () =>
    expect(extractJson('<think>hm</think>\n```json\n{"ok":true}\n```')).toBe('{"ok":true}'));
  it('returns null when there is no object', () => expect(extractJson('no json here')).toBeNull());
});

describe('parseAgainst', () => {
  const schema = z.object({ pass: z.boolean(), issues: z.array(z.object({ kind: z.string() })) });

  it('parses JSON wrapped in prose and fences', () => {
    expect(parseAgainst('Sure!\n```json\n{"pass":true,"issues":[]}\n```', schema)).toEqual({ ok: true, data: { pass: true, issues: [] } });
  });

  it('explains a missing object', () => {
    expect(parseAgainst('no json', schema)).toEqual({ ok: false, problems: 'The answer contained no JSON object.' });
  });

  it('names the failing paths', () => {
    const result = parseAgainst('{"pass":"yes","issues":[{}]}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContain('pass:');
      expect(result.problems).toContain('issues.0.kind:');
    }
  });
});

describe('JSON schema instruction', () => {
  it('embeds the JSON schema of the zod schema after the system prompt', () => {
    const schema = z.object({ scene: z.string() });
    expect((jsonSchemaOf(schema)['properties'] as Record<string, unknown>)['scene']).toEqual({ type: 'string' });
    const system = withJsonInstruction('Be brief.', schema);
    expect(system.startsWith('Be brief.\n\nAnswer with exactly one JSON object and nothing else')).toBe(true);
    expect(system).toContain('"scene":{"type":"string"}');
  });
});

describe('completeStructured', () => {
  const schema = z.object({ scene: z.string().min(1) });
  const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'SYS', prompt: 'USER', schema };

  it('returns the first valid answer after one call', async () => {
    const calls: Array<{ system: string; prompt: string }> = [];
    const out = await completeStructured(async (input) => {
      calls.push(input);
      return 'Here you go: {"scene":"solo"}';
    }, req);
    expect(out).toEqual({ scene: 'solo' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain('SYS');
    expect(calls[0]!.prompt).toBe('USER');
  });

  it('runs exactly one correction round that quotes the problem and the answer', async () => {
    const answers = ['{"scene":""}', '{"scene":"solo"}'];
    const prompts: string[] = [];
    const progress: string[] = [];
    const out = await completeStructured(async (input) => {
      prompts.push(input.prompt);
      return answers.shift()!;
    }, { ...req, onProgress: (label) => progress.push(label) });
    expect(out).toEqual({ scene: 'solo' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('USER');
    expect(prompts[1]).toContain('scene:');
    expect(prompts[1]).toContain('{"scene":""}');
    expect(progress).toEqual(['Correcting the answer']);
  });

  it('fails with InvalidOutputError holding the raw second answer', async () => {
    let n = 0;
    const err = await completeStructured(async () => {
      n += 1;
      return `nope ${n}`;
    }, req).catch((e: unknown) => e);
    expect(n).toBe(2);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).raw).toBe('nope 2');
    expect((err as Error).message).toContain('panel-prompt');
    expect((err as Error).message).toContain('Raw output: nope 2');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/structured.test.ts`
Expected: FAIL — `Failed to load url ../src/engines/structured.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/engines/structured.ts
import { z } from 'zod';
import { InvalidOutputError } from './errors.js';
import type { JsonRequest } from './types.js';

/**
 * Pulls the first balanced JSON object out of a model's answer. Copied from
 * cleopatra (packages/gateway/src/engines/local.ts, extractJson): counting depth
 * while skipping string literals is the smallest thing that is actually correct.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; problems: string };

export function parseAgainst<T>(raw: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(raw);
  if (json === null) return { ok: false, problems: 'The answer contained no JSON object.' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, problems: `The JSON did not parse: ${(err as Error).message}` };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export function jsonSchemaOf<T>(schema: z.ZodType<T>): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
}

export function withJsonInstruction<T>(system: string, schema: z.ZodType<T>): string {
  return `${system.trim()}\n\nAnswer with exactly one JSON object and nothing else: no prose, no code fences. It must validate against this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`;
}

export function correctionPrompt(prompt: string, raw: string, problems: string): string {
  return `${prompt}\n\nYour previous answer could not be used: ${problems}\n\nPrevious answer:\n${raw.slice(0, 4000)}\n\nAnswer again with exactly one JSON object that fixes these problems.`;
}

export type Ask = (input: { system: string; prompt: string }) => Promise<string>;

/** Both engines: prompt → extract JSON → zod safeParse → one correction round → InvalidOutputError. */
export async function completeStructured<T>(ask: Ask, req: JsonRequest<T>): Promise<T> {
  const system = withJsonInstruction(req.system, req.schema);
  const first = await ask({ system, prompt: req.prompt });
  const a = parseAgainst(first, req.schema);
  if (a.ok) return a.data;
  req.signal?.throwIfAborted();
  req.onProgress?.('Correcting the answer');
  const second = await ask({ system, prompt: correctionPrompt(req.prompt, first, a.problems) });
  const b = parseAgainst(second, req.schema);
  if (b.ok) return b.data;
  throw new InvalidOutputError(
    `${req.name}: the answer still did not match after one correction round (${b.problems}). Raw output: ${second.slice(0, 2000)}`,
    second,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/structured.test.ts`
Expected: PASS — `Tests  12 passed (12)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engines/structured.ts packages/server/test/structured.test.ts
git commit -m "feat(server): structured JSON output with one correction round" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Prompt files, loader, sanitizers and the script block

**Files:**
- Create: `packages/server/src/prompts/panel-prompt-tags.md`, `panel-prompt-natural.md`, `appearance.md`, `review.md`
- Create: `packages/server/src/prompts/load.ts`, `sanitize.ts`, `script-block.ts`
- Test: `packages/server/test/prompts.test.ts`

**Interfaces:**
- Consumes: `Character`, `PanelScript` (`@manga/shared`).
- Produces:
  - `type PromptName = 'panel-prompt-tags' | 'panel-prompt-natural' | 'appearance' | 'review'`; `loadPrompt(name: PromptName): string`
  - `sanitizeTags(tags: string): string`, `sanitizeSentences(text: string): string`, `normalizeAppearanceTags(tags: string): string`
  - `scriptBlock(script: PanelScript, characters: Character[]): string`

The `.md` files are read at runtime. `tsc` does not copy them to `dist`, so `loadPrompt` looks next to itself first (vitest runs `src`) and then in `../../src/prompts/` (from `dist/prompts/`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/prompts.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Character, PanelScript } from '@manga/shared';
import { loadPrompt } from '../src/prompts/load.js';
import { normalizeAppearanceTags, sanitizeSentences, sanitizeTags } from '../src/prompts/sanitize.js';
import { scriptBlock } from '../src/prompts/script-block.js';

function character(id: string, name: string): Character {
  return {
    id, mangaId: 'mg_test000001', name, role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl, silver hair',
    seed: 1, recipe: null, refs: {}, createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('loadPrompt', () => {
  it.each(['panel-prompt-tags', 'panel-prompt-natural', 'appearance', 'review'] as const)('loads %s.md from disk', (name) => {
    const onDisk = readFileSync(fileURLToPath(new URL(`../src/prompts/${name}.md`, import.meta.url)), 'utf8').trim();
    expect(loadPrompt(name)).toBe(onDisk);
    expect(onDisk.length).toBeGreaterThan(200);
  });

  it('forbids appearance, names and lettering in both scene prompts', () => {
    for (const name of ['panel-prompt-tags', 'panel-prompt-natural'] as const) {
      const text = loadPrompt(name);
      expect(text).toContain('hair colour');
      expect(text).toContain('character names');
      expect(text).toContain('manga, comic, text, speech bubble');
    }
  });
});

describe('sanitizers', () => {
  it('drops forbidden and duplicate tags, keeps harmless look-alikes', () => {
    expect(sanitizeTags('Solo, manga, speech bubble, standing, solo, text, rooftop, no text')).toBe('Solo, standing, rooftop');
    expect(sanitizeTags('textbook, holding textbook')).toBe('textbook, holding textbook');
    expect(sanitizeTags(' , ,')).toBe('');
  });

  it('removes forbidden words from sentences and tidies punctuation', () => {
    expect(sanitizeSentences('Picture 1 girl on a rooftop, no speech bubbles, at sunset.')).toBe('Picture 1 girl on a rooftop, at sunset.');
    expect(sanitizeSentences('A comic scene without text.')).toBe('A scene.');
    expect(sanitizeSentences('Two people argue, no speech bubbles.')).toBe('Two people argue.');
  });

  it('normalizes appearance tags to lowercase unique tags', () => {
    expect(normalizeAppearanceTags('1girl, Silver Hair, twintails, silver hair, manga')).toBe('1girl, silver hair, twintails');
  });
});

describe('scriptBlock', () => {
  it('describes shot, stage directions and dialogue without appearance', () => {
    const aiko = character('cr_aiko000001', 'Aiko');
    const ren = character('cr_ren0000001', 'Ren');
    const script: PanelScript = {
      action: 'Aiko confronts Ren', shot: 'medium', angle: 'low', background: 'school rooftop',
      characters: [{ characterId: aiko.id, pose: 'pointing', expression: 'angry', position: 'left' }],
      dialogue: [
        { speakerId: aiko.id, kind: 'shout', text: 'Ти збрехав!' },
        { speakerId: null, kind: 'narration', text: 'Later.' },
      ],
    };
    expect(scriptBlock(script, [aiko, ren])).toBe([
      'Panel script:',
      '- Shot: medium; angle: low',
      '- Action: Aiko confronts Ren',
      '- Background: school rooftop',
      '- Characters (2):',
      '  1. Aiko: position left; pose: pointing; expression: angry',
      '  2. Ren: present',
      '- Dialogue (context only; it is lettered later and must never be drawn):',
      '  - Aiko (shout): "Ти збрехав!"',
      '  - narrator (narration): "Later."',
    ].join('\n'));
  });

  it('says so when nobody is in the panel', () => {
    const script: PanelScript = { action: '', shot: 'wide', angle: 'overhead', background: 'city at night', characters: [], dialogue: [] };
    expect(scriptBlock(script, [])).toBe([
      'Panel script:',
      '- Shot: wide; angle: overhead',
      '- Action: (not given)',
      '- Background: city at night',
      '- Characters (0): nobody; draw no people.',
    ].join('\n'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/prompts.test.ts`
Expected: FAIL — `Failed to load url ../src/prompts/load.js`.

- [ ] **Step 3: Write the prompt files**

`packages/server/src/prompts/panel-prompt-tags.md`:

```markdown
You write the scene part of the image prompt for one manga panel. The image model is an anime model (Illustrious or Anima) that understands Danbooru tags.

The app builds the final prompt around your text:
- it adds the book's style tags and, for black-and-white books, the monochrome and screentone tags;
- it adds every character's appearance tags verbatim (hair, eyes, face, body, outfit).

So write only what this panel shows beyond the characters' fixed looks.

Write 12 to 30 comma-separated Danbooru-style tags, lowercase, most important first:
1. Count and framing: `solo`, `2girls`, `1boy, 1girl`, `multiple boys`, or `no humans` when the panel has no characters.
2. Camera: shot size (`close-up`, `portrait`, `upper body`, `cowboy shot`, `full body`, `wide shot`, `very wide shot`) and angle (`from below`, `from above`, `dutch angle`, `from side`, `from behind`, `pov`).
3. Each character's pose, action and expression: `running`, `arms crossed`, `looking back`, `hand on own chest`, `smile`, `crying`, `surprised`, `open mouth`, `clenched teeth`.
4. Interaction: `holding hands`, `face-to-face`, `pointing at another`, `hug`.
5. Setting: place, time of day, weather, lighting and key props: `classroom`, `rooftop`, `chain-link fence`, `night`, `rain`, `backlighting`, `sunset`.

Use position tags such as `on left` and `on right` only when two or more characters are present.

Never write:
- hair colour, eye colour, hairstyle, clothing, accessories, body type, age or any other appearance detail of a character: the app adds those, and repeating or contradicting them makes characters drift;
- character names;
- the words manga, comic, text, speech bubble, caption, lettering, sound effects, watermark or signature, or anything else that asks for written words: panels never contain text;
- style or quality tags such as masterpiece, best quality, monochrome, greyscale, screentone or lineart: the app adds those.

The dialogue in the script is context for mood and expression only. Never describe it as visible writing.

Put the tags in the "scene" field.
```

`packages/server/src/prompts/panel-prompt-natural.md`:

```markdown
You write the scene part of the image prompt for one manga panel. The image model follows plain-English instructions (Qwen-Image-Edit or FLUX.2 klein) and also receives reference pictures of the characters.

The app builds the final prompt around your text: it adds the book's style words, black-and-white tokens for black-and-white books, and each character's appearance tags verbatim. Write only what this panel shows.

Write 2 to 4 plain English sentences:
- Start with the framing: shot size and camera angle.
- Say who is where. Refer to each character only as "the character from picture N" (the request tells you N) and by stage position (left, centre, right). When the request lists no reference pictures, refer to characters only by position, for example "the person on the left".
- Describe each character's pose, action, gaze and facial expression.
- Describe the setting: place, time of day, lighting, weather and key props.
- End with: "One single illustration; keep each character's face, hair and outfit exactly as in their reference picture."

Never write:
- hair colour, eye colour, hairstyle, clothing, accessories, body type or age of a character: the pictures and the app's tags carry those;
- character names;
- the words manga, comic, text, speech bubble, caption, lettering, sound effects, watermark or signature, or anything else that asks for written words: panels never contain text;
- style or quality words such as masterpiece, monochrome, screentone or lineart: the app adds them.

The dialogue in the script is context for mood and expression only. Never describe it as visible writing.

Put the sentences in the "scene" field.
```

`packages/server/src/prompts/appearance.md`:

```markdown
You turn a character description into the canonical appearance tag string for an anime image model that understands Danbooru tags. The app inserts this string verbatim into every image prompt for this character, so it must describe only fixed, visible traits that stay the same in every panel.

Rules:
- Start with exactly one of `1girl`, `1boy` or `1other`.
- Then, in this order: apparent age only when the description states it (`child`, `teenage`, `mature female`, `old man`), hair colour, hair length, hairstyle, eye colour, skin, distinctive face features (`freckles`, `scar`, `glasses`, `mole under eye`), body build, the default outfit piece by piece (`white shirt`, `red scarf`, `pleated skirt`, `black thighhighs`, `loafers`), then signature accessories.
- 8 to 25 tags, lowercase, comma-separated, Danbooru spelling (`long hair`, `twintails`, `amber eyes`, `school uniform`).
- No poses, expressions, actions, camera, background, lighting or mood: those change from panel to panel.
- No names, no style or quality tags, and never the words manga, comic, text or speech bubble.
- When the description leaves hair colour, hair length or eye colour out, pick a plain, typical choice; do not invent unusual traits.

Put the tags in the "appearanceTags" field.
```

`packages/server/src/prompts/review.md`:

```markdown
You check one generated manga panel image before a person sees it. Be strict about what a reader would notice and lenient about style.

You receive:
- the panel script: shot, angle, action, background and the characters with their stage position, pose and expression;
- picture 1: the generated image to check;
- pictures 2 and later: reference portraits of the characters, in the order the request lists them.

Look at every picture before you answer. Report an issue only when you can see it:
- character-count: the number of people differs from the script (someone extra, or someone missing);
- identity: a character clearly does not match their reference portrait (hair colour or style, eye colour, outfit);
- anatomy: broken or extra hands, fingers or limbs, a melted or duplicated face;
- text: any letters, words, speech bubbles, captions, sound-effect lettering, signatures or watermarks; panels must contain no text at all;
- script-mismatch: the shot, angle, action, pose, expression or setting clearly contradicts the script;
- other: anything else that makes the image unusable, for example a blank, corrupted or cut-off image.

Each note is one short sentence a person can act on, naming the character when relevant.
Set "pass" to true only when nothing would make you regenerate the image. Minor style differences are not issues; an empty "issues" list goes with "pass": true.
```

- [ ] **Step 4: Write the loader, sanitizers and script block**

```ts
// packages/server/src/prompts/load.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type PromptName = 'panel-prompt-tags' | 'panel-prompt-natural' | 'appearance' | 'review';

const cache = new Map<PromptName, string>();

/** Reads src/prompts/<name>.md. Works from src (vitest) and from dist/prompts (tsc does not copy .md files). */
export function loadPrompt(name: PromptName): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const candidates = [
    fileURLToPath(new URL(`./${name}.md`, import.meta.url)),
    fileURLToPath(new URL(`../../src/prompts/${name}.md`, import.meta.url)),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`Prompt ${name}.md not found (looked in ${candidates.join(', ')})`);
  const text = readFileSync(file, 'utf8').trim();
  cache.set(name, text);
  return text;
}
```

```ts
// packages/server/src/prompts/sanitize.ts
const FORBIDDEN_WORDS =
  'manga|comics?|text|speech ?bubbles?|word ?balloons?|captions?|lettering|sound effects?|onomatopoeia|watermarks?|signatures?';
const FORBIDDEN = new RegExp(`\\b(?:${FORBIDDEN_WORDS})\\b`, 'i');

/** Comma-separated tags: drops any tag containing a forbidden word, trims, de-duplicates case-insensitively. */
export function sanitizeTags(tags: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags.split(',')) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag || FORBIDDEN.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

/** Plain sentences: removes forbidden words (with a leading "no"/"without") and tidies the punctuation left behind. */
export function sanitizeSentences(text: string): string {
  const pattern = new RegExp(`\\b(?:no |without )?(?:${FORBIDDEN_WORDS})\\b`, 'gi');
  return text
    .replace(pattern, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[,;]+([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
    .trim();
}

export function normalizeAppearanceTags(tags: string): string {
  return sanitizeTags(tags.toLowerCase());
}
```

```ts
// packages/server/src/prompts/script-block.ts
import type { Character, PanelScript } from '@manga/shared';

/** The panel script as prompt text. Names only; appearance never appears here (the app injects tags itself). */
export function scriptBlock(script: PanelScript, characters: Character[]): string {
  const nameOf = (id: string | null): string =>
    id === null ? 'narrator' : characters.find((c) => c.id === id)?.name ?? 'someone';
  const lines = [
    'Panel script:',
    `- Shot: ${script.shot}; angle: ${script.angle}`,
    `- Action: ${script.action.trim() || '(not given)'}`,
    `- Background: ${script.background.trim() || '(not given)'}`,
  ];
  if (characters.length === 0) {
    lines.push('- Characters (0): nobody; draw no people.');
  } else {
    lines.push(`- Characters (${characters.length}):`);
    characters.forEach((c, i) => {
      const stage = script.characters.find((s) => s.characterId === c.id);
      lines.push(stage
        ? `  ${i + 1}. ${c.name}: position ${stage.position}; pose: ${stage.pose.trim() || 'unspecified'}; expression: ${stage.expression.trim() || 'unspecified'}`
        : `  ${i + 1}. ${c.name}: present`);
    });
  }
  if (script.dialogue.length > 0) {
    lines.push('- Dialogue (context only; it is lettered later and must never be drawn):');
    for (const line of script.dialogue) lines.push(`  - ${nameOf(line.speakerId)} (${line.kind}): "${line.text}"`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/prompts.test.ts`
Expected: PASS — `Tests  10 passed (10)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/prompts packages/server/test/prompts.test.ts
git commit -m "feat(server): LLM system prompts, loader, sanitizers and script block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude stream-json parser and fixtures

**Files:**
- Create: `packages/server/src/engines/claude-stream.ts`
- Copy: two real captures from cleopatra into `packages/server/test/fixtures/claude/`
- Create: synthetic fixtures `json-reply.ndjson`, `review-reply.ndjson`, `rate-limited.ndjson`, `not-logged-in.ndjson`, `tools-leak.ndjson`, and `MANIFEST.json` in the same folder
- Test: `packages/server/test/claude-stream.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RateLimitInfo { status: string; resetsAt: number | null; rateLimitType: string }` (`resetsAt` is Unix seconds)
  - `classify(raw)`, `classifyLine(line): StreamEvent`, `createNdjsonSplitter()`
  - `interface ClaudeRunState { tools: string[] | null; text: string; result: { isError: boolean; text: string | null } | null; rateLimit: RateLimitInfo | null }`
  - `createClaudeAccumulator(hooks?: { onInit?(tools); onToolUse?(name) }): { push(chunk): void; end(): ClaudeRunState }`
  - `parseClaudeStream(ndjson, hooks?): ClaudeRunState`

Trimmed from cleopatra `packages/gateway/src/runner/events.ts` (classify), `runner/ndjson.ts` (splitter) and `runner/run.ts:115` (`createRunAccumulator`). The rate-limit status is not binary (`allowed`, `allowed_warning`, `rejected`, per cleopatra `quota/governor.ts`); only `rejected` blocks, and once seen it stays.

- [ ] **Step 1: Copy the real captures**

```bash
mkdir -p packages/server/test/fixtures/claude
cp /c/Users/roman/Dev/Exalink/cleopatra/tests/fixtures/stream-json/simple-reply.ndjson packages/server/test/fixtures/claude/simple-reply.ndjson
cp /c/Users/roman/Dev/Exalink/cleopatra/tests/fixtures/stream-json/long-stream.ndjson packages/server/test/fixtures/claude/long-stream.ndjson
```

Expected: both files exist (`wc -l packages/server/test/fixtures/claude/*.ndjson` shows 11 and 12 lines).

- [ ] **Step 2: Create the synthetic fixtures (exact content, one JSON object per line)**

`packages/server/test/fixtures/claude/json-reply.ndjson`:

```
{"type":"system","subtype":"init","cwd":"C:\\MangaBuilder\\.claude-cwd","session_id":"00000000-0000-4000-8000-000000000001","tools":[],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"dontAsk","apiKeySource":"none","claude_code_version":"2.1.281"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":4102444800,"rateLimitType":"five_hour","isUsingOverage":false},"session_id":"00000000-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\"scene\":\"solo, standing, school rooftop, sunset\"}"}],"usage":{"input_tokens":10,"output_tokens":20}},"session_id":"00000000-0000-4000-8000-000000000001"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"{\"scene\":\"solo, standing, school rooftop, sunset\"}","session_id":"00000000-0000-4000-8000-000000000001","total_cost_usd":0.01}
```

`packages/server/test/fixtures/claude/review-reply.ndjson`:

```
{"type":"system","subtype":"init","cwd":"C:\\MangaBuilder\\.claude-cwd","session_id":"00000000-0000-4000-8000-000000000002","tools":["Read"],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"dontAsk","apiKeySource":"none","claude_code_version":"2.1.281"}
{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"C:\\MangaBuilder\\mangas\\mg_1\\images\\im_1.png"}}]},"session_id":"00000000-0000-4000-8000-000000000002"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"[image]"}]}]},"session_id":"00000000-0000-4000-8000-000000000002"}
{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\"pass\":false,\"issues\":[{\"kind\":\"text\",\"note\":\"A speech bubble is drawn top left.\"}]}"}]},"session_id":"00000000-0000-4000-8000-000000000002"}
{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"{\"pass\":false,\"issues\":[{\"kind\":\"text\",\"note\":\"A speech bubble is drawn top left.\"}]}","session_id":"00000000-0000-4000-8000-000000000002"}
```

`packages/server/test/fixtures/claude/rate-limited.ndjson`:

```
{"type":"system","subtype":"init","cwd":"C:\\MangaBuilder\\.claude-cwd","session_id":"00000000-0000-4000-8000-000000000003","tools":[],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"dontAsk","apiKeySource":"none","claude_code_version":"2.1.281"}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"five_hour","isUsingOverage":false},"session_id":"00000000-0000-4000-8000-000000000003"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":4102531200,"rateLimitType":"seven_day","isUsingOverage":false},"session_id":"00000000-0000-4000-8000-000000000003"}
{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"You've hit your limit · resets 4pm","session_id":"00000000-0000-4000-8000-000000000003"}
```

`packages/server/test/fixtures/claude/not-logged-in.ndjson`:

```
{"type":"system","subtype":"init","cwd":"C:\\MangaBuilder\\.claude-cwd","session_id":"00000000-0000-4000-8000-000000000004","tools":[],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"dontAsk","apiKeySource":"none","claude_code_version":"2.1.281"}
{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"Invalid API key · Please run /login","session_id":"00000000-0000-4000-8000-000000000004"}
```

`packages/server/test/fixtures/claude/tools-leak.ndjson`:

```
{"type":"system","subtype":"init","cwd":"C:\\MangaBuilder\\.claude-cwd","session_id":"00000000-0000-4000-8000-000000000005","tools":["Bash","Read","Write"],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"dontAsk","apiKeySource":"none","claude_code_version":"2.1.281"}
{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"{}"}]},"session_id":"00000000-0000-4000-8000-000000000005"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"{}","session_id":"00000000-0000-4000-8000-000000000005"}
```

`packages/server/test/fixtures/claude/MANIFEST.json`:

```json
{
  "real": {
    "simple-reply.ndjson": "Copied from C:/Users/roman/Dev/Exalink/cleopatra/tests/fixtures/stream-json/simple-reply.ndjson (claude 2.1.241, captured 2026-08-23).",
    "long-stream.ndjson": "Copied from C:/Users/roman/Dev/Exalink/cleopatra/tests/fixtures/stream-json/long-stream.ndjson (claude 2.1.241, captured 2026-08-23)."
  },
  "synthetic": {
    "json-reply.ndjson": "Hand-written in the real event shape: a JSON-only answer.",
    "review-reply.ndjson": "Hand-written: one Read tool call, then a JSON review.",
    "rate-limited.ndjson": "Hand-written: a rejected five_hour window (resets 2100-01-01) followed by an allowed seven_day window, then an error result.",
    "not-logged-in.ndjson": "Hand-written: an error result asking to /login.",
    "tools-leak.ndjson": "Hand-written: system/init reporting tools the run must not have."
  }
}
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/server/test/claude-stream.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyLine, createClaudeAccumulator, parseClaudeStream } from '../src/engines/claude-stream.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url)), 'utf8');

describe('claude stream-json parsing', () => {
  it('reads the result text, empty toolset and window from a real capture', () => {
    const state = parseClaudeStream(fixture('simple-reply'));
    expect(state.result).toEqual({ isError: false, text: 'ready' });
    expect(state.tools).toEqual([]);
    expect(state.rateLimit).toEqual({ status: 'allowed', resetsAt: 1787500200, rateLimitType: 'five_hour' });
  });

  it('assembles a long streamed reply', () => {
    const state = parseClaudeStream(fixture('long-stream'));
    expect(state.result?.isError).toBe(false);
    expect(state.result?.text).toContain('40');
  });

  it('survives arbitrary chunk boundaries', () => {
    const raw = fixture('long-stream');
    const acc = createClaudeAccumulator();
    for (let i = 0; i < raw.length; i += 7) acc.push(raw.slice(i, i + 7));
    expect(acc.end()).toEqual(parseClaudeStream(raw));
  });

  it('keeps a rejected window even when an allowed one arrives later', () => {
    const state = parseClaudeStream(fixture('rate-limited'));
    expect(state.rateLimit).toEqual({ status: 'rejected', resetsAt: 4102444800, rateLimitType: 'five_hour' });
    expect(state.result?.isError).toBe(true);
  });

  it('reports the init toolset and tool uses through hooks', () => {
    const inits: string[][] = [];
    const uses: string[] = [];
    const state = parseClaudeStream(fixture('review-reply'), { onInit: (t) => inits.push(t), onToolUse: (n) => uses.push(n) });
    expect(inits).toEqual([['Read']]);
    expect(uses).toEqual(['Read']);
    expect(state.result?.text).toContain('"pass":false');
  });

  it('ignores garbage and host chatter', () => {
    expect(classifyLine('not json')).toEqual({ kind: 'ignore' });
    expect(classifyLine('{"type":"system","subtype":"hook_started"}')).toEqual({ kind: 'ignore' });
    expect(classifyLine('{"type":"stream_event","event":{"type":"message_stop"}}')).toEqual({ kind: 'ignore' });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run packages/server/test/claude-stream.test.ts`
Expected: FAIL — `Failed to load url ../src/engines/claude-stream.js`.

- [ ] **Step 5: Write the implementation**

```ts
// packages/server/src/engines/claude-stream.ts
/**
 * Parser for `claude -p --output-format stream-json --verbose`. Trimmed from
 * cleopatra (packages/gateway/src/runner/events.ts, runner/ndjson.ts and
 * createRunAccumulator in runner/run.ts). Nothing here throws: a malformed line
 * becomes 'ignore'. The final result object is recognised by `num_turns`, not by
 * trusting its `type` tag (verified against claude 2.1.241 captures).
 */
export interface RateLimitInfo {
  /** 'allowed' | 'allowed_warning' | 'rejected' — only 'rejected' blocks. */
  status: string;
  /** Unix seconds. */
  resetsAt: number | null;
  /** e.g. 'five_hour', 'seven_day'. */
  rateLimitType: string;
}

export type StreamEvent =
  | { kind: 'init'; tools: string[] }
  | { kind: 'assistant'; text: string; toolUses: string[] }
  | { kind: 'rate_limit'; info: RateLimitInfo }
  | { kind: 'result'; isError: boolean; text: string | null }
  | { kind: 'ignore' };

const IGNORE: StreamEvent = { kind: 'ignore' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function blocks(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

export function classify(raw: unknown): StreamEvent {
  if (!isRecord(raw)) return IGNORE;
  if (num(raw['num_turns']) !== null) {
    return { kind: 'result', isError: raw['is_error'] === true, text: str(raw['result']) };
  }
  switch (raw['type']) {
    case 'system': {
      if (raw['subtype'] !== 'init') return IGNORE;
      const tools = raw['tools'];
      return { kind: 'init', tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [] };
    }
    case 'assistant': {
      const message = raw['message'];
      if (!isRecord(message)) return IGNORE;
      const content = blocks(message['content']);
      return {
        kind: 'assistant',
        text: content.filter((b) => b['type'] === 'text').map((b) => str(b['text']) ?? '').join(''),
        toolUses: content.filter((b) => b['type'] === 'tool_use').map((b) => str(b['name'])).filter((n): n is string => n !== null),
      };
    }
    case 'rate_limit_event': {
      const info = raw['rate_limit_info'];
      if (!isRecord(info)) return IGNORE;
      return {
        kind: 'rate_limit',
        info: { status: str(info['status']) ?? 'unknown', resetsAt: num(info['resetsAt']), rateLimitType: str(info['rateLimitType']) ?? 'unknown' },
      };
    }
    default:
      return IGNORE;
  }
}

export function classifyLine(line: string): StreamEvent {
  try {
    return classify(JSON.parse(line));
  } catch {
    return IGNORE;
  }
}

/** Chunk boundaries land anywhere; anything after the last newline waits for the rest. */
export function createNdjsonSplitter(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string): string[] => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  };
}

export interface ClaudeRunState {
  tools: string[] | null;
  text: string;
  result: { isError: boolean; text: string | null } | null;
  rateLimit: RateLimitInfo | null;
}

export interface AccumulatorHooks {
  onInit?: (tools: string[]) => void;
  onToolUse?: (name: string) => void;
}

export function createClaudeAccumulator(hooks: AccumulatorHooks = {}): { push(chunk: string): void; end(): ClaudeRunState } {
  const split = createNdjsonSplitter();
  const state: ClaudeRunState = { tools: null, text: '', result: null, rateLimit: null };
  const handle = (line: string): void => {
    const event = classifyLine(line);
    switch (event.kind) {
      case 'init':
        state.tools = event.tools;
        hooks.onInit?.(event.tools);
        break;
      case 'assistant':
        state.text += event.text;
        for (const tool of event.toolUses) hooks.onToolUse?.(tool);
        break;
      case 'rate_limit':
        if (state.rateLimit?.status !== 'rejected') state.rateLimit = event.info;
        break;
      case 'result':
        state.result = { isError: event.isError, text: event.text };
        break;
      case 'ignore':
        break;
    }
  };
  return {
    push(chunk: string): void {
      for (const line of split(chunk)) handle(line);
    },
    end(): ClaudeRunState {
      for (const line of split('\n')) handle(line);
      return state;
    },
  };
}

export function parseClaudeStream(ndjson: string, hooks: AccumulatorHooks = {}): ClaudeRunState {
  const acc = createClaudeAccumulator(hooks);
  acc.push(ndjson);
  return acc.end();
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/claude-stream.test.ts`
Expected: PASS — `Tests  6 passed (6)`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/engines/claude-stream.ts packages/server/test/claude-stream.test.ts packages/server/test/fixtures/claude
git commit -m "feat(server): claude stream-json parser with real and synthetic fixtures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: ClaudeEngine — isolated `claude -p` child

**Files:**
- Create: `packages/server/src/engines/claude.ts`
- Create: `packages/server/test/fakes/fake-claude.mjs`
- Test: `packages/server/test/claude-engine.test.ts`

**Interfaces:**
- Consumes: `completeStructured` (Task 3), `createClaudeAccumulator`, `ClaudeRunState` (Task 5), errors (Task 2), `HIDDEN`, `abortError` (Task 2), `PermanentError`, `TransientError`.
- Produces:
  - `LOGIN_HINT: string`
  - `interface ClaudeEngineOptions { bin: string; binArgs?: string[]; cwd: string; mangasDir: string; models: () => Settings['claude']['models']; onRateLimit?: (resetsAt: string | null, reason: string) => void; timeoutMs?: number; healthTtlMs?: number }`
  - `buildClaudeArgs(i: { model; system; vision; mcpConfigPath; mangasDir }): string[]`
  - `claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `class ClaudeEngine implements TextEngine` (`name = 'claude'`)

Rules carried over from cleopatra (`engines/engine.ts` SubscriptionEngine, `runner/run.ts` buildArgs/buildSpawnOptions):
- never set (and here: never inherit) `ANTHROPIC_*`; never `--bare`;
- `shell: false` (cmd.exe mangles quoted args), `windowsHide: true`;
- isolated cwd `<library>/.claude-cwd` with no CLAUDE.md (discovery walks up, so it lives in the library, not the repo);
- `--strict-mcp-config --mcp-config <empty file>`;
- the toolset reported at `system/init` is verified; anything unexpected kills the run (cleopatra's `toolset` breach). On 2.1.281 `--tools` is a real allowlist (`--tools ""` disables all built-in tools), so it replaces cleopatra's deny list.

- [ ] **Step 1: Write the fake `claude` binary**

```js
// packages/server/test/fakes/fake-claude.mjs
// Stands in for the `claude` binary in tests: node fake-claude.mjs <fixture|hang|logged-in|logged-out> <record.json> ...claudeArgs
import { readFileSync, writeFileSync } from 'node:fs';

const [, , fixture = '', record = '', ...args] = process.argv;

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: fixture === 'logged-in', authMethod: fixture === 'logged-in' ? 'claude.ai' : 'none' }));
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  writeFileSync(record, JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    env: {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      claudeCode: process.env.CLAUDECODE ?? null,
      hasPath: Boolean(process.env.PATH),
    },
  }));
  if (fixture === 'hang') {
    setInterval(() => {}, 1_000);
    return;
  }
  process.stdout.write(readFileSync(fixture, 'utf8'));
});
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/claude-engine.test.ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '@manga/shared';
import { ClaudeEngine, LOGIN_HINT, buildClaudeArgs, claudeEnv, type ClaudeEngineOptions } from '../src/engines/claude.js';
import { EngineUnavailableError, QuotaExceededError } from '../src/engines/errors.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url));

interface Recorded { args: string[]; stdin: string; cwd: string; env: { anthropicBaseUrl: string | null; claudeCode: string | null; hasPath: boolean } }

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'manga-claude-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

function makeEngine(fx: string, extra: Partial<ClaudeEngineOptions> = {}): { engine: ClaudeEngine; record: string } {
  const record = join(dir, 'record.json');
  const engine = new ClaudeEngine({
    bin: process.execPath, binArgs: [FAKE, fx, record],
    cwd: join(dir, 'lib', '.claude-cwd'), mangasDir: join(dir, 'lib', 'mangas'),
    models: () => DEFAULT_SETTINGS.claude.models, ...extra,
  });
  return { engine, record };
}
const recorded = (path: string): Recorded => JSON.parse(readFileSync(path, 'utf8')) as Recorded;

const Scene = z.object({ scene: z.string() });
const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'You write scenes.', prompt: 'Panel: Аліса стоїть на даху.', schema: Scene };

describe('buildClaudeArgs', () => {
  it('disables every tool for text requests', () => {
    expect(buildClaudeArgs({ model: 'sonnet', system: 'S', vision: false, mcpConfigPath: 'M', mangasDir: 'D' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--system-prompt', 'S',
      '--tools', '', '--strict-mcp-config', '--mcp-config', 'M', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands',
    ]);
  });

  it('allows only Read, and only inside the mangas folder, for image requests', () => {
    const args = buildClaudeArgs({ model: 'opus', system: 'S', vision: true, mcpConfigPath: 'M', mangasDir: 'D' });
    const i = args.indexOf('--tools');
    expect(args.slice(i, i + 2)).toEqual(['--tools', 'Read']);
    expect(args.slice(-4)).toEqual(['--allowedTools', 'Read', '--add-dir', 'D']);
    expect(args).not.toContain('--bare');
  });
});

describe('claudeEnv', () => {
  it('drops API-key and host-session variables and keeps everything else', () => {
    expect(claudeEnv({
      Path: 'C:\\bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: 'C:\\cfg', HOME: 'h',
    })).toEqual({ Path: 'C:\\bin', CLAUDE_CONFIG_DIR: 'C:\\cfg', HOME: 'h' });
  });
});

describe('ClaudeEngine', () => {
  it('returns schema-checked JSON, runs in the isolated cwd and sends the prompt on stdin', async () => {
    const { engine, record } = makeEngine(fixture('json-reply'));
    await expect(engine.completeJson(req)).resolves.toEqual({ scene: 'solo, standing, school rooftop, sunset' });
    const r = recorded(record);
    expect(r.stdin).toBe('Panel: Аліса стоїть на даху.');
    expect(r.cwd.toLowerCase()).toBe(join(dir, 'lib', '.claude-cwd').toLowerCase());
    expect(r.args[r.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(r.args[r.args.indexOf('--system-prompt') + 1]).toContain('You write scenes.');
    const mcp = r.args[r.args.indexOf('--mcp-config') + 1]!;
    expect(JSON.parse(readFileSync(mcp, 'utf8'))).toEqual({ mcpServers: {} });
    expect(readdirSync(join(dir, 'lib', '.claude-cwd'))).toEqual([]);
  });

  it('never passes ANTHROPIC_* or host-session variables to the child', async () => {
    const saved = { base: process.env['ANTHROPIC_BASE_URL'], code: process.env['CLAUDECODE'] };
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:1';
    process.env['CLAUDECODE'] = '1';
    try {
      const { engine, record } = makeEngine(fixture('json-reply'));
      await engine.completeJson(req);
      expect(recorded(record).env).toEqual({ anthropicBaseUrl: null, claudeCode: null, hasPath: true });
    } finally {
      if (saved.base === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = saved.base;
      if (saved.code === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = saved.code;
    }
  });

  it('lists image paths for the Read tool on vision requests', async () => {
    const { engine, record } = makeEngine(fixture('review-reply'));
    const progress: string[] = [];
    const schema = z.object({ pass: z.boolean(), issues: z.array(z.object({ kind: z.string(), note: z.string() })) });
    const out = await engine.completeJson({
      name: 'review', task: 'review', system: 'Review.', prompt: 'Check.', schema,
      images: ['C:\\lib\\mangas\\a.png', 'C:\\lib\\mangas\\b.png'], onProgress: (l) => progress.push(l),
    });
    expect(out.pass).toBe(false);
    const r = recorded(record);
    expect(r.stdin).toBe('Check.\n\nImage files (open every one with the Read tool before answering):\n1. C:\\lib\\mangas\\a.png\n2. C:\\lib\\mangas\\b.png');
    expect(r.args.slice(-2)).toEqual(['--add-dir', join(dir, 'lib', 'mangas')]);
    expect(progress).toEqual(['Asking Claude (sonnet)', 'Looking at the images']);
  });

  it('turns a rejected rate-limit window into QuotaExceededError and reports it', async () => {
    const seen: Array<[string | null, string]> = [];
    const { engine } = makeEngine(fixture('rate-limited'), { onRateLimit: (at, reason) => { seen.push([at, reason]); } });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).resetsAt).toBe('2100-01-01T00:00:00.000Z');
    expect(seen).toEqual([['2100-01-01T00:00:00.000Z', 'Claude quota exhausted (five_hour window)']]);
  });

  it('explains how to log in when the CLI is signed out', async () => {
    const { engine } = makeEngine(fixture('not-logged-in'));
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe(LOGIN_HINT);
  });

  it('kills a run whose toolset is not locked down', async () => {
    const { engine } = makeEngine(fixture('tools-leak'));
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain('Bash, Read, Write');
  });

  it('reports a missing binary as engine unavailable', async () => {
    const engine = new ClaudeEngine({
      bin: join(dir, 'no-such-claude.exe'), cwd: join(dir, 'c'), mangasDir: dir, models: () => DEFAULT_SETTINGS.claude.models,
    });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toContain('claude CLI not found');
  });

  it('kills the child when the job is cancelled', async () => {
    const { engine } = makeEngine('hang');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    await expect(engine.completeJson({ ...req, signal: controller.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out a run that never ends', async () => {
    const { engine } = makeEngine('hang', { timeoutMs: 400 });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toContain('did not finish');
  });

  it('health reads claude auth status', async () => {
    await expect(makeEngine('logged-in').engine.health()).resolves.toEqual({ ok: true, detail: 'logged in (claude.ai)' });
    await expect(makeEngine('logged-out').engine.health()).resolves.toEqual({ ok: false, detail: LOGIN_HINT });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/claude-engine.test.ts`
Expected: FAIL — `Failed to load url ../src/engines/claude.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/src/engines/claude.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServiceState, Settings } from '@manga/shared';
import { PermanentError, TransientError } from '../jobs/index.js';
import { abortError } from '../util/abort.js';
import { HIDDEN } from '../util/hidden.js';
import { createClaudeAccumulator, type ClaudeRunState } from './claude-stream.js';
import { EngineUnavailableError, QuotaExceededError } from './errors.js';
import { completeStructured } from './structured.js';
import type { JsonRequest, TextEngine } from './types.js';

export const LOGIN_HINT = 'Claude is not logged in. Run `claude` once in a terminal (or `claude auth login`) to sign in with your subscription.';

export interface ClaudeEngineOptions {
  /** config.claudeBin, normally 'claude' (a native exe on this machine). */
  bin: string;
  /** Arguments placed before the claude arguments (tests run `node fake-claude.mjs …`). */
  binArgs?: string[];
  /** <library>/.claude-cwd — empty, no CLAUDE.md, outside any repo. */
  cwd: string;
  /** <library>/mangas — the only directory Read may open. */
  mangasDir: string;
  models: () => Settings['claude']['models'];
  onRateLimit?: (resetsAt: string | null, reason: string) => void;
  timeoutMs?: number;
  healthTtlMs?: number;
}

export interface ClaudeArgsInput { model: string; system: string; vision: boolean; mcpConfigPath: string; mangasDir: string }

/** The prompt itself goes to stdin. Never --bare: it forces API-key auth and bypasses the subscription login. */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', i.model,
    '--system-prompt', i.system,
    '--tools', i.vision ? 'Read' : '',
    '--strict-mcp-config', '--mcp-config', i.mcpConfigPath,
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--disable-slash-commands',
  ];
  if (i.vision) args.push('--allowedTools', 'Read', '--add-dir', i.mangasDir);
  return args;
}

const HOST_SESSION_VARS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR']);

/**
 * The inherited environment minus API-key and host-session variables. A server
 * started from inside a Claude Code session inherits ANTHROPIC_BASE_URL and
 * CLAUDE_CODE_*; passing them on would make the child use the host session
 * instead of the owner's subscription login. Keys keep their original case
 * (Windows `Path`), which is why this copies rather than rebuilds.
 */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_CODE_') || HOST_SESSION_VARS.has(upper)) continue;
    out[key] = value;
  }
  return out;
}

function imageList(paths: string[]): string {
  return `Image files (open every one with the Read tool before answering):\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}

function resetSuffix(text: string): string | null {
  const match = /\|(\d{10})\b/.exec(text);
  return match ? new Date(Number(match[1]) * 1000).toISOString() : null;
}

type AskContext = Pick<JsonRequest<unknown>, 'task' | 'images' | 'signal' | 'onProgress'>;

export class ClaudeEngine implements TextEngine {
  readonly name = 'claude' as const;
  private healthCache: { at: number; state: ServiceState } | null = null;

  constructor(private readonly opts: ClaudeEngineOptions) {}

  completeJson<T>(req: JsonRequest<T>): Promise<T> {
    return completeStructured(({ system, prompt }) => this.ask(system, prompt, req), req);
  }

  async health(): Promise<ServiceState> {
    const ttl = this.opts.healthTtlMs ?? 30_000;
    if (this.healthCache && Date.now() - this.healthCache.at < ttl) return this.healthCache.state;
    const state = await this.probe();
    this.healthCache = { at: Date.now(), state };
    return state;
  }

  private mcpConfigPath(): string {
    const file = join(dirname(this.opts.cwd), '.claude-empty-mcp.json');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"mcpServers":{}}\n');
    }
    return file;
  }

  private ask(system: string, prompt: string, req: AskContext): Promise<string> {
    const images = req.images ?? [];
    const vision = images.length > 0;
    const model = this.opts.models()[req.task];
    mkdirSync(this.opts.cwd, { recursive: true });
    const args = [
      ...(this.opts.binArgs ?? []),
      ...buildClaudeArgs({ model, system, vision, mcpConfigPath: this.mcpConfigPath(), mangasDir: this.opts.mangasDir }),
    ];
    const input = vision ? `${prompt}\n\n${imageList(images)}` : prompt;
    const allowed = vision ? ['Read'] : [];
    const timeoutMs = this.opts.timeoutMs ?? 600_000;
    req.onProgress?.(`Asking Claude (${model})`);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      const child = spawn(this.opts.bin, args, {
        ...HIDDEN, cwd: this.opts.cwd, shell: false, env: claudeEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'],
      });
      const onAbort = (): void => fail(abortError(req.signal));
      const finish = (err: Error | null, text = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(text);
      };
      const fail = (err: Error): void => {
        child.kill();
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        finish(err);
      };
      const acc = createClaudeAccumulator({
        onInit: (tools) => {
          const unexpected = tools.filter((t) => !allowed.includes(t));
          if (unexpected.length > 0) {
            fail(new PermanentError(`claude run aborted: unexpected tools available (${unexpected.join(', ')}). The --tools flag did not take effect with this CLI version.`));
          }
        },
        onToolUse: (name) => req.onProgress?.(name === 'Read' ? 'Looking at the images' : `Using ${name}`),
      });

      timer = setTimeout(() => fail(new TransientError(`claude did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      if (req.signal?.aborted) queueMicrotask(onAbort);
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(err.code === 'ENOENT'
          ? new EngineUnavailableError(`claude CLI not found ("${this.opts.bin}"). Install Claude Code or set "claudeBin" in ~/.manga-builder/config.json.`)
          : new TransientError(`claude could not start: ${err.message}`));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (!settled) acc.push(chunk); });
      child.on('close', (code) => {
        if (settled) return;
        try {
          finish(null, this.interpret(acc.end(), code, stderr));
        } catch (err) {
          finish(err as Error);
        }
      });
      child.stdin.on('error', () => { /* the child exited before reading stdin; 'close' or 'error' reports why */ });
      child.stdin.end(input, 'utf8');
    });
  }

  private interpret(state: ClaudeRunState, code: number | null, stderr: string): string {
    const text = state.result?.text ?? state.text;
    const failed = state.result ? state.result.isError : code !== 0;
    const blob = `${text}\n${stderr}`;
    if (failed && (state.rateLimit?.status === 'rejected' || /usage limit|hit your limit|rate limit/i.test(blob))) {
      const resetsAt = state.rateLimit?.resetsAt ? new Date(state.rateLimit.resetsAt * 1000).toISOString() : resetSuffix(blob);
      const reason = state.rateLimit ? `Claude quota exhausted (${state.rateLimit.rateLimitType} window)` : 'Claude quota exhausted';
      this.opts.onRateLimit?.(resetsAt, reason);
      throw new QuotaExceededError(resetsAt);
    }
    if (failed) {
      if (/not logged in|\/login|log ?in|authenticat|invalid api key|oauth|credential/i.test(blob)) throw new EngineUnavailableError(LOGIN_HINT);
      throw new TransientError(`claude failed${code !== null ? ` (exit ${code})` : ''}: ${blob.trim().slice(0, 500) || 'no output'}`);
    }
    return text;
  }

  private probe(): Promise<ServiceState> {
    mkdirSync(this.opts.cwd, { recursive: true });
    return new Promise<ServiceState>((resolve) => {
      let out = '';
      const child = spawn(this.opts.bin, [...(this.opts.binArgs ?? []), 'auth', 'status', '--json'], {
        ...HIDDEN, cwd: this.opts.cwd, shell: false, env: claudeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, detail: 'claude auth status did not answer within 10 s' });
      }, 10_000);
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: err.code === 'ENOENT' ? `claude CLI not found ("${this.opts.bin}")` : err.message });
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
          resolve(status.loggedIn ? { ok: true, detail: `logged in (${status.authMethod ?? 'unknown'})` } : { ok: false, detail: LOGIN_HINT });
        } catch {
          resolve({ ok: false, detail: `unexpected output from claude auth status: ${out.slice(0, 200)}` });
        }
      });
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/claude-engine.test.ts`
Expected: PASS — `Tests  12 passed (12)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/engines/claude.ts packages/server/test/claude-engine.test.ts packages/server/test/fakes/fake-claude.mjs
git commit -m "feat(server): ClaudeEngine spawning an isolated claude -p with toolset check and quota detection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: OllamaEngine — native `/api/chat`

**Files:**
- Create: `packages/server/src/engines/ollama.ts`
- Create: `packages/server/test/fakes/fake-ollama.ts`
- Test: `packages/server/test/ollama-engine.test.ts`

**Interfaces:**
- Consumes: `completeStructured`, `jsonSchemaOf` (Task 3), errors (Task 2), `GpuArbiter`, `PermanentError`, `TransientError`, `abortError`.
- Produces:
  - `interface OllamaEngineOptions { url: string; models: () => Settings['ollama']; gpu: GpuArbiter | null; keepAlive?: string; timeoutMs?: number; fetchImpl?: typeof fetch }`
  - `class OllamaEngine implements TextEngine` (`name = 'local'`) with `unload(): Promise<void>` (keep_alive 0 for every loaded model) and `health()`
  - test fake: `startFakeOllama(opts?: { models?: string[]; replies?: string[] }): Promise<FakeOllama>`; `FakeOllama { url; requests; replies; models; loaded: Set<string>; close() }`

- [ ] **Step 1: Write the fake ollama server**

```ts
// packages/server/test/fakes/fake-ollama.ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOllamaRequest { method: string; path: string; body: Record<string, unknown> | null }
export interface FakeOllama {
  url: string;
  requests: FakeOllamaRequest[];
  /** Answers for /api/chat, consumed in order; '{}' when empty. */
  replies: string[];
  /** Pulled models (/api/tags). */
  models: string[];
  /** Models currently loaded (/api/ps): added by /api/chat, removed by keep_alive 0. */
  loaded: Set<string>;
  close(): Promise<void>;
}

export async function startFakeOllama(opts: { models?: string[]; replies?: string[] } = {}): Promise<FakeOllama> {
  const requests: FakeOllamaRequest[] = [];
  const replies = [...(opts.replies ?? [])];
  const models = opts.models ?? ['qwen3:14b', 'qwen3-vl:8b'];
  const loaded = new Set<string>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      requests.push({ method: req.method ?? 'GET', path, body });
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const model = typeof body?.['model'] === 'string' ? body['model'] : '';
      if (path === '/api/tags') return json(200, { models: models.map((name) => ({ name, model: name })) });
      if (path === '/api/ps') return json(200, { models: [...loaded].map((name) => ({ name, model: name })) });
      if (path === '/api/chat') {
        if (!models.includes(model)) return json(404, { error: `model "${model}" not found, try pulling it first` });
        loaded.add(model);
        return json(200, { model, message: { role: 'assistant', content: replies.shift() ?? '{}' }, done: true });
      }
      if (path === '/api/generate') {
        if (body?.['keep_alive'] === 0) loaded.delete(model);
        return json(200, { model, response: '', done: true, done_reason: 'unload' });
      }
      return json(404, { error: 'no route' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, requests, replies, models, loaded,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/ollama-engine.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OllamaEngine } from '../src/engines/ollama.js';
import { EngineUnavailableError } from '../src/engines/errors.js';
import { GpuArbiter } from '../src/jobs/index.js';
import { startFakeOllama, type FakeOllama } from './fakes/fake-ollama.js';

let fo: FakeOllama;
beforeEach(async () => { fo = await startFakeOllama(); });
afterEach(async () => { await fo.close(); });

const models = (): { textModel: string; visionModel: string } => ({ textModel: 'qwen3:14b', visionModel: 'qwen3-vl:8b' });
const Scene = z.object({ scene: z.string() });
const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'SYS', prompt: 'Привіт', schema: Scene };
const engine = (over: Partial<ConstructorParameters<typeof OllamaEngine>[0]> = {}): OllamaEngine =>
  new OllamaEngine({ url: fo.url, models, gpu: null, ...over });

describe('OllamaEngine', () => {
  it('posts a native /api/chat request with a JSON-schema format and thinking off', async () => {
    fo.replies.push('{"scene":"solo"}');
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'solo' });
    const chat = fo.requests.find((r) => r.path === '/api/chat')!;
    expect(chat.body).toMatchObject({ model: 'qwen3:14b', stream: false, think: false, keep_alive: '10m' });
    expect((chat.body!['format'] as { properties: unknown }).properties).toEqual({ scene: { type: 'string' } });
    const messages = chat.body!['messages'] as Array<{ role: string; content: string; images?: string[] }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('SYS');
    expect(messages[1]).toEqual({ role: 'user', content: 'Привіт' });
  });

  it('sends images as base64 to the vision model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ollama-img-'));
    try {
      const image = join(dir, 'a.png');
      writeFileSync(image, Buffer.from([1, 2, 3]));
      fo.replies.push('{"scene":"x"}');
      await engine().completeJson({ ...req, images: [image] });
      const chat = fo.requests.find((r) => r.path === '/api/chat')!;
      expect(chat.body!['model']).toBe('qwen3-vl:8b');
      expect((chat.body!['messages'] as Array<{ images?: string[] }>)[1]!.images).toEqual(['AQID']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs one correction round through the same endpoint', async () => {
    fo.replies.push('nothing useful', '{"scene":"ok"}');
    await expect(engine().completeJson(req)).resolves.toEqual({ scene: 'ok' });
    expect(fo.requests.filter((r) => r.path === '/api/chat')).toHaveLength(2);
  });

  it('takes the GPU before asking', async () => {
    const gpu = new GpuArbiter();
    const freed: string[] = [];
    gpu.setReleaser('comfy', async () => { freed.push('comfy'); });
    await gpu.acquire('comfy');
    fo.replies.push('{"scene":"x"}');
    await engine({ gpu }).completeJson(req);
    expect(freed).toEqual(['comfy']);
    expect(gpu.current).toBe('ollama');
  });

  it('names a model that is not pulled', async () => {
    const err = await engine({ models: () => ({ textModel: 'qwen9:1b', visionModel: 'qwen3-vl:8b' }) }).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe('model qwen9:1b not pulled (run: ollama pull qwen9:1b)');
  });

  it('says where it looked when ollama is down', async () => {
    const err = await engine({ url: 'http://127.0.0.1:9' }).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe('ollama not reachable at http://127.0.0.1:9');
  });

  it('unloads only the models that are loaded', async () => {
    fo.loaded.add('qwen3:14b');
    await engine().unload();
    expect(fo.requests.filter((r) => r.path === '/api/generate').map((r) => r.body)).toEqual([{ model: 'qwen3:14b', keep_alive: 0 }]);
    expect(fo.loaded.size).toBe(0);
    await expect(engine({ url: 'http://127.0.0.1:9' }).unload()).resolves.toBeUndefined();
  });

  it('health lists the configured models or what is missing', async () => {
    await expect(engine().health()).resolves.toEqual({ ok: true, detail: 'qwen3:14b, qwen3-vl:8b' });
    fo.models.splice(1);
    await expect(engine().health()).resolves.toEqual({ ok: false, detail: 'model qwen3-vl:8b not pulled (run: ollama pull qwen3-vl:8b)' });
    await expect(engine({ url: 'http://127.0.0.1:9' }).health()).resolves.toEqual({ ok: false, detail: 'ollama not reachable at http://127.0.0.1:9' });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/ollama-engine.test.ts`
Expected: FAIL — `Failed to load url ../src/engines/ollama.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/src/engines/ollama.ts
import { readFile } from 'node:fs/promises';
import type { ServiceState, Settings } from '@manga/shared';
import { PermanentError, TransientError, type GpuArbiter } from '../jobs/index.js';
import { abortError } from '../util/abort.js';
import { EngineUnavailableError } from './errors.js';
import { completeStructured, jsonSchemaOf } from './structured.js';
import type { JsonRequest, TextEngine } from './types.js';

export interface OllamaEngineOptions {
  url: string;
  models: () => Settings['ollama'];
  /** Local LLM work shares the GPU with ComfyUI; null in unit tests. */
  gpu: GpuArbiter | null;
  keepAlive?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

interface ChatInput {
  format: Record<string, unknown>;
  images: string[] | undefined;
  signal: AbortSignal | undefined;
  onProgress: ((label: string) => void) | undefined;
}

/** Direct ollama calls: native /api/chat with `format: <JSON schema>`, `think: false`, `stream: false`. */
export class OllamaEngine implements TextEngine {
  readonly name = 'local' as const;

  constructor(private readonly opts: OllamaEngineOptions) {}

  private get url(): string {
    return this.opts.url.replace(/\/+$/, '');
  }

  private get http(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  completeJson<T>(req: JsonRequest<T>): Promise<T> {
    const format = jsonSchemaOf(req.schema);
    return completeStructured(
      ({ system, prompt }) => this.chat(system, prompt, { format, images: req.images, signal: req.signal, onProgress: req.onProgress }),
      req,
    );
  }

  /** Frees VRAM: a keep_alive 0 request for every model /api/ps reports as loaded. Never throws. */
  async unload(): Promise<void> {
    let loaded: string[];
    try {
      const res = await this.http(`${this.url}/api/ps`, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      loaded = (body.models ?? []).map((m) => m.model ?? m.name).filter((n): n is string => typeof n === 'string');
    } catch {
      return;
    }
    for (const model of loaded) {
      try {
        await this.http(`${this.url}/api/generate`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // ollama went away: nothing is loaded any more
      }
    }
  }

  async health(): Promise<ServiceState> {
    const { textModel, visionModel } = this.opts.models();
    let res: Response;
    try {
      res = await this.http(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      return { ok: false, detail: `ollama not reachable at ${this.url}` };
    }
    if (!res.ok) return { ok: false, detail: `ollama answered ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = new Set((body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string'));
    const missing = [...new Set([textModel, visionModel])].filter((m) => !names.has(m) && !names.has(`${m}:latest`));
    return missing.length === 0
      ? { ok: true, detail: `${textModel}, ${visionModel}` }
      : { ok: false, detail: `model ${missing.join(', ')} not pulled (run: ollama pull ${missing[0]})` };
  }

  private async chat(system: string, prompt: string, input: ChatInput): Promise<string> {
    await this.opts.gpu?.acquire('ollama');
    const { textModel, visionModel } = this.opts.models();
    const paths = input.images ?? [];
    const model = paths.length > 0 ? visionModel : textModel;
    const images = paths.length > 0 ? await Promise.all(paths.map(async (p) => (await readFile(p)).toString('base64'))) : null;
    input.onProgress?.(`Asking ${model}`);
    const body = {
      model, stream: false, think: false, keep_alive: this.opts.keepAlive ?? '10m', format: input.format,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt, ...(images ? { images } : {}) }],
    };
    const timeoutMs = this.opts.timeoutMs ?? 300_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.http(`${this.url}/api/chat`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
        signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
      });
    } catch {
      if (input.signal?.aborted) throw abortError(input.signal);
      if (timeout.aborted) throw new TransientError(`ollama did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new EngineUnavailableError(`ollama not reachable at ${this.url}`);
    }
    const text = await res.text();
    if (res.status === 404 && /not found/i.test(text)) throw new EngineUnavailableError(`model ${model} not pulled (run: ollama pull ${model})`);
    if (res.status >= 500) throw new TransientError(`ollama answered ${res.status}: ${text.slice(0, 300)}`);
    if (!res.ok) throw new PermanentError(`ollama answered ${res.status}: ${text.slice(0, 300)}`);
    let content: unknown;
    try {
      content = (JSON.parse(text) as { message?: { content?: unknown } }).message?.content;
    } catch {
      content = undefined;
    }
    if (typeof content !== 'string') throw new TransientError('ollama returned no message content');
    return content;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/ollama-engine.test.ts`
Expected: PASS — `Tests  8 passed (8)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/engines/ollama.ts packages/server/test/ollama-engine.test.ts packages/server/test/fakes/fake-ollama.ts
git commit -m "feat(server): OllamaEngine on native /api/chat with schema format, vision, unload and health" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: PNG encoder and PNG size reader

**Files:**
- Create: `packages/server/src/dev/png.ts`, `packages/server/src/imaging/png-size.ts`
- Test: `packages/server/test/png.test.ts`

**Interfaces:**
- Produces: `encodeSolidPng(width: number, height: number, rgb?: [number, number, number]): Uint8Array`, `crc32(bytes: Uint8Array): number`, `pngSize(bytes: Uint8Array): { width: number; height: number }`.

The encoder lives in `src/dev/` because the server itself uses it in `MANGA_FAKES=1` mode (FakeComfy answers with solid PNGs). `pngSize` is production code: `generateImage` records the real size of what ComfyUI returned.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/png.test.ts
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodeSolidPng } from '../src/dev/png.js';
import { pngSize } from '../src/imaging/png-size.js';

describe('PNG', () => {
  it('writes a valid PNG whose IHDR carries the size', () => {
    const png = encodeSolidPng(7, 5, [10, 20, 30]);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngSize(png)).toEqual({ width: 7, height: 5 });
  });

  it('stores the requested colour in every pixel', () => {
    const png = Buffer.from(encodeSolidPng(3, 2, [10, 20, 30]));
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(Array.from(raw)).toEqual([0, 10, 20, 30, 10, 20, 30, 10, 20, 30, 0, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects bad input', () => {
    expect(() => pngSize(new Uint8Array([1, 2, 3]))).toThrow('not a PNG');
    expect(() => encodeSolidPng(0, 5)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/png.test.ts`
Expected: FAIL — `Failed to load url ../src/dev/png.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/dev/png.ts
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A width×height, 8-bit RGB PNG filled with one colour. Pure TypeScript + node:zlib. */
export function encodeSolidPng(width: number, height: number, rgb: [number, number, number] = [128, 128, 128]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid PNG size ${width}x${height}`);
  }
  const row = Buffer.alloc(1 + width * 3); // filter byte 0, then RGB triples
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return new Uint8Array(Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
```

```ts
// packages/server/src/imaging/png-size.ts
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG image');
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') throw new Error('not a PNG image (no IHDR chunk)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/png.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dev/png.ts packages/server/src/imaging/png-size.ts packages/server/test/png.test.ts
git commit -m "feat(server): tiny PNG encoder for fakes and PNG size reader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: FakeComfy — in-process ComfyUI stand-in

**Files:**
- Create: `packages/server/src/imaging/comfy-graph.ts`
- Create: `packages/server/src/dev/fake-comfy.ts`
- Create: `packages/server/test/fakes/fake-comfy.ts` (re-export for tests)
- Test: `packages/server/test/fake-comfy.test.ts`

**Interfaces:**
- Consumes: `encodeSolidPng` (Task 8), `pngSize` (Task 8), `ws` (`WebSocketServer`).
- Produces:
  - `type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>` (Contract C.7), `type Link = [string, number]`, `nodesOf(graph, classType): Array<{ id: string; inputs: Record<string, unknown> }>`
  - `interface FakeComfy { url; graphs; promptIds; uploads: Map<string, Uint8Array>; calls: Array<{ method; path; body }>; up: boolean; rejectNext: { error; node_errors } | null; failNext: string | null; completionDelayMs: number; close(): Promise<void> }`
  - `startFakeComfy(): Promise<FakeComfy>`, `fakeOutputSize(graph, uploads): { width; height }`, `FAKE_COLOR`

Endpoints (spec §14): `GET /system_stats`, `POST /prompt`, `GET /history/:id`, `GET /view`, `POST /upload/image`, `POST /free`, `POST /interrupt`, `POST /queue`, `GET /object_info` (minimal), WebSocket `/ws?clientId=`. It emits `execution_start`, `executing` per node, `progress` 1..3 on sampler/upscale nodes, then `executing {node:null}` and `execution_success` — the same message types as ComfyUI 0.34.3 `execution.py`/`main.py`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/fake-comfy.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { encodeSolidPng } from '../src/dev/png.js';
import { pngSize } from '../src/imaging/png-size.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { fakeOutputSize, startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';

let fake: FakeComfy | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

describe('fakeOutputSize', () => {
  it('uses the latent node, else the loaded image scaled by upscalers', () => {
    const uploads = new Map([['manga-builder/a.png', encodeSolidPng(100, 80)]]);
    expect(fakeOutputSize({ '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1216, height: 832 } } }, uploads)).toEqual({ width: 1216, height: 832 });
    expect(fakeOutputSize({
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/a.png' } },
      '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0] } },
    }, uploads)).toEqual({ width: 100, height: 80 });
    expect(fakeOutputSize({
      '1': { class_type: 'LoadImage', inputs: { image: 'manga-builder/a.png' } },
      '2': { class_type: 'ImageUpscaleWithModel', inputs: { image: ['1', 0] } },
      '3': { class_type: 'ImageScaleBy', inputs: { image: ['2', 0], scale_by: 0.5 } },
    }, uploads)).toEqual({ width: 200, height: 160 });
  });
});

describe('FakeComfy', () => {
  it('runs a prompt to a PNG of the latent size and records the graph', async () => {
    fake = await startFakeComfy();
    const graph: ComfyGraph = {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 't' } },
    };
    const res = await fetch(`${fake.url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, prompt_id: 'p-1' }),
    });
    expect(await res.json()).toMatchObject({ prompt_id: 'p-1', node_errors: {} });
    let history: Record<string, { outputs: Record<string, { images: Array<{ filename: string }> }> }> = {};
    for (let i = 0; i < 100 && !history['p-1']; i++) {
      history = (await (await fetch(`${fake.url}/history/p-1`)).json()) as typeof history;
      await new Promise((r) => setTimeout(r, 10));
    }
    const filename = history['p-1']!.outputs['2']!.images[0]!.filename;
    const png = new Uint8Array(await (await fetch(`${fake.url}/view?filename=${filename}&type=output`)).arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 64, height: 48 });
    expect(fake.graphs).toEqual([graph]);
    expect(fake.promptIds).toEqual(['p-1']);
  });

  it('stores multipart uploads under subfolder/name', async () => {
    fake = await startFakeComfy();
    const form = new FormData();
    form.append('image', new Blob([encodeSolidPng(4, 4)], { type: 'image/png' }), 'im_a.png');
    form.append('subfolder', 'manga-builder');
    form.append('overwrite', 'true');
    const res = await fetch(`${fake.url}/upload/image`, { method: 'POST', body: form });
    expect(await res.json()).toEqual({ name: 'im_a.png', subfolder: 'manga-builder', type: 'input' });
    expect(pngSize(fake.uploads.get('manga-builder/im_a.png')!)).toEqual({ width: 4, height: 4 });
  });

  it('answers 503 everywhere while down and closes twice safely', async () => {
    fake = await startFakeComfy();
    fake.up = false;
    expect((await fetch(`${fake.url}/system_stats`)).status).toBe(503);
    await fake.close();
    await fake.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/fake-comfy.test.ts`
Expected: FAIL — `Failed to load url ./fakes/fake-comfy.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/imaging/comfy-graph.ts
/** ComfyUI API-format graph: node id → { class_type, inputs }. A link is [nodeId, outputSlot]. */
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type Link = [string, number];

export function nodesOf(graph: ComfyGraph, classType: string): Array<{ id: string; inputs: Record<string, unknown> }> {
  return Object.entries(graph)
    .filter(([, node]) => node.class_type === classType)
    .map(([id, node]) => ({ id, inputs: node.inputs }));
}
```

```ts
// packages/server/src/dev/fake-comfy.ts
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { ComfyGraph } from '../imaging/comfy-graph.js';
import { pngSize } from '../imaging/png-size.js';
import { encodeSolidPng } from './png.js';

export interface FakeComfyCall { method: string; path: string; body: unknown }
export interface FakeComfyRejection { error: unknown; node_errors: Record<string, unknown> }

export interface FakeComfy {
  readonly url: string;
  /** Every graph accepted by POST /prompt, in order. */
  readonly graphs: ComfyGraph[];
  readonly promptIds: string[];
  /** Uploaded input images keyed by 'subfolder/name' (or 'name'). */
  readonly uploads: Map<string, Uint8Array>;
  readonly calls: FakeComfyCall[];
  /** false → every HTTP route answers 503 and /ws is refused. */
  up: boolean;
  /** The next POST /prompt answers 400 with this body. */
  rejectNext: FakeComfyRejection | null;
  /** The next run ends with an execution_error carrying this exception message. */
  failNext: string | null;
  /** Extra delay before a run completes (to test cancel and crashes). */
  completionDelayMs: number;
  close(): Promise<void>;
}

type HistoryMessage = [string, Record<string, unknown>];
interface HistoryEntry {
  prompt: unknown[];
  outputs: Record<string, { images: Array<{ filename: string; subfolder: string; type: string }> }>;
  status: { status_str: 'success' | 'error'; completed: boolean; messages: HistoryMessage[] };
}

export const FAKE_COLOR: [number, number, number] = [180, 180, 180];
const LATENTS = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage']);
const WORKERS = new Set(['KSampler', 'SamplerCustomAdvanced', 'ImageUpscaleWithModel']);
const KNOWN_CLASSES = [
  'CheckpointLoaderSimple', 'LoraLoader', 'LoraLoaderModelOnly', 'CLIPSetLastLayer', 'CLIPTextEncode', 'EmptyLatentImage',
  'KSampler', 'VAEDecode', 'VAEEncode', 'SaveImage', 'LoadImage', 'ImageBatch', 'IPAdapterModelLoader', 'IPAdapterAdvanced',
  'PrepImageForClipVision', 'CLIPVisionLoader', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'UnetLoaderGGUF', 'UNETLoader',
  'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow', 'CFGNorm', 'TextEncodeQwenImageEditPlus', 'FluxKontextMultiReferenceLatentMethod',
  'ConditioningZeroOut', 'EmptySD3LatentImage', 'ImageScaleToTotalPixels', 'ReferenceLatent', 'CFGGuider', 'KSamplerSelect',
  'Flux2Scheduler', 'RandomNoise', 'EmptyFlux2LatentImage', 'SamplerCustomAdvanced', 'ModelPatchLoader', 'AnimaLLLiteApply',
  'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScaleBy',
];

/** The size a real run of `graph` would produce: the empty-latent size, else the loaded image × upscalers. */
export function fakeOutputSize(graph: ComfyGraph, uploads: ReadonlyMap<string, Uint8Array>): { width: number; height: number } {
  const nodes = Object.values(graph);
  const latent = nodes.find((n) => LATENTS.has(n.class_type));
  if (latent) return { width: Number(latent.inputs['width']), height: Number(latent.inputs['height']) };
  const load = nodes.find((n) => n.class_type === 'LoadImage');
  const bytes = load ? uploads.get(String(load.inputs['image'])) : undefined;
  let { width, height } = bytes ? pngSize(bytes) : { width: 512, height: 512 };
  if (nodes.some((n) => n.class_type === 'ImageUpscaleWithModel')) {
    width *= 4;
    height *= 4;
  }
  const scale = nodes.find((n) => n.class_type === 'ImageScaleBy');
  if (scale) {
    const factor = Number(scale.inputs['scale_by']);
    width = Math.round(width * factor);
    height = Math.round(height * factor);
  }
  return { width, height };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeComfyServer implements FakeComfy {
  url = '';
  readonly graphs: ComfyGraph[] = [];
  readonly promptIds: string[] = [];
  readonly uploads = new Map<string, Uint8Array>();
  readonly calls: FakeComfyCall[] = [];
  up = true;
  rejectNext: FakeComfyRejection | null = null;
  failNext: string | null = null;
  completionDelayMs = 0;
  private readonly history = new Map<string, HistoryEntry>();
  private readonly outputs = new Map<string, Uint8Array>();
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly server = createServer((req, res) => { void this.handle(req, res); });
  private readonly wss = new WebSocketServer({ noServer: true });
  private closed = false;
  private counter = 0;

  async listen(): Promise<void> {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (url.pathname !== '/ws' || !this.up) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const clientId = url.searchParams.get('clientId') ?? randomUUID();
        const set = this.clients.get(clientId) ?? new Set<WebSocket>();
        set.add(ws);
        this.clients.set(clientId, set);
        ws.on('close', () => set.delete(ws));
        ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId } }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const set of this.clients.values()) for (const ws of set) ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const raw = await readBody(req);
    const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
    let body: unknown = null;
    if (isJson && raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
    }
    this.calls.push({ method: req.method ?? 'GET', path: url.pathname, body });
    if (!this.up) return send(res, 503, { error: 'fake comfy is down' });
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /system_stats') {
      return send(res, 200, {
        system: { os: 'fake', comfyui_version: 'fake' },
        devices: [{ name: 'FakeGPU', type: 'cuda', index: 0, vram_total: 16e9, vram_free: 15e9 }],
      });
    }
    if (route === 'GET /object_info') {
      return send(res, 200, Object.fromEntries(KNOWN_CLASSES.map((c) => [c, { name: c, input: { required: {} } }])));
    }
    if (route === 'POST /upload/image') return this.upload(req, raw, res);
    if (route === 'POST /prompt') return this.prompt(body, res);
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const entry = this.history.get(id);
      return send(res, 200, entry ? { [id]: entry } : {});
    }
    if (route === 'GET /view') {
      const bytes = this.outputs.get(url.searchParams.get('filename') ?? '');
      if (!bytes) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(bytes);
      return;
    }
    if (route === 'POST /free' || route === 'POST /interrupt' || route === 'POST /queue') return send(res, 200);
    return send(res, 404, { error: `fake comfy has no route ${route}` });
  }

  private async upload(req: IncomingMessage, raw: Buffer, res: ServerResponse): Promise<void> {
    const form = await new Request('http://fake/upload/image', {
      method: 'POST', headers: { 'content-type': String(req.headers['content-type'] ?? '') }, body: new Uint8Array(raw),
    }).formData();
    const file = form.get('image');
    if (file === null || typeof file === 'string') return send(res, 400, { error: 'no image' });
    const subfolder = String(form.get('subfolder') ?? '');
    const key = subfolder ? `${subfolder}/${file.name}` : file.name;
    this.uploads.set(key, new Uint8Array(await file.arrayBuffer()));
    return send(res, 200, { name: file.name, subfolder, type: 'input' });
  }

  private prompt(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as { prompt?: ComfyGraph; client_id?: string; prompt_id?: string };
    if (this.rejectNext) {
      const rejection = this.rejectNext;
      this.rejectNext = null;
      return send(res, 400, rejection);
    }
    if (!b.prompt || typeof b.prompt !== 'object') {
      return send(res, 400, { error: { type: 'no_prompt', message: 'No prompt provided', details: '', extra_info: {} }, node_errors: {} });
    }
    const id = b.prompt_id ?? randomUUID();
    this.graphs.push(b.prompt);
    this.promptIds.push(id);
    send(res, 200, { prompt_id: id, number: this.counter++, node_errors: {} });
    void this.execute(id, b.prompt, b.client_id ?? '');
  }

  private emit(clientId: string, type: string, data: Record<string, unknown>): void {
    for (const ws of this.clients.get(clientId) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
    }
  }

  private async execute(id: string, graph: ComfyGraph, clientId: string): Promise<void> {
    const nodes = Object.entries(graph);
    this.emit(clientId, 'execution_start', { prompt_id: id });
    for (const [nodeId, node] of nodes) {
      this.emit(clientId, 'executing', { node: nodeId, display_node: nodeId, prompt_id: id });
      if (WORKERS.has(node.class_type)) {
        for (let step = 1; step <= 3; step++) {
          this.emit(clientId, 'progress', { value: step, max: 3, prompt_id: id, node: nodeId });
          await delay(2);
        }
      }
      await delay(2);
    }
    if (this.completionDelayMs > 0) await delay(this.completionDelayMs);
    await delay(25);
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      const failing = nodes.find(([, n]) => WORKERS.has(n.class_type)) ?? nodes[0];
      const error = {
        prompt_id: id, node_id: failing?.[0] ?? '?', node_type: failing?.[1].class_type ?? '?',
        exception_message: message, exception_type: 'RuntimeError',
      };
      this.history.set(id, { prompt: [], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', error]] } });
      this.emit(clientId, 'execution_error', error);
      return;
    }
    const save = nodes.find(([, n]) => n.class_type === 'SaveImage');
    const { width, height } = fakeOutputSize(graph, this.uploads);
    const filename = `fake_${String(this.outputs.size + 1).padStart(5, '0')}_.png`;
    this.outputs.set(filename, encodeSolidPng(width, height, FAKE_COLOR));
    this.history.set(id, {
      prompt: [],
      outputs: save ? { [save[0]]: { images: [{ filename, subfolder: '', type: 'output' }] } } : {},
      status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: id }]] },
    });
    this.emit(clientId, 'executing', { node: null, prompt_id: id });
    this.emit(clientId, 'execution_success', { prompt_id: id });
  }
}

export async function startFakeComfy(): Promise<FakeComfy> {
  const server = new FakeComfyServer();
  await server.listen();
  return server;
}
```

```ts
// packages/server/test/fakes/fake-comfy.ts
export { FAKE_COLOR, fakeOutputSize, startFakeComfy, type FakeComfy } from '../../src/dev/fake-comfy.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/fake-comfy.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/imaging/comfy-graph.ts packages/server/src/dev/fake-comfy.ts packages/server/test/fakes/fake-comfy.ts packages/server/test/fake-comfy.test.ts
git commit -m "feat(server): FakeComfy in-process HTTP and WebSocket stand-in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: ComfyLauncher — start ComfyUI detached

**Files:**
- Create: `packages/server/src/imaging/launcher.ts`
- Create: `packages/server/test/helpers/comfy-root.ts`
- Test: `packages/server/test/launcher.test.ts`

**Interfaces:**
- Consumes: `HIDDEN_DETACHED` (Task 2), `PermanentError`.
- Produces:
  - `interface ComfyLauncherOptions { comfyRoot: string; comfyUrl: string; timeoutMs?: number; pollMs?: number; spawnImpl?: typeof spawn }`
  - `class ComfyLauncher { readonly timeoutMs; readonly pollMs; readonly logPath; command(): { file; args; cwd }; start(): void }`
  - test helper `fakeComfyRoot(): string` (a temp folder with `ComfyUI/.venv/Scripts/python.exe` and `ComfyUI/main.py`)

Ported from `claude-image-gen/scripts/gen.py` `ensure_server()`: `<comfyRoot>/ComfyUI/.venv/Scripts/python.exe <comfyRoot>/ComfyUI/main.py --port <port> --listen 127.0.0.1 --fast`, cwd `<comfyRoot>/ComfyUI`, detached, output appended to `ComfyUI/server.log`, 240 s budget. Here `windowsHide` replaces Python's `DETACHED_PROCESS` (cleopatra: `detached` alone flashes a console).

- [ ] **Step 1: Write the helper and the failing test**

```ts
// packages/server/test/helpers/comfy-root.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temp comfyRoot that looks installed: ComfyUI/.venv/Scripts/python.exe and ComfyUI/main.py exist (empty). */
export function fakeComfyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'comfy-root-'));
  mkdirSync(join(root, 'ComfyUI', '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(root, 'ComfyUI', 'main.py'), '');
  return root;
}
```

```ts
// packages/server/test/launcher.test.ts
import type { SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComfyLauncher } from '../src/imaging/launcher.js';
import { fakeComfyRoot } from './helpers/comfy-root.js';

describe('ComfyLauncher', () => {
  it('builds the gen.py command line with the port from comfyUrl', () => {
    const root = fakeComfyRoot();
    const launcher = new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8190' });
    expect(launcher.command()).toEqual({
      file: join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
      args: [join(root, 'ComfyUI', 'main.py'), '--port', '8190', '--listen', '127.0.0.1', '--fast'],
      cwd: join(root, 'ComfyUI'),
    });
    expect(launcher.logPath).toBe(join(root, 'ComfyUI', 'server.log'));
    expect(launcher.timeoutMs).toBe(240_000);
    expect(new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1' }).command().args[2]).toBe('8188');
  });

  it('spawns detached and hidden, appending output to server.log', () => {
    const root = fakeComfyRoot();
    const calls: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawnImpl = ((file: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ file, args, options });
      return { unref() {}, on() { return this; } };
    }) as unknown as typeof spawn;
    new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8188', spawnImpl }).start();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ detached: true, windowsHide: true, cwd: join(root, 'ComfyUI') });
    const stdio = calls[0]!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(existsSync(join(root, 'ComfyUI', 'server.log'))).toBe(true);
  });

  it('refuses when ComfyUI is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-comfy-'));
    expect(() => new ComfyLauncher({ comfyRoot: root, comfyUrl: 'http://127.0.0.1:8188' }).start()).toThrow(/ComfyUI is not installed at/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/launcher.test.ts`
Expected: FAIL — `Failed to load url ../src/imaging/launcher.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/imaging/launcher.ts
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { PermanentError } from '../jobs/index.js';
import { HIDDEN_DETACHED } from '../util/hidden.js';

export interface ComfyLauncherOptions {
  comfyRoot: string;
  comfyUrl: string;
  timeoutMs?: number;
  pollMs?: number;
  spawnImpl?: typeof spawn;
}

/** Starts the shared claude-image-gen ComfyUI exactly as gen.py's ensure_server() does. */
export class ComfyLauncher {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly logPath: string;
  private readonly dir: string;
  private readonly python: string;
  private readonly main: string;
  private readonly port: string;
  private readonly spawnImpl: typeof spawn;

  constructor(opts: ComfyLauncherOptions) {
    this.dir = join(opts.comfyRoot, 'ComfyUI');
    this.python = join(this.dir, '.venv', 'Scripts', 'python.exe');
    this.main = join(this.dir, 'main.py');
    this.logPath = join(this.dir, 'server.log');
    this.port = new URL(opts.comfyUrl).port || '8188';
    this.timeoutMs = opts.timeoutMs ?? 240_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  command(): { file: string; args: string[]; cwd: string } {
    return { file: this.python, args: [this.main, '--port', this.port, '--listen', '127.0.0.1', '--fast'], cwd: this.dir };
  }

  /** Spawns and forgets: the server outlives this process so later images start warm. */
  start(): void {
    if (!existsSync(this.python) || !existsSync(this.main)) {
      throw new PermanentError(`ComfyUI is not installed at ${this.dir} (set "comfyRoot" in ~/.manga-builder/config.json)`);
    }
    const { file, args, cwd } = this.command();
    const log = openSync(this.logPath, 'a');
    try {
      const child = this.spawnImpl(file, args, { ...HIDDEN_DETACHED, cwd, stdio: ['ignore', log, log] });
      child.on('error', () => { /* surfaces as the health poll timing out, with the log path */ });
      child.unref();
    } finally {
      closeSync(log);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/launcher.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/imaging/launcher.ts packages/server/test/launcher.test.ts packages/server/test/helpers/comfy-root.ts
git commit -m "feat(server): ComfyLauncher starting the shared ComfyUI detached and hidden" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ComfyClient — HTTP + WebSocket client

**Files:**
- Create: `packages/server/src/imaging/comfy.ts`
- Test: `packages/server/test/comfy-client.test.ts`

**Interfaces:**
- Consumes: `ComfyGraph` (Task 9), `ComfyLauncher` (Task 10), `sleep`, `abortError` (Task 2), `PermanentError`, `TransientError`, `ws`.
- Produces (Contract C.7 + additive options):
  - `class ComfyClient { constructor(opts: { url: string; launcher?: ComfyLauncher | null; pollMs?: number }); readonly url; health(); ensureServer(onStatus?); uploadImage(absPath): Promise<string>; run(graph, opts?): Promise<{ promptId; images: Uint8Array[]; durationMs }>; free(); interrupt(promptId?) }`
  - `class ComfyRejectedError extends PermanentError { details: unknown }`
  - `stageLabel(classType): string`, `formatRejection(body): string`, `executionError(entry): string`, `UPLOAD_SUBFOLDER = 'manga-builder'`
  - re-export `type ComfyGraph`

Behaviour (spec §3.2, §7, §13): `/system_stats` health; `/upload/image` multipart (FormData + Blob) into `input/manga-builder/`; `/prompt` with a client-generated `prompt_id` (ComfyUI accepts a canonical UUID) and `client_id`; `/ws?clientId=` for progress only; `/history/{id}` polling decides completion; `/view` downloads outputs; network errors and 5xx → `TransientError`; HTTP 400 → `ComfyRejectedError` with the node errors; `execution_error` → `PermanentError`; abort → `POST /queue {delete:[id]}` + `POST /interrupt {prompt_id:id}`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/comfy-client.test.ts
import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyClient, ComfyRejectedError, stageLabel } from '../src/imaging/comfy.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { ComfyLauncher } from '../src/imaging/launcher.js';
import { pngSize } from '../src/imaging/png-size.js';
import { encodeSolidPng } from '../src/dev/png.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { fakeComfyRoot } from './helpers/comfy-root.js';

const miniGraph = (): ComfyGraph => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0], seed: 1, steps: 3, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'test' } },
});

let fake: FakeComfy;
let client: ComfyClient;
beforeEach(async () => {
  fake = await startFakeComfy();
  client = new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 });
});
afterEach(async () => { await fake.close(); });

type Step = { label: string; value?: number; max?: number };
const recorder = (): { steps: Step[]; onProgress: (label: string, value?: number, max?: number) => void } => {
  const steps: Step[] = [];
  return {
    steps,
    onProgress: (label, value, max) => { steps.push({ label, ...(value !== undefined ? { value } : {}), ...(max !== undefined ? { max } : {}) }); },
  };
};

describe('stageLabel', () => {
  it.each([
    ['CheckpointLoaderSimple', 'Loading model'], ['UnetLoaderGGUF', 'Loading model'], ['LoraLoaderModelOnly', 'Loading model'],
    ['IPAdapterModelLoader', 'Loading model'], ['KSampler', 'Sampling'], ['SamplerCustomAdvanced', 'Sampling'],
    ['VAEDecode', 'Decoding'], ['SaveImage', 'Saving'], ['ImageUpscaleWithModel', 'Upscaling'], ['CLIPTextEncode', 'Preparing'],
  ])('%s → %s', (classType, label) => expect(stageLabel(classType)).toBe(label));
});

describe('ComfyClient.run', () => {
  it('queues the graph, streams named progress and returns the PNG', async () => {
    const rec = recorder();
    const result = await client.run(miniGraph(), { onProgress: rec.onProgress });
    expect(result.promptId).toBe(fake.promptIds[0]);
    expect(result.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.images).toHaveLength(1);
    expect(pngSize(result.images[0]!)).toEqual({ width: 64, height: 48 });
    expect(rec.steps[0]).toEqual({ label: 'Queued' });
    expect(rec.steps.map((s) => s.label)).toContain('Loading model');
    expect(rec.steps).toContainEqual({ label: 'Sampling', value: 3, max: 3 });
    expect(fake.graphs).toEqual([miniGraph()]);
  });

  it('fails permanently with the node errors when ComfyUI rejects the graph', async () => {
    const body = {
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
      node_errors: { '4': { class_type: 'IPAdapterAdvanced', errors: [{ message: 'Value not in list', details: 'weight_type: bogus' }], dependent_outputs: [] } },
    };
    fake.rejectNext = body;
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyRejectedError);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('ComfyUI rejected the graph: Prompt outputs failed validation\nnode 4 (IPAdapterAdvanced): Value not in list: weight_type: bogus');
    expect((err as ComfyRejectedError).details).toEqual(body);
  });

  it('fails permanently when execution fails', async () => {
    fake.failNext = 'CUDA out of memory';
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('ComfyUI failed in KSampler (node 4): CUDA out of memory');
  });

  it('turns a vanished server mid-run into a TransientError', async () => {
    fake.completionDelayMs = 3_000;
    const run = client.run(miniGraph());
    setTimeout(() => { void fake.close(); }, 150);
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
  });

  it('cancels only its own prompt', async () => {
    fake.completionDelayMs = 5_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(client.run(miniGraph(), { signal: controller.signal })).rejects.toThrow();
    const id = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: id } });
  });

  it('reports an unreachable server as transient', async () => {
    const dead = new ComfyClient({ url: 'http://127.0.0.1:9', launcher: null, pollMs: 20 });
    await expect(dead.run(miniGraph())).rejects.toBeInstanceOf(TransientError);
  });
});

describe('ComfyClient helpers', () => {
  it('uploads into input/manga-builder and returns the LoadImage name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comfy-up-'));
    try {
      const file = join(dir, 'im_upload0001.png');
      writeFileSync(file, encodeSolidPng(8, 6));
      await expect(client.uploadImage(file)).resolves.toBe('manga-builder/im_upload0001.png');
      expect(pngSize(fake.uploads.get('manga-builder/im_upload0001.png')!)).toEqual({ width: 8, height: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frees VRAM with unload_models and free_memory, and never throws when down', async () => {
    await client.free();
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/free', body: { unload_models: true, free_memory: true } });
    await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).free()).resolves.toBeUndefined();
  });

  it('health shows the GPU, or why it is not ok', async () => {
    await expect(client.health()).resolves.toEqual({ ok: true, detail: 'FakeGPU · 15.0 GB free' });
    fake.up = false;
    await expect(client.health()).resolves.toEqual({ ok: false, detail: 'ComfyUI answered 503' });
    await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).health()).resolves.toEqual({ ok: false, detail: 'not reachable at http://127.0.0.1:9' });
  });
});

describe('ComfyClient.ensureServer', () => {
  const stubSpawn = (onStart: () => void): typeof spawn =>
    ((): unknown => {
      onStart();
      return { unref() {}, on() { return this; } };
    }) as unknown as typeof spawn;

  it('does nothing when the server is up', async () => {
    const labels: string[] = [];
    await client.ensureServer((l) => labels.push(l));
    expect(labels).toEqual([]);
  });

  it('is transient without a launcher', async () => {
    fake.up = false;
    await expect(client.ensureServer()).rejects.toBeInstanceOf(TransientError);
  });

  it('starts ComfyUI through the launcher and waits for it', async () => {
    fake.up = false;
    const launcher = new ComfyLauncher({ comfyRoot: fakeComfyRoot(), comfyUrl: fake.url, pollMs: 20, spawnImpl: stubSpawn(() => setTimeout(() => { fake.up = true; }, 100)) });
    const labels: string[] = [];
    await new ComfyClient({ url: fake.url, launcher, pollMs: 20 }).ensureServer((l) => labels.push(l));
    expect(labels).toEqual(['Starting image server']);
  });

  it('gives up after the launcher timeout and names the log', async () => {
    fake.up = false;
    const root = fakeComfyRoot();
    const launcher = new ComfyLauncher({ comfyRoot: root, comfyUrl: fake.url, pollMs: 20, timeoutMs: 600, spawnImpl: stubSpawn(() => {}) });
    const err = await new ComfyClient({ url: fake.url, launcher }).ensureServer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe(`ComfyUI did not come up within 1 s. See ${join(root, 'ComfyUI', 'server.log')}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/comfy-client.test.ts`
Expected: FAIL — `Failed to load url ../src/imaging/comfy.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/imaging/comfy.ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import WebSocket from 'ws';
import type { ServiceState } from '@manga/shared';
import { PermanentError, TransientError } from '../jobs/index.js';
import { abortError, sleep } from '../util/abort.js';
import type { ComfyGraph } from './comfy-graph.js';
import type { ComfyLauncher } from './launcher.js';

export type { ComfyGraph } from './comfy-graph.js';

/** Uploads land in ComfyUI/input/manga-builder/<imageId>.png (overwrite: image ids are unique). */
export const UPLOAD_SUBFOLDER = 'manga-builder';

export interface ComfyRunOptions {
  signal?: AbortSignal;
  onProgress?: (label: string, value?: number, max?: number) => void;
}
export interface ComfyRunResult { promptId: string; images: Uint8Array[]; durationMs: number }

/** ComfyUI refused the graph at validation (HTTP 400). Never retried; `details` is the raw body. */
export class ComfyRejectedError extends PermanentError {
  constructor(message: string, readonly details: unknown) {
    super(message);
    this.name = 'ComfyRejectedError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const LOADER = /Loader(Simple|GGUF|ModelOnly)?$/;
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced']);

/** Maps the node ComfyUI is executing to the status shown to the user (spec §7). */
export function stageLabel(classType: string): string {
  if (LOADER.test(classType)) return 'Loading model';
  if (SAMPLERS.has(classType)) return 'Sampling';
  if (classType === 'VAEDecode') return 'Decoding';
  if (classType === 'SaveImage') return 'Saving';
  if (classType === 'ImageUpscaleWithModel') return 'Upscaling';
  return 'Preparing';
}

interface NodeError { class_type?: string; errors?: Array<{ message?: string; details?: string }> }

export function formatRejection(body: unknown): string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: { message?: string; details?: string }; node_errors?: Record<string, NodeError> };
  const lines = [`ComfyUI rejected the graph: ${b.error?.message ?? 'unknown error'}${b.error?.details ? ` (${b.error.details})` : ''}`];
  for (const [id, nodeError] of Object.entries(b.node_errors ?? {})) {
    const reasons = (nodeError.errors ?? []).map((e) => [e.message, e.details].filter(Boolean).join(': ')).join('; ');
    lines.push(`node ${id} (${nodeError.class_type ?? '?'}): ${reasons}`);
  }
  return lines.join('\n');
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
}

export function executionError(entry: HistoryEntry): string {
  const error = entry.status?.messages?.find(([type]) => type === 'execution_error')?.[1];
  if (!error) return 'ComfyUI reported an error without details';
  return `ComfyUI failed in ${String(error['node_type'] ?? '?')} (node ${String(error['node_id'] ?? '?')}): ${String(error['exception_message'] ?? '').trim()}`;
}

export class ComfyClient {
  readonly url: string;
  private readonly launcher: ComfyLauncher | null;
  private readonly pollMs: number;
  private starting: Promise<void> | null = null;

  constructor(opts: { url: string; launcher?: ComfyLauncher | null; pollMs?: number }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.launcher = opts.launcher ?? null;
    this.pollMs = opts.pollMs ?? 400;
  }

  async health(): Promise<ServiceState> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      return { ok: false, detail: this.launcher ? 'not running (starts automatically on the first image)' : `not reachable at ${this.url}` };
    }
    if (!res.ok) return { ok: false, detail: `ComfyUI answered ${res.status}` };
    const stats = (await res.json()) as { devices?: Array<{ name?: string; vram_free?: number }> };
    const device = stats.devices?.[0];
    return { ok: true, detail: device ? `${device.name ?? 'GPU'} · ${((device.vram_free ?? 0) / 1e9).toFixed(1)} GB free` : 'running' };
  }

  async ensureServer(onStatus?: (label: string) => void): Promise<void> {
    if (await this.isUp()) return;
    const launcher = this.launcher;
    if (!launcher) throw new TransientError(`ComfyUI is not reachable at ${this.url}`);
    this.starting ??= (async (): Promise<void> => {
      onStatus?.('Starting image server');
      launcher.start();
      const deadline = Date.now() + launcher.timeoutMs;
      while (Date.now() < deadline) {
        await sleep(launcher.pollMs);
        if (await this.isUp()) return;
      }
      throw new PermanentError(`ComfyUI did not come up within ${Math.round(launcher.timeoutMs / 1000)} s. See ${launcher.logPath}`);
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  async uploadImage(absPath: string): Promise<string> {
    const bytes = await readFile(absPath);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), basename(absPath));
    form.append('subfolder', UPLOAD_SUBFOLDER);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form });
    if (!res.ok) throw new PermanentError(`ComfyUI refused the upload of ${basename(absPath)}: HTTP ${res.status}`);
    const body = (await res.json()) as { name: string; subfolder?: string };
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  async run(graph: ComfyGraph, opts: ComfyRunOptions = {}): Promise<ComfyRunResult> {
    const { signal, onProgress } = opts;
    if (signal?.aborted) throw abortError(signal);
    const clientId = randomUUID();
    const promptId = randomUUID();
    const started = Date.now();
    let last = '';
    const say = (label: string, value?: number, max?: number): void => {
      if (value === undefined && label === last) return;
      last = label;
      onProgress?.(label, value, max);
    };
    const socket = await this.openSocket(clientId);
    socket?.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: { type?: string; data?: { prompt_id?: string; node?: unknown; value?: unknown; max?: unknown } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      const d = message.data;
      if (!d || d.prompt_id !== promptId || typeof d.node !== 'string') return;
      const classType = graph[d.node]?.class_type ?? '';
      if (message.type === 'executing') say(stageLabel(classType));
      else if (message.type === 'progress' && typeof d.value === 'number' && typeof d.max === 'number') {
        say(classType === 'ImageUpscaleWithModel' ? 'Upscaling' : 'Sampling', d.value, d.max);
      }
    });
    try {
      say('Queued');
      const res = await this.request('/prompt', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
      });
      if (res.status === 400) {
        const body: unknown = await res.json().catch(() => null);
        throw new ComfyRejectedError(formatRejection(body), body);
      }
      if (!res.ok) throw new PermanentError(`ComfyUI answered ${res.status} on /prompt`);
      const entry = await this.waitForHistory(promptId, signal);
      const images = await this.fetchOutputs(entry);
      if (images.length === 0) throw new PermanentError('ComfyUI finished without producing an image');
      return { promptId, images, durationMs: Date.now() - started };
    } catch (err) {
      if (signal?.aborted) {
        await this.cancelPrompt(promptId);
        throw abortError(signal);
      }
      throw err;
    } finally {
      socket?.close();
    }
  }

  /** POST /free {unload_models, free_memory}. Never throws: a stopped ComfyUI holds no VRAM. */
  async free(): Promise<void> {
    try {
      await fetch(`${this.url}/free`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // not running: nothing to free
    }
  }

  /** With a prompt id ComfyUI interrupts only that prompt, and only if it is the one running. */
  async interrupt(promptId?: string): Promise<void> {
    try {
      await fetch(`${this.url}/interrupt`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(promptId ? { prompt_id: promptId } : {}), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // best effort
    }
  }

  private async isUp(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TransientError(`ComfyUI not reachable at ${this.url} (${(err as Error).message})`);
    }
    if (res.status >= 500) throw new TransientError(`ComfyUI answered ${res.status} on ${path}`);
    return res;
  }

  private async waitForHistory(promptId: string, signal: AbortSignal | undefined): Promise<HistoryEntry> {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const res = await this.request(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' });
      const body = (await res.json()) as Record<string, HistoryEntry>;
      const entry = body[promptId];
      if (entry) {
        if (entry.status?.status_str === 'error') throw new PermanentError(executionError(entry));
        if (entry.status?.completed || entry.status?.status_str === 'success') return entry;
      }
      await sleep(this.pollMs, signal);
    }
  }

  private async fetchOutputs(entry: HistoryEntry): Promise<Uint8Array[]> {
    const images: Uint8Array[] = [];
    for (const node of Object.values(entry.outputs ?? {})) {
      for (const image of node.images ?? []) {
        if ((image.type ?? 'output') !== 'output') continue;
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: 'output' });
        const res = await this.request(`/view?${query.toString()}`, { method: 'GET' }, 120_000);
        if (!res.ok) throw new TransientError(`ComfyUI could not serve ${image.filename}: HTTP ${res.status}`);
        images.push(new Uint8Array(await res.arrayBuffer()));
      }
    }
    return images;
  }

  private async cancelPrompt(promptId: string): Promise<void> {
    try {
      await fetch(`${this.url}/queue`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // best effort
    }
    await this.interrupt(promptId);
  }

  /** Progress only; completion is decided by /history, so a missing socket costs labels, not results. */
  private openSocket(clientId: string): Promise<WebSocket | null> {
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 5_000);
      ws.once('open', () => {
        clearTimeout(timer);
        ws.on('error', () => { /* the run continues without progress */ });
        resolve(ws);
      });
      ws.once('error', () => { clearTimeout(timer); resolve(null); });
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/comfy-client.test.ts`
Expected: PASS — `Tests  23 passed (23)` (10 `stageLabel` cases, 6 `run`, 3 helpers, 4 `ensureServer`).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/imaging/comfy.ts packages/server/test/comfy-client.test.ts
git commit -m "feat(server): ComfyClient with WebSocket progress, history polling, uploads, cancel and auto-start" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Recipe infrastructure and the SDXL recipes (`anime`, `anime-ref`, `anime-pose`, `anime-refine`)

**Files:**
- Create: `packages/server/src/imaging/recipes/types.ts`, `graph.ts`, `models.ts`, `sdxl.ts`
- Create: `packages/server/src/imaging/recipes/anime.ts`, `anime-ref.ts`, `anime-pose.ts`, `anime-refine.ts`
- Create: `packages/server/test/helpers/graph.ts`
- Test: `packages/server/test/recipes-sdxl.test.ts`

**Interfaces:**
- Consumes: `ComfyGraph`, `Link`, `nodesOf` (Task 9); `SDXL_SIZES`, `LoraRef`, `RecipeInfo` (`@manga/shared`).
- Produces (Contract C.7):
  - `interface RecipeParams { prompt; negative; width; height; seed; steps; cfg; loras; refs: string[]; refWeight; control: { kind: 'pose'|'lineart'; image; strength } | null; init: { image; denoise } | null; upscale: 2|4|null; filenamePrefix }`
  - `interface Recipe { id; label; family: 'sdxl'|'qwen'|'flux2'|'anima'|'upscale'; maxRefs; requiresRefs; supportsPose; supportsLineart; supportsLoras; supportsInit; defaults: { steps; cfg }; sizes; build(p): ComfyGraph }`
  - `class RecipeInputError extends Error`, `recipeInfo(r: Recipe): RecipeInfo`
  - `class GraphBuilder { graph; add(classType, inputs): string }`, `out(id, slot = 0): Link`
  - `MODELS` (every model file name), `SDXL_DEFAULTS`, `SDXL_SAMPLER`, `SDXL_SCHEDULER`, `CLIP_SKIP`, `IPADAPTER`, `buildSdxl`, `addIpAdapter`
  - `anime`, `animeRef`, `animePose`, `animeRefine: Recipe`
  - test helpers `params(over?)`, `classes(graph)`, `one(graph, classType)`, `source(graph, link)`, `expectLinked(graph)`

Node class and input names were checked against ComfyUI 0.34.3 (`ComfyUI/nodes.py`: `CheckpointLoaderSimple`, `LoraLoader`, `CLIPSetLastLayer.stop_at_clip_layer`, `ControlNetLoader.control_net_name`, `ControlNetApplyAdvanced(positive, negative, control_net, image, strength, start_percent, end_percent, vae?)`, `KSampler`, `VAEEncode(pixels, vae)`, `LoadImage.image`, `ImageBatch(image1, image2)`, `CLIPVisionLoader.clip_name`) and ComfyUI_IPAdapter_plus `IPAdapterPlus.py` on GitHub (`IPAdapterModelLoader.ipadapter_file`; `IPAdapterAdvanced(model, ipadapter, image, weight, weight_type, combine_embeds, start_at, end_at, embeds_scaling, image_negative?, attn_mask?, clip_vision?)`; `PrepImageForClipVision(image, interpolation, crop_position, sharpening)`). `IPAdapterModelLoader` does not bundle a CLIP vision model, so `clip_vision` is wired explicitly.

- [ ] **Step 1: Compare with P1's smoke-verified graphs — P1 wins**

P1 (`claude-image-gen`) is implemented before M2 and its graphs were smoke-run on this GPU. Open:

```bash
ls /c/Users/roman/Dev/Exalink/claude-image-gen/scripts/imagegen/graph.py /c/Users/roman/Dev/Exalink/claude-image-gen/scripts/imagegen/presets.py /c/Users/roman/Dev/Exalink/claude-image-gen/docs/BAKEOFF.md /c/Users/roman/Dev/Exalink/claude-image-gen/output/smoke/results.json
```

If any of these is missing, stop: P1 is not done and M2 must wait (contracts: P1 → M1 → M2).

In `graph.py`, read the checkpoint/`anime` builder with `--lora`, `--ref`, `--pose`, `--init` and `--style`. For each, write down (in your scratch notes, not in the repo): the node `class_type` list and wiring order, and every literal — `steps`, `cfg`, `sampler_name`, `scheduler`, CLIP skip, LoRA strengths, IP-Adapter `weight` default, `weight_type`, `combine_embeds`, `embeds_scaling`, `start_at`/`end_at`, how several references are combined (batch vs chained adapters), `PrepImageForClipVision` settings, ControlNet `strength` default and `start_percent`/`end_percent`, img2img `denoise`. Compare with the constants and code in Step 3 (`SDXL_DEFAULTS`, `SDXL_SAMPLER`, `SDXL_SCHEDULER`, `CLIP_SKIP`, `IPADAPTER`, `buildSdxl`, `addIpAdapter`) and with `DEFAULT_REF_WEIGHT = 0.7` and `REFINE_DENOISE = 0.3` (Tasks 15 and 17). **Where they differ, P1 wins:** change the TypeScript in Step 3 and the matching expectation in Step 2's test before running anything, and list each change in this task's commit message (`P1 alignment: …`).

Also read `docs/BAKEOFF.md`'s recommended default recipe per case (colour vs B&W; 0 / 1 / 2+ characters; drift fallback). If it differs from `DEFAULT_SETTINGS.routing` (`noChars: 'anime'`, `oneChar: 'anime-ref'`, `multiChar: 'qwen-edit-ref'`, `bwRefine: 'anime-refine'`, `driftFallback: 'qwen-edit-ref'`), update `DEFAULT_SETTINGS.routing` in `packages/shared/src/schemas.ts` **and** the same literal in `docs/superpowers/plans/2026-09-27-00-contracts.md` (A.2), and adjust the expectations in Task 14's route test that use `DEFAULT_SETTINGS`.

- [ ] **Step 2: Write the test helpers and the failing test**

```ts
// packages/server/test/helpers/graph.ts
import { expect } from 'vitest';
import { nodesOf, type ComfyGraph } from '../../src/imaging/comfy-graph.js';
import type { RecipeParams } from '../../src/imaging/recipes/types.js';

export function params(over: Partial<RecipeParams> = {}): RecipeParams {
  return {
    prompt: 'POS', negative: 'NEG', width: 832, height: 1216, seed: 42, steps: 10, cfg: 5, loras: [], refs: [], refWeight: 0.7,
    control: null, init: null, upscale: null, filenamePrefix: 'manga-builder/test', ...over,
  };
}

export function classes(graph: ComfyGraph): string[] {
  return Object.values(graph).map((n) => n.class_type).sort();
}

export function one(graph: ComfyGraph, classType: string): { id: string; inputs: Record<string, unknown> } {
  const found = nodesOf(graph, classType);
  expect(found, classType).toHaveLength(1);
  return found[0]!;
}

/** class_type of the node a link points at. */
export function source(graph: ComfyGraph, link: unknown): string {
  const [id] = link as [string, number];
  return graph[id]!.class_type;
}

/** Every [nodeId, slot] input points at a node that exists. */
export function expectLinked(graph: ComfyGraph): void {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
        expect(graph[value[0]], `${id}.${key} → ${value[0]}`).toBeDefined();
      }
    }
  }
}
```

```ts
// packages/server/test/recipes-sdxl.test.ts
import { describe, expect, it } from 'vitest';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { anime } from '../src/imaging/recipes/anime.js';
import { animeRef } from '../src/imaging/recipes/anime-ref.js';
import { animePose } from '../src/imaging/recipes/anime-pose.js';
import { animeRefine } from '../src/imaging/recipes/anime-refine.js';
import { RecipeInputError, recipeInfo } from '../src/imaging/recipes/types.js';
import { classes, expectLinked, one, params, source } from './helpers/graph.js';

describe('anime', () => {
  it('builds WAI Illustrious with CLIP skip 2 and a KSampler', () => {
    const g = anime.build(params());
    expectLinked(g);
    expect(classes(g)).toEqual(['CheckpointLoaderSimple', 'CLIPSetLastLayer', 'CLIPTextEncode', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'].sort());
    expect(one(g, 'CheckpointLoaderSimple').inputs).toEqual({ ckpt_name: 'waiIllustriousSDXL_v170.safetensors' });
    expect(one(g, 'CLIPSetLastLayer').inputs['stop_at_clip_layer']).toBe(-2);
    expect(nodesOf(g, 'CLIPTextEncode').map((n) => n.inputs['text'])).toEqual(['POS', 'NEG']);
    expect(one(g, 'EmptyLatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(one(g, 'KSampler').inputs).toMatchObject({ seed: 42, steps: 10, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1 });
    expect(one(g, 'SaveImage').inputs['filename_prefix']).toBe('manga-builder/test');
    expect(anime).toMatchObject({ family: 'sdxl', maxRefs: 0, supportsLoras: true, supportsInit: true, defaults: { steps: 28, cfg: 5.5 } });
  });

  it('chains LoRAs on model and clip', () => {
    const g = anime.build(params({ loras: [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: 0.5 }] }));
    expectLinked(g);
    const loras = nodesOf(g, 'LoraLoader');
    expect(loras.map((l) => [l.inputs['lora_name'], l.inputs['strength_model'], l.inputs['strength_clip']])).toEqual([['a.safetensors', 0.8, 0.8], ['b.safetensors', 0.5, 0.5]]);
    expect(loras[1]!.inputs['model']).toEqual([loras[0]!.id, 0]);
    expect(loras[1]!.inputs['clip']).toEqual([loras[0]!.id, 1]);
    expect(one(g, 'KSampler').inputs['model']).toEqual([loras[1]!.id, 0]);
    expect(one(g, 'CLIPSetLastLayer').inputs['clip']).toEqual([loras[1]!.id, 1]);
  });

  it('does img2img from an init image', () => {
    const g = anime.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 0.35 } }));
    expectLinked(g);
    expect(nodesOf(g, 'EmptyLatentImage')).toHaveLength(0);
    expect(one(g, 'LoadImage').inputs).toEqual({ image: 'manga-builder/im_a.png' });
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs['denoise']).toBe(0.35);
    expect(source(g, sampler.inputs['latent_image'])).toBe('VAEEncode');
  });
});

describe('anime-ref', () => {
  it('adds noobIPA through IPAdapterAdvanced fed by a batch of prepared references', () => {
    const g = animeRef.build(params({ refs: ['manga-builder/im_p.png', 'manga-builder/im_f.png'] }));
    expectLinked(g);
    expect(one(g, 'IPAdapterModelLoader').inputs).toEqual({ ipadapter_file: 'noobIPAMARK1_mark1.safetensors' });
    expect(one(g, 'CLIPVisionLoader').inputs).toEqual({ clip_name: 'CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors' });
    expect(nodesOf(g, 'LoadImage').map((n) => n.inputs['image'])).toEqual(['manga-builder/im_p.png', 'manga-builder/im_f.png']);
    for (const prep of nodesOf(g, 'PrepImageForClipVision')) {
      expect(prep.inputs).toMatchObject({ interpolation: 'LANCZOS', crop_position: 'pad', sharpening: 0 });
    }
    const batch = one(g, 'ImageBatch');
    const adapter = one(g, 'IPAdapterAdvanced');
    expect(adapter.inputs).toMatchObject({ weight: 0.7, weight_type: 'linear', combine_embeds: 'average', start_at: 0, end_at: 1, embeds_scaling: 'V only' });
    expect(adapter.inputs['image']).toEqual([batch.id, 0]);
    expect(source(g, adapter.inputs['clip_vision'])).toBe('CLIPVisionLoader');
    expect(source(g, adapter.inputs['ipadapter'])).toBe('IPAdapterModelLoader');
    expect(one(g, 'KSampler').inputs['model']).toEqual([adapter.id, 0]);
  });

  it('uses a single reference without a batch node', () => {
    const g = animeRef.build(params({ refs: ['manga-builder/im_p.png'] }));
    expectLinked(g);
    expect(nodesOf(g, 'ImageBatch')).toHaveLength(0);
    expect(source(g, one(g, 'IPAdapterAdvanced').inputs['image'])).toBe('PrepImageForClipVision');
  });

  it('needs a reference', () => {
    expect(() => animeRef.build(params())).toThrow(RecipeInputError);
  });

  it('describes itself for the API', () => {
    expect(recipeInfo(animeRef)).toEqual({
      id: 'anime-ref', label: 'Anime + reference (noobIPA)', maxRefs: 2, requiresRefs: true,
      supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: false,
    });
  });
});

describe('anime-pose', () => {
  it('applies noob_openpose through ControlNetApplyAdvanced on both conditionings', () => {
    const g = animePose.build(params({ control: { kind: 'pose', image: 'manga-builder/im_pose.png', strength: 0.8 } }));
    expectLinked(g);
    expect(one(g, 'ControlNetLoader').inputs).toEqual({ control_net_name: 'noob_openpose_pre.safetensors' });
    const apply = one(g, 'ControlNetApplyAdvanced');
    expect(apply.inputs).toMatchObject({ strength: 0.8, start_percent: 0, end_percent: 1 });
    expect(source(g, apply.inputs['image'])).toBe('LoadImage');
    expect(source(g, apply.inputs['vae'])).toBe('CheckpointLoaderSimple');
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs['positive']).toEqual([apply.id, 0]);
    expect(sampler.inputs['negative']).toEqual([apply.id, 1]);
    expect(nodesOf(g, 'IPAdapterAdvanced')).toHaveLength(0);
  });

  it('can add references on top of the pose', () => {
    const g = animePose.build(params({ refs: ['manga-builder/im_p.png'], control: { kind: 'pose', image: 'manga-builder/im_pose.png', strength: 0.8 } }));
    expectLinked(g);
    expect(nodesOf(g, 'IPAdapterAdvanced')).toHaveLength(1);
  });

  it('needs a pose image', () => {
    expect(() => animePose.build(params())).toThrow('needs a pose image');
  });
});

describe('anime-refine', () => {
  it('is img2img only and keeps the style LoRA', () => {
    expect(() => animeRefine.build(params())).toThrow('needs an input image');
    const g = animeRefine.build(params({
      init: { image: 'manga-builder/im_q.png', denoise: 0.3 }, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }],
    }));
    expectLinked(g);
    expect(one(g, 'KSampler').inputs['denoise']).toBe(0.3);
    expect(one(g, 'LoraLoader').inputs['lora_name']).toBe('Mnga-illustriousXL_v01_V1-CAME.safetensors');
    expect(nodesOf(g, 'EmptyLatentImage')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/recipes-sdxl.test.ts`
Expected: FAIL — `Failed to load url ../src/imaging/recipes/anime.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/src/imaging/recipes/types.ts
import type { LoraRef, RecipeInfo } from '@manga/shared';
import type { ComfyGraph } from '../comfy-graph.js';

export interface RecipeParams {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  loras: LoraRef[];
  /** ComfyUI input names returned by ComfyClient.uploadImage. */
  refs: string[];
  refWeight: number;
  control: { kind: 'pose' | 'lineart'; image: string; strength: number } | null;
  init: { image: string; denoise: number } | null;
  upscale: 2 | 4 | null;
  filenamePrefix: string;
}

export interface Recipe {
  id: string;
  label: string;
  family: 'sdxl' | 'qwen' | 'flux2' | 'anima' | 'upscale';
  maxRefs: number;
  requiresRefs: boolean;
  supportsPose: boolean;
  supportsLineart: boolean;
  supportsLoras: boolean;
  supportsInit: boolean;
  defaults: { steps: number; cfg: number };
  sizes: Array<[number, number]>;
  build(p: RecipeParams): ComfyGraph;
}

/** A recipe was given inputs it cannot build from (no reference, no pose image, …). */
export class RecipeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeInputError';
  }
}

export function recipeInfo(r: Recipe): RecipeInfo {
  return {
    id: r.id, label: r.label, maxRefs: r.maxRefs, requiresRefs: r.requiresRefs, supportsPose: r.supportsPose,
    supportsLineart: r.supportsLineart, supportsLoras: r.supportsLoras, supportsInit: r.supportsInit,
  };
}
```

```ts
// packages/server/src/imaging/recipes/graph.ts
import type { ComfyGraph, Link } from '../comfy-graph.js';

/** Builds an API-format graph with sequential string ids '1', '2', … in insertion order. */
export class GraphBuilder {
  readonly graph: ComfyGraph = {};
  private next = 1;

  add(classType: string, inputs: Record<string, unknown>): string {
    const id = String(this.next);
    this.next += 1;
    this.graph[id] = { class_type: classType, inputs };
    return id;
  }
}

export function out(id: string, slot = 0): Link {
  return [id, slot];
}
```

```ts
// packages/server/src/imaging/recipes/models.ts
/** File names under claude-image-gen/models/<folder>/ (never copied into this repo). */
export const MODELS = {
  waiCheckpoint: 'waiIllustriousSDXL_v170.safetensors', // checkpoints/
  noobIpa: 'noobIPAMARK1_mark1.safetensors', // ipadapter/
  clipVisionBigG: 'CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors', // clip_vision/
  noobOpenpose: 'noob_openpose_pre.safetensors', // controlnet/
  animeSharp: '4x-AnimeSharp.safetensors', // upscale_models/
  qwenEditGguf: 'qwen-image-edit-2511-Q5_K_M.gguf', // unet/
  qwenEditLightning: 'Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors', // loras/
  qwenVlEncoder: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', // text_encoders/
  qwenImageVae: 'qwen_image_vae.safetensors', // vae/ (Qwen Edit and Anima)
  animaAesthetic: 'anima-aesthetic-v1.1.safetensors', // diffusion_models/
  animaTurbo: 'anima-turbo-v1.1.safetensors', // diffusion_models/
  animaEncoder: 'qwen_3_06b_base.safetensors', // text_encoders/
  animaPose: 'anima-lllite-pose-1.safetensors', // model_patches/
  animaLineart: 'anima-lllite-lineart-1.safetensors', // model_patches/
  klein: 'flux-2-klein-4b-fp8.safetensors', // diffusion_models/
  kleinEncoder: 'qwen_3_4b.safetensors', // text_encoders/
  flux2Vae: 'flux2-vae.safetensors', // vae/
} as const;
```

```ts
// packages/server/src/imaging/recipes/sdxl.ts
import type { ComfyGraph, Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type RecipeParams } from './types.js';

/** WAI-illustrious v17 settings from the P1 design (§4.4): 28 steps, cfg 5.5, euler_ancestral/normal, CLIP skip 2. */
export const SDXL_DEFAULTS = { steps: 28, cfg: 5.5 } as const;
export const SDXL_SAMPLER = 'euler_ancestral';
export const SDXL_SCHEDULER = 'normal';
export const CLIP_SKIP = -2;
export const IPADAPTER = {
  weightType: 'linear',
  combineEmbeds: 'average',
  embedsScaling: 'V only',
  interpolation: 'LANCZOS',
  cropPosition: 'pad',
} as const;

export interface SdxlFeatures {
  ipAdapter: 'none' | 'optional' | 'required';
  pose: 'none' | 'required';
  init: 'none' | 'optional' | 'required';
}

/** noobIPA on WAI: each reference is prepared for CLIP vision, then batched and averaged. */
export function addIpAdapter(g: GraphBuilder, model: Link, refs: string[], weight: number): Link {
  const ipadapter = g.add('IPAdapterModelLoader', { ipadapter_file: MODELS.noobIpa });
  const clipVision = g.add('CLIPVisionLoader', { clip_name: MODELS.clipVisionBigG });
  let batch: Link | null = null;
  for (const ref of refs.slice(0, 2)) {
    const loaded = g.add('LoadImage', { image: ref });
    const prepared = out(g.add('PrepImageForClipVision', {
      image: out(loaded), interpolation: IPADAPTER.interpolation, crop_position: IPADAPTER.cropPosition, sharpening: 0,
    }));
    batch = batch ? out(g.add('ImageBatch', { image1: batch, image2: prepared })) : prepared;
  }
  if (!batch) throw new RecipeInputError('IP-Adapter needs at least one reference image');
  return out(g.add('IPAdapterAdvanced', {
    model, ipadapter: out(ipadapter), image: batch, weight, weight_type: IPADAPTER.weightType,
    combine_embeds: IPADAPTER.combineEmbeds, start_at: 0, end_at: 1, embeds_scaling: IPADAPTER.embedsScaling, clip_vision: out(clipVision),
  }));
}

export function buildSdxl(id: string, p: RecipeParams, f: SdxlFeatures): ComfyGraph {
  if (f.ipAdapter === 'required' && p.refs.length === 0) throw new RecipeInputError(`${id} needs 1-2 reference images`);
  if (f.pose === 'required' && p.control?.kind !== 'pose') throw new RecipeInputError(`${id} needs a pose image`);
  if (f.init === 'required' && !p.init) throw new RecipeInputError(`${id} needs an input image`);

  const g = new GraphBuilder();
  const checkpoint = g.add('CheckpointLoaderSimple', { ckpt_name: MODELS.waiCheckpoint });
  let model = out(checkpoint, 0);
  let clip = out(checkpoint, 1);
  const vae = out(checkpoint, 2);
  for (const lora of p.loras) {
    const loader = g.add('LoraLoader', { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength });
    model = out(loader, 0);
    clip = out(loader, 1);
  }
  clip = out(g.add('CLIPSetLastLayer', { clip, stop_at_clip_layer: CLIP_SKIP }));
  if (f.ipAdapter !== 'none' && p.refs.length > 0) model = addIpAdapter(g, model, p.refs, p.refWeight);

  let positive = out(g.add('CLIPTextEncode', { text: p.prompt, clip }));
  let negative = out(g.add('CLIPTextEncode', { text: p.negative, clip }));
  if (f.pose !== 'none' && p.control?.kind === 'pose') {
    const controlNet = g.add('ControlNetLoader', { control_net_name: MODELS.noobOpenpose });
    const pose = g.add('LoadImage', { image: p.control.image });
    const apply = g.add('ControlNetApplyAdvanced', {
      positive, negative, control_net: out(controlNet), image: out(pose), strength: p.control.strength, start_percent: 0, end_percent: 1, vae,
    });
    positive = out(apply, 0);
    negative = out(apply, 1);
  }

  let latent: Link;
  let denoise = 1;
  if (f.init !== 'none' && p.init) {
    const init = g.add('LoadImage', { image: p.init.image });
    latent = out(g.add('VAEEncode', { pixels: out(init), vae }));
    denoise = p.init.denoise;
  } else {
    latent = out(g.add('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 }));
  }
  const sampled = g.add('KSampler', {
    model, seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: SDXL_SAMPLER, scheduler: SDXL_SCHEDULER,
    positive, negative, latent_image: latent, denoise,
  });
  const decoded = g.add('VAEDecode', { samples: out(sampled), vae });
  g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
  return g.graph;
}
```

```ts
// packages/server/src/imaging/recipes/anime.ts
import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const anime: Recipe = {
  id: 'anime', label: 'Anime (WAI Illustrious)', family: 'sdxl',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: true,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime', p, { ipAdapter: 'none', pose: 'none', init: 'optional' }),
};
```

```ts
// packages/server/src/imaging/recipes/anime-ref.ts
import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const animeRef: Recipe = {
  id: 'anime-ref', label: 'Anime + reference (noobIPA)', family: 'sdxl',
  maxRefs: 2, requiresRefs: true, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: false,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-ref', p, { ipAdapter: 'required', pose: 'none', init: 'none' }),
};
```

```ts
// packages/server/src/imaging/recipes/anime-pose.ts
import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const animePose: Recipe = {
  id: 'anime-pose', label: 'Anime + pose (OpenPose)', family: 'sdxl',
  maxRefs: 2, requiresRefs: false, supportsPose: true, supportsLineart: false, supportsLoras: true, supportsInit: false,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-pose', p, { ipAdapter: 'optional', pose: 'required', init: 'none' }),
};
```

```ts
// packages/server/src/imaging/recipes/anime-refine.ts
import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

/** WAI img2img at low denoise with the manga LoRA: restores ink and screentone after qwen-edit-ref / klein-ref. */
export const animeRefine: Recipe = {
  id: 'anime-refine', label: 'Anime refine (img2img)', family: 'sdxl',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: true,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-refine', p, { ipAdapter: 'none', pose: 'none', init: 'required' }),
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/recipes-sdxl.test.ts`
Expected: PASS — `Tests  11 passed (11)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/imaging/recipes packages/server/test/helpers/graph.ts packages/server/test/recipes-sdxl.test.ts
git commit -m "feat(server): recipe infrastructure and SDXL recipes (anime, anime-ref, anime-pose, anime-refine)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 1 changed anything, add a second `-m "P1 alignment: <each change>"` before the Co-Authored-By `-m`.

---

### Task 13: Qwen-Edit, klein, Anima and upscale recipes; the `RECIPES` table

**Files:**
- Create: `packages/server/src/imaging/recipes/qwen-edit-ref.ts`, `klein-ref.ts`, `anima.ts`, `anima-turbo.ts`, `upscale.ts`, `index.ts`
- Test: `packages/server/test/recipes-other.test.ts`

**Interfaces:**
- Consumes: Task 12's `GraphBuilder`, `out`, `MODELS`, `Recipe`, `RecipeInputError`, test helpers.
- Produces: `qwenEditRef`, `kleinRef`, `anima`, `animaTurbo`, `upscale: Recipe`; `QWEN_EDIT`, `KLEIN`, `ANIMA` constants; `buildAnima(unetName, p)`; `RECIPES: Record<string, Recipe>` with exactly the contract ids `anime, anime-ref, anime-pose, qwen-edit-ref, klein-ref, anima, anima-turbo, anime-refine, upscale`; re-exports `recipeInfo`, `RecipeInputError`, `Recipe`, `RecipeParams`.

Sources checked (ComfyUI 0.34.3 install and its bundled templates in `ComfyUI/.venv/Lib/site-packages/comfyui_workflow_templates_json/templates/`):
- `image_qwen_image_edit_2511.json`: `UNETLoader → ModelSamplingAuraFlow(shift 3.1) → CFGNorm(strength 1) → LoraLoaderModelOnly(Lightning)`, `CLIPLoader(type 'qwen_image')`, `TextEncodeQwenImageEditPlus(clip, prompt, vae, image1..3)` → `FluxKontextMultiReferenceLatentMethod('index_timestep_zero')`, `KSampler(euler, simple)`. The Q5 GGUF needs `UnetLoaderGGUF(unet_name)` from `custom_nodes/ComfyUI-GGUF/nodes.py`. The template takes its latent from `VAEEncode(image1)`; this plan uses `EmptySD3LatentImage(width, height)` so the output matches the panel aspect (unverified at runtime — Step 1 and Task 24 check it).
- `image_flux2_klein_image_edit_4b_distilled.json`: `UNETLoader`, `CLIPLoader(type 'flux2')`, `VAELoader(flux2-vae)`, per reference `LoadImage → ImageScaleToTotalPixels('nearest-exact', 1, 1) → VAEEncode → ReferenceLatent` on both the prompt conditioning and its `ConditioningZeroOut`, `CFGGuider(cfg 1)`, `KSamplerSelect(euler)`, `Flux2Scheduler(steps 4, width, height)`, `RandomNoise(noise_seed)`, `EmptyFlux2LatentImage`, `SamplerCustomAdvanced`.
- `image_anima_base_v1.json` and `image_anima_lllite_any_control_to_image.json`: `UNETLoader`, `CLIPLoader(qwen_3_06b_base, type 'stable_diffusion')`, `VAELoader(qwen_image_vae)`, `EmptyLatentImage`, `KSampler(30 steps, cfg 4, euler, simple)`; turbo 8 steps at cfg 1; `ModelPatchLoader(name)` + `AnimaLLLiteApply(model, model_patch, image, strength, start_percent, end_percent, mask?)` from `comfy_extras/nodes_model_patch.py`.
- `comfy_extras/nodes_upscale_model.py`: `UpscaleModelLoader(model_name)`, `ImageUpscaleWithModel(upscale_model, image)`; `nodes.py`: `ImageScaleBy(image, upscale_method, scale_by)`.

- [ ] **Step 1: Compare with P1's smoke-verified graphs — P1 wins**

In `/c/Users/roman/Dev/Exalink/claude-image-gen/scripts/imagegen/graph.py`, read the gguf (`qwen-edit`), flux2 (`klein`), anima (with `--pose`/`--lineart`/`--style anima-manga`) and `--upscale` builders. Write down each node list and every literal (shift, CFGNorm strength, Lightning LoRA strength, reference method, latent node used for edit models, sampler/scheduler/steps/cfg, `ImageScaleToTotalPixels` settings, CLIP types, LLLite strength and percents, upscale 2× method) and compare with `QWEN_EDIT`, `KLEIN`, `ANIMA`, the `defaults` of each recipe below and the builders' wiring. **Where they differ, P1 wins:** edit the code in Step 4 and the expectations in Step 2 first, and list the changes in the commit message. Pay particular attention to the edit-model latent: if P1 had to use `VAEEncode(image1)` plus a resize instead of `EmptySD3LatentImage`, copy P1's arrangement.

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/recipes-other.test.ts
import { describe, expect, it } from 'vitest';
import { SDXL_SIZES } from '@manga/shared';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { qwenEditRef } from '../src/imaging/recipes/qwen-edit-ref.js';
import { kleinRef } from '../src/imaging/recipes/klein-ref.js';
import { anima } from '../src/imaging/recipes/anima.js';
import { animaTurbo } from '../src/imaging/recipes/anima-turbo.js';
import { upscale } from '../src/imaging/recipes/upscale.js';
import { RECIPES, RecipeInputError, type RecipeParams } from '../src/imaging/recipes/index.js';
import { expectLinked, one, params, source } from './helpers/graph.js';

describe('qwen-edit-ref', () => {
  it('builds Qwen-Image-Edit-2511 Q5 GGUF + Lightning 8-step with up to three pictures', () => {
    const g = qwenEditRef.build(params({ refs: ['manga-builder/a.png', 'manga-builder/b.png', 'manga-builder/c.png', 'manga-builder/d.png'], steps: 8, cfg: 1 }));
    expectLinked(g);
    expect(one(g, 'UnetLoaderGGUF').inputs).toEqual({ unet_name: 'qwen-image-edit-2511-Q5_K_M.gguf' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'qwen_image_vae.safetensors' });
    expect(one(g, 'ModelSamplingAuraFlow').inputs['shift']).toBe(3.1);
    expect(one(g, 'CFGNorm').inputs['strength']).toBe(1);
    expect(one(g, 'LoraLoaderModelOnly').inputs).toMatchObject({ lora_name: 'Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors', strength_model: 1 });
    const encode = one(g, 'TextEncodeQwenImageEditPlus');
    expect(encode.inputs['prompt']).toBe('POS');
    expect(source(g, encode.inputs['vae'])).toBe('VAELoader');
    expect(['image1', 'image2', 'image3'].map((k) => g[(encode.inputs[k] as [string, number])[0]]!.inputs['image']))
      .toEqual(['manga-builder/a.png', 'manga-builder/b.png', 'manga-builder/c.png']);
    expect(encode.inputs['image4']).toBeUndefined();
    expect(one(g, 'FluxKontextMultiReferenceLatentMethod').inputs['reference_latents_method']).toBe('index_timestep_zero');
    expect(one(g, 'EmptySD3LatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs).toMatchObject({ seed: 42, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
    expect(source(g, sampler.inputs['model'])).toBe('LoraLoaderModelOnly');
    expect(source(g, sampler.inputs['positive'])).toBe('FluxKontextMultiReferenceLatentMethod');
    expect(source(g, sampler.inputs['negative'])).toBe('ConditioningZeroOut');
    expect(qwenEditRef).toMatchObject({ family: 'qwen', maxRefs: 3, requiresRefs: true, supportsLoras: false, defaults: { steps: 8, cfg: 1 } });
  });

  it('needs a reference', () => {
    expect(() => qwenEditRef.build(params())).toThrow(RecipeInputError);
  });
});

describe('klein-ref', () => {
  it('builds FLUX.2 klein 4B with one ReferenceLatent pair per reference', () => {
    const g = kleinRef.build(params({ refs: ['manga-builder/a.png', 'manga-builder/b.png'], steps: 4, cfg: 1 }));
    expectLinked(g);
    expect(one(g, 'UNETLoader').inputs).toEqual({ unet_name: 'flux-2-klein-4b-fp8.safetensors', weight_dtype: 'default' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'flux2-vae.safetensors' });
    expect(nodesOf(g, 'ImageScaleToTotalPixels').map((n) => n.inputs)).toEqual([
      expect.objectContaining({ upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 }),
      expect.objectContaining({ upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 }),
    ]);
    expect(nodesOf(g, 'ReferenceLatent')).toHaveLength(4);
    const guider = one(g, 'CFGGuider');
    expect(guider.inputs['cfg']).toBe(1);
    expect(source(g, guider.inputs['positive'])).toBe('ReferenceLatent');
    expect(source(g, guider.inputs['negative'])).toBe('ReferenceLatent');
    expect(one(g, 'Flux2Scheduler').inputs).toEqual({ steps: 4, width: 832, height: 1216 });
    expect(one(g, 'RandomNoise').inputs).toEqual({ noise_seed: 42 });
    expect(one(g, 'KSamplerSelect').inputs).toEqual({ sampler_name: 'euler' });
    expect(one(g, 'EmptyFlux2LatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(source(g, one(g, 'VAEDecode').inputs['samples'])).toBe('SamplerCustomAdvanced');
    expect(kleinRef).toMatchObject({ family: 'flux2', maxRefs: 4, requiresRefs: false, defaults: { steps: 4, cfg: 1 } });
  });

  it('works without references as text-to-image', () => {
    const g = kleinRef.build(params());
    expectLinked(g);
    expect(nodesOf(g, 'ReferenceLatent')).toHaveLength(0);
    expect(source(g, one(g, 'CFGGuider').inputs['positive'])).toBe('CLIPTextEncode');
  });
});

describe('anima and anima-turbo', () => {
  it('builds Anima with its own text encoder and the Qwen VAE', () => {
    const g = anima.build(params());
    expectLinked(g);
    expect(one(g, 'UNETLoader').inputs).toEqual({ unet_name: 'anima-aesthetic-v1.1.safetensors', weight_dtype: 'default' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'qwen_image_vae.safetensors' });
    expect(one(g, 'EmptyLatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(one(g, 'KSampler').inputs).toMatchObject({ sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
    expect(anima).toMatchObject({ family: 'anima', supportsPose: true, supportsLineart: true, supportsLoras: true, defaults: { steps: 30, cfg: 4 } });
  });

  it('applies an LLLite pose or lineart patch to the model', () => {
    const pose = anima.build(params({ control: { kind: 'pose', image: 'manga-builder/pose.png', strength: 0.8 } }));
    expectLinked(pose);
    expect(one(pose, 'ModelPatchLoader').inputs).toEqual({ name: 'anima-lllite-pose-1.safetensors' });
    const apply = one(pose, 'AnimaLLLiteApply');
    expect(apply.inputs).toMatchObject({ strength: 0.8, start_percent: 0, end_percent: 1 });
    expect(source(pose, apply.inputs['model_patch'])).toBe('ModelPatchLoader');
    expect(source(pose, one(pose, 'KSampler').inputs['model'])).toBe('AnimaLLLiteApply');
    const lineart = anima.build(params({ control: { kind: 'lineart', image: 'manga-builder/line.png', strength: 0.6 } }));
    expect(one(lineart, 'ModelPatchLoader').inputs).toEqual({ name: 'anima-lllite-lineart-1.safetensors' });
  });

  it('takes style LoRAs on model and clip', () => {
    const g = anima.build(params({ loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] }));
    expectLinked(g);
    const lora = one(g, 'LoraLoader');
    expect(lora.inputs).toMatchObject({ lora_name: 'Mangalike_Anima.safetensors', strength_model: 0.8, strength_clip: 0.8 });
    expect(source(g, one(g, 'KSampler').inputs['model'])).toBe('LoraLoader');
  });

  it('turbo uses the turbo weights and 8 steps at cfg 1', () => {
    const g = animaTurbo.build(params());
    expect(one(g, 'UNETLoader').inputs['unet_name']).toBe('anima-turbo-v1.1.safetensors');
    expect(animaTurbo.defaults).toEqual({ steps: 8, cfg: 1 });
  });
});

describe('upscale', () => {
  it('runs 4x-AnimeSharp, and halves it for 2x', () => {
    const four = upscale.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 1 }, upscale: 4 }));
    expectLinked(four);
    expect(one(four, 'UpscaleModelLoader').inputs).toEqual({ model_name: '4x-AnimeSharp.safetensors' });
    expect(source(four, one(four, 'SaveImage').inputs['images'])).toBe('ImageUpscaleWithModel');
    expect(nodesOf(four, 'ImageScaleBy')).toHaveLength(0);
    const two = upscale.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 1 }, upscale: 2 }));
    expect(one(two, 'ImageScaleBy').inputs).toMatchObject({ upscale_method: 'lanczos', scale_by: 0.5 });
    expect(source(two, one(two, 'SaveImage').inputs['images'])).toBe('ImageScaleBy');
    expect(() => upscale.build(params())).toThrow('needs an input image');
  });
});

describe('RECIPES', () => {
  const valid: Record<string, Partial<RecipeParams>> = {
    anime: {}, 'anime-ref': { refs: ['r.png'] }, 'anime-pose': { control: { kind: 'pose', image: 'p.png', strength: 0.8 } },
    'qwen-edit-ref': { refs: ['r.png'] }, 'klein-ref': {}, anima: {}, 'anima-turbo': {},
    'anime-refine': { init: { image: 'i.png', denoise: 0.3 } }, upscale: { init: { image: 'i.png', denoise: 1 }, upscale: 4 },
  };

  it('has exactly the contract recipe ids', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(Object.keys(valid).sort());
    for (const [id, recipe] of Object.entries(RECIPES)) expect(recipe.id).toBe(id);
  });

  it.each(Object.keys(valid))('%s builds a linked, serialisable graph with one SaveImage', (id) => {
    const recipe = RECIPES[id]!;
    const g = recipe.build(params(valid[id]));
    expectLinked(g);
    expect(nodesOf(g, 'SaveImage')).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    expect(recipe.sizes).toEqual(id === 'upscale' ? [] : SDXL_SIZES);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/recipes-other.test.ts`
Expected: FAIL — `Failed to load url ../src/imaging/recipes/qwen-edit-ref.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/src/imaging/recipes/qwen-edit-ref.ts
import { SDXL_SIZES } from '@manga/shared';
import type { Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type Recipe } from './types.js';

/** From ComfyUI's image_qwen_image_edit_2511 template, with the Q5 GGUF and the 8-step Lightning LoRA. */
export const QWEN_EDIT = { shift: 3.1, cfgNorm: 1, loraStrength: 1, sampler: 'euler', scheduler: 'simple', referenceMethod: 'index_timestep_zero' } as const;

export const qwenEditRef: Recipe = {
  id: 'qwen-edit-ref', label: 'Qwen Image Edit 2511 (1-3 references)', family: 'qwen',
  maxRefs: 3, requiresRefs: true, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
  defaults: { steps: 8, cfg: 1 }, sizes: SDXL_SIZES,
  build(p) {
    if (p.refs.length === 0) throw new RecipeInputError('qwen-edit-ref needs 1-3 reference images');
    const g = new GraphBuilder();
    const unet = g.add('UnetLoaderGGUF', { unet_name: MODELS.qwenEditGguf });
    const clip = g.add('CLIPLoader', { clip_name: MODELS.qwenVlEncoder, type: 'qwen_image', device: 'default' });
    const vae = g.add('VAELoader', { vae_name: MODELS.qwenImageVae });
    const shifted = g.add('ModelSamplingAuraFlow', { model: out(unet), shift: QWEN_EDIT.shift });
    const normed = g.add('CFGNorm', { model: out(shifted), strength: QWEN_EDIT.cfgNorm });
    const model = g.add('LoraLoaderModelOnly', { model: out(normed), lora_name: MODELS.qwenEditLightning, strength_model: QWEN_EDIT.loraStrength });
    const pictures: Record<string, Link> = {};
    p.refs.slice(0, 3).forEach((ref, i) => {
      pictures[`image${i + 1}`] = out(g.add('LoadImage', { image: ref }));
    });
    const encoded = g.add('TextEncodeQwenImageEditPlus', { clip: out(clip), prompt: p.prompt, vae: out(vae), ...pictures });
    const positive = g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: out(encoded), reference_latents_method: QWEN_EDIT.referenceMethod });
    // cfg 1: ComfyUI skips the unconditional pass, so a zeroed negative costs nothing (gen.py does the same for CFG-1 models).
    const negative = g.add('ConditioningZeroOut', { conditioning: out(positive) });
    const latent = g.add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 });
    const sampled = g.add('KSampler', {
      model: out(model), seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: QWEN_EDIT.sampler, scheduler: QWEN_EDIT.scheduler,
      positive: out(positive), negative: out(negative), latent_image: out(latent), denoise: 1,
    });
    const decoded = g.add('VAEDecode', { samples: out(sampled), vae: out(vae) });
    g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
```

```ts
// packages/server/src/imaging/recipes/klein-ref.ts
import { SDXL_SIZES } from '@manga/shared';
import type { Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import type { Recipe } from './types.js';

/** From ComfyUI's image_flux2_klein_image_edit_4b_distilled template. */
export const KLEIN = { sampler: 'euler', scaleMethod: 'nearest-exact', megapixels: 1 } as const;

export const kleinRef: Recipe = {
  id: 'klein-ref', label: 'FLUX.2 klein 4B (references)', family: 'flux2',
  maxRefs: 4, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
  defaults: { steps: 4, cfg: 1 }, sizes: SDXL_SIZES,
  build(p) {
    const g = new GraphBuilder();
    const unet = g.add('UNETLoader', { unet_name: MODELS.klein, weight_dtype: 'default' });
    const clip = g.add('CLIPLoader', { clip_name: MODELS.kleinEncoder, type: 'flux2', device: 'default' });
    const vae = g.add('VAELoader', { vae_name: MODELS.flux2Vae });
    const text = g.add('CLIPTextEncode', { text: p.prompt, clip: out(clip) });
    let positive: Link = out(text);
    let negative: Link = out(g.add('ConditioningZeroOut', { conditioning: out(text) }));
    for (const ref of p.refs.slice(0, 4)) {
      const loaded = g.add('LoadImage', { image: ref });
      const scaled = g.add('ImageScaleToTotalPixels', { image: out(loaded), upscale_method: KLEIN.scaleMethod, megapixels: KLEIN.megapixels, resolution_steps: 1 });
      const latent = g.add('VAEEncode', { pixels: out(scaled), vae: out(vae) });
      positive = out(g.add('ReferenceLatent', { conditioning: positive, latent: out(latent) }));
      negative = out(g.add('ReferenceLatent', { conditioning: negative, latent: out(latent) }));
    }
    const guider = g.add('CFGGuider', { model: out(unet), positive, negative, cfg: p.cfg });
    const sampler = g.add('KSamplerSelect', { sampler_name: KLEIN.sampler });
    const sigmas = g.add('Flux2Scheduler', { steps: p.steps, width: p.width, height: p.height });
    const noise = g.add('RandomNoise', { noise_seed: p.seed });
    const empty = g.add('EmptyFlux2LatentImage', { width: p.width, height: p.height, batch_size: 1 });
    const sampled = g.add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sigmas), latent_image: out(empty) });
    const decoded = g.add('VAEDecode', { samples: out(sampled, 0), vae: out(vae) });
    g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
```

```ts
// packages/server/src/imaging/recipes/anima.ts
import { SDXL_SIZES } from '@manga/shared';
import type { ComfyGraph } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import type { Recipe, RecipeParams } from './types.js';

/** From ComfyUI's image_anima_base_v1 and image_anima_lllite_any_control_to_image templates. */
export const ANIMA = { sampler: 'euler', scheduler: 'simple', clipType: 'stable_diffusion' } as const;

export function buildAnima(unetName: string, p: RecipeParams): ComfyGraph {
  const g = new GraphBuilder();
  const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' });
  const clipLoader = g.add('CLIPLoader', { clip_name: MODELS.animaEncoder, type: ANIMA.clipType, device: 'default' });
  const vae = g.add('VAELoader', { vae_name: MODELS.qwenImageVae });
  let model = out(unet);
  let clip = out(clipLoader);
  for (const lora of p.loras) {
    const loader = g.add('LoraLoader', { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength });
    model = out(loader, 0);
    clip = out(loader, 1);
  }
  if (p.control) {
    const patch = g.add('ModelPatchLoader', { name: p.control.kind === 'pose' ? MODELS.animaPose : MODELS.animaLineart });
    const guide = g.add('LoadImage', { image: p.control.image });
    model = out(g.add('AnimaLLLiteApply', {
      model, model_patch: out(patch), image: out(guide), strength: p.control.strength, start_percent: 0, end_percent: 1,
    }));
  }
  const positive = g.add('CLIPTextEncode', { text: p.prompt, clip });
  const negative = g.add('CLIPTextEncode', { text: p.negative, clip });
  const latent = g.add('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 });
  const sampled = g.add('KSampler', {
    model, seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: ANIMA.sampler, scheduler: ANIMA.scheduler,
    positive: out(positive), negative: out(negative), latent_image: out(latent), denoise: 1,
  });
  const decoded = g.add('VAEDecode', { samples: out(sampled), vae: out(vae) });
  g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
  return g.graph;
}

export const anima: Recipe = {
  id: 'anima', label: 'Anima (aesthetic v1.1)', family: 'anima',
  maxRefs: 0, requiresRefs: false, supportsPose: true, supportsLineart: true, supportsLoras: true, supportsInit: false,
  defaults: { steps: 30, cfg: 4 }, sizes: SDXL_SIZES,
  build: (p) => buildAnima(MODELS.animaAesthetic, p),
};
```

```ts
// packages/server/src/imaging/recipes/anima-turbo.ts
import { SDXL_SIZES } from '@manga/shared';
import { buildAnima } from './anima.js';
import { MODELS } from './models.js';
import type { Recipe } from './types.js';

export const animaTurbo: Recipe = {
  id: 'anima-turbo', label: 'Anima Turbo (v1.1)', family: 'anima',
  maxRefs: 0, requiresRefs: false, supportsPose: true, supportsLineart: true, supportsLoras: true, supportsInit: false,
  defaults: { steps: 8, cfg: 1 }, sizes: SDXL_SIZES,
  build: (p) => buildAnima(MODELS.animaTurbo, p),
};
```

```ts
// packages/server/src/imaging/recipes/upscale.ts
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type Recipe } from './types.js';

/** 4x-AnimeSharp; factor 2 = 4× then lanczos 0.5 (as P1's --upscale 2). */
export const upscale: Recipe = {
  id: 'upscale', label: 'Upscale (4x-AnimeSharp)', family: 'upscale',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: true,
  defaults: { steps: 1, cfg: 1 }, sizes: [],
  build(p) {
    if (!p.init) throw new RecipeInputError('upscale needs an input image');
    const g = new GraphBuilder();
    const input = g.add('LoadImage', { image: p.init.image });
    const upscaler = g.add('UpscaleModelLoader', { model_name: MODELS.animeSharp });
    let image = out(g.add('ImageUpscaleWithModel', { upscale_model: out(upscaler), image: out(input) }));
    if (p.upscale === 2) image = out(g.add('ImageScaleBy', { image, upscale_method: 'lanczos', scale_by: 0.5 }));
    g.add('SaveImage', { images: image, filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
```

```ts
// packages/server/src/imaging/recipes/index.ts
import { anima } from './anima.js';
import { animaTurbo } from './anima-turbo.js';
import { anime } from './anime.js';
import { animePose } from './anime-pose.js';
import { animeRef } from './anime-ref.js';
import { animeRefine } from './anime-refine.js';
import { kleinRef } from './klein-ref.js';
import { qwenEditRef } from './qwen-edit-ref.js';
import type { Recipe } from './types.js';
import { upscale } from './upscale.js';

const ALL: Recipe[] = [anime, animeRef, animePose, qwenEditRef, kleinRef, anima, animaTurbo, animeRefine, upscale];

/** Contract C.7 ids: anime, anime-ref, anime-pose, qwen-edit-ref, klein-ref, anima, anima-turbo, anime-refine, upscale. */
export const RECIPES: Record<string, Recipe> = Object.fromEntries(ALL.map((r) => [r.id, r]));

export { recipeInfo, RecipeInputError, type Recipe, type RecipeParams } from './types.js';
```

- [ ] **Step 5: Run the recipe tests**

Run: `npx vitest run packages/server/test/recipes-other.test.ts packages/server/test/recipes-sdxl.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  30 passed (30)` (19 here + 11 from Task 12).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/imaging/recipes packages/server/test/recipes-other.test.ts
git commit -m "feat(server): qwen-edit-ref, klein-ref, anima, anima-turbo and upscale recipes; RECIPES table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Recipe routing and generation sizes

**Files:**
- Create: `packages/server/src/imaging/route.ts`, `packages/server/src/imaging/size.ts`
- Test: `packages/server/test/route.test.ts`

**Interfaces:**
- Consumes: `RECIPES`, `Recipe` (Task 13); `computeRects`, `pickSize`, `SDXL_SIZES`, `Manga`, `Panel`, `Page`, `PageFormat`, `Settings` (`@manga/shared`); `PermanentError`.
- Produces:
  - `routeRecipe(input: { settings; manga; panel; refCount; charCount }): { recipe: string; refineWith: string | null }` (Contract C.7)
  - `refineFor(settings, manga, recipeId): string | null`, `type PromptStyle = 'tags' | 'natural'`, `promptStyleFor(recipeId): PromptStyle`
  - `PORTRAIT_SIZE: [number, number]` (= `[832, 1216]`), `panelAspect(page, format, panelId): number`, `panelSize(page, format, panelId, recipe): [number, number]`

Routing (spec §6.1, settings-driven so the bake-off needs no code change):
- `panel.recipe` set → that recipe;
- no referenced character with refs (`refCount === 0`) → the manga's style recipe when it is a non-SDXL engine that needs no refs (e.g. `anima`), otherwise `settings.routing.noChars`;
- one character and refs → `routing.oneChar`; two or more characters and at least one has refs → `routing.multiChar`;
- `refineWith` = `routing.bwRefine` when the manga is B&W and the chosen recipe is `qwen`/`flux2` family, else `null`.

Size (spec §6.2): panels use the bucket closest to the panel's **millimetre** aspect: `(rect.w × widthMm) / (rect.h × heightMm)` from `computeRects(page.layout, manga.pageFormat)`; character portraits and sheet views use 832×1216. Qwen and klein use the same ~1 MP buckets (all multiples of 64).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/route.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_FORMAT, DEFAULT_SETTINGS, DEFAULT_TRANSFORM, EMPTY_SCRIPT, STYLE_PRESETS,
  type LayoutNode, type Manga, type Page, type Panel, type Settings,
} from '@manga/shared';
import { promptStyleFor, refineFor, routeRecipe } from '../src/imaging/route.js';
import { PORTRAIT_SIZE, panelAspect, panelSize } from '../src/imaging/size.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { PermanentError } from '../src/jobs/index.js';

const STAMP = '2026-09-27T00:00:00.000Z';
const manga = (colorMode: 'bw' | 'color', recipe = 'anime'): Manga => ({
  id: 'mg_route00001', title: 'Route', synopsis: '', language: 'en', colorMode, readingDirection: 'rtl', pageFormat: DEFAULT_PAGE_FORMAT,
  styleGuide: { ...STYLE_PRESETS['manga-bw']!.styleGuide, recipe }, coverPageId: null, createdAt: STAMP, updatedAt: STAMP,
});
const panel = (recipe: string | null = null): Panel => ({
  id: 'pn_route00001', pageId: 'pg_route00001', script: EMPTY_SCRIPT, prompt: { scene: '', negative: '' }, recipe, seedLock: false, seed: 1,
  refCharacterIds: [], activeImageId: null, imageTransform: DEFAULT_TRANSFORM, createdAt: STAMP, updatedAt: STAMP,
});
const custom: Settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, multiChar: 'klein-ref', bwRefine: null } };

describe('routeRecipe', () => {
  const cases: Array<[string, Parameters<typeof routeRecipe>[0], ReturnType<typeof routeRecipe>]> = [
    ['no characters → noChars', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 0, charCount: 0 }, { recipe: 'anime', refineWith: null }],
    ['characters without refs → prompt-only', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 0, charCount: 2 }, { recipe: 'anime', refineWith: null }],
    ['an Anima manga keeps its engine for prompt-only panels', { settings: DEFAULT_SETTINGS, manga: manga('bw', 'anima'), panel: panel(), refCount: 0, charCount: 1 }, { recipe: 'anima', refineWith: null }],
    ['one character with refs → oneChar', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 1, charCount: 1 }, { recipe: 'anime-ref', refineWith: null }],
    ['two characters with refs, B&W → multiChar + refine', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 2, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: 'anime-refine' }],
    ['two characters with refs, colour → no refine', { settings: DEFAULT_SETTINGS, manga: manga('color'), panel: panel(), refCount: 2, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: null }],
    ['one of two characters has refs → multiChar', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel(), refCount: 1, charCount: 2 }, { recipe: 'qwen-edit-ref', refineWith: 'anime-refine' }],
    ['panel override wins', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel('anima-turbo'), refCount: 2, charCount: 2 }, { recipe: 'anima-turbo', refineWith: null }],
    ['panel override to klein still refines B&W', { settings: DEFAULT_SETTINGS, manga: manga('bw'), panel: panel('klein-ref'), refCount: 0, charCount: 0 }, { recipe: 'klein-ref', refineWith: 'anime-refine' }],
    ['routing comes from settings', { settings: custom, manga: manga('bw'), panel: panel(), refCount: 2, charCount: 3 }, { recipe: 'klein-ref', refineWith: null }],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(routeRecipe(input)).toEqual(expected);
  });

  it('knows which recipes want tags and which want sentences', () => {
    expect(['anime', 'anime-ref', 'anime-pose', 'anime-refine', 'anima', 'anima-turbo'].map(promptStyleFor)).toEqual(Array(6).fill('tags'));
    expect(['qwen-edit-ref', 'klein-ref'].map(promptStyleFor)).toEqual(['natural', 'natural']);
    expect(refineFor(DEFAULT_SETTINGS, manga('bw'), 'anime')).toBeNull();
  });
});

describe('panel sizes', () => {
  const page = (layout: LayoutNode): Page => ({ id: 'pg_size000001', mangaId: 'mg_size000001', chapterId: 'ch_size000001', kind: 'page', order: 0, layout, createdAt: STAMP, updatedAt: STAMP });
  const splash = page({ type: 'panel', id: 'pn_a' });
  const columns = page({ type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } });
  const rows = page({ type: 'split', dir: 'h', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } });

  it('uses millimetres, not normalized units, for the aspect', () => {
    expect(panelAspect(splash, DEFAULT_PAGE_FORMAT, 'pn_a')).toBeCloseTo(162 / 233, 3);
    expect(panelAspect(columns, DEFAULT_PAGE_FORMAT, 'pn_b')).toBeCloseTo(79.5 / 233, 3);
  });

  it('picks the nearest SDXL bucket', () => {
    expect(panelSize(splash, DEFAULT_PAGE_FORMAT, 'pn_a', RECIPES['anime']!)).toEqual([832, 1216]);
    expect(panelSize(columns, DEFAULT_PAGE_FORMAT, 'pn_b', RECIPES['qwen-edit-ref']!)).toEqual([640, 1536]);
    expect(panelSize(rows, DEFAULT_PAGE_FORMAT, 'pn_a', RECIPES['klein-ref']!)).toEqual([1216, 832]);
    expect(PORTRAIT_SIZE).toEqual([832, 1216]);
  });

  it('fails permanently for a panel that is not on the page', () => {
    expect(() => panelAspect(splash, DEFAULT_PAGE_FORMAT, 'pn_zz')).toThrow(PermanentError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/route.test.ts`
Expected: FAIL — `Failed to load url ../src/imaging/route.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/imaging/route.ts
import type { Manga, Panel, Settings } from '@manga/shared';
import { RECIPES } from './recipes/index.js';

export type PromptStyle = 'tags' | 'natural';

/** Qwen-Image-Edit and FLUX.2 klein follow sentences; the SDXL and Anima recipes want Danbooru tags. */
export function promptStyleFor(recipeId: string): PromptStyle {
  const family = RECIPES[recipeId]?.family;
  return family === 'qwen' || family === 'flux2' ? 'natural' : 'tags';
}

/** B&W books get an img2img pass after the reference recipes that lose the ink/screentone look. */
export function refineFor(settings: Settings, manga: Manga, recipeId: string): string | null {
  return manga.colorMode === 'bw' && promptStyleFor(recipeId) === 'natural' ? settings.routing.bwRefine : null;
}

export function routeRecipe(input: { settings: Settings; manga: Manga; panel: Panel; refCount: number; charCount: number }): { recipe: string; refineWith: string | null } {
  const { settings, manga, panel, refCount, charCount } = input;
  let recipe: string;
  if (panel.recipe) {
    recipe = panel.recipe;
  } else if (refCount === 0) {
    const style = RECIPES[manga.styleGuide.recipe];
    recipe = style && style.family !== 'sdxl' && style.family !== 'upscale' && !style.requiresRefs ? style.id : settings.routing.noChars;
  } else if (charCount <= 1) {
    recipe = settings.routing.oneChar;
  } else {
    recipe = settings.routing.multiChar;
  }
  return { recipe, refineWith: refineFor(settings, manga, recipe) };
}
```

```ts
// packages/server/src/imaging/size.ts
import { SDXL_SIZES, computeRects, pickSize, type Page, type PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import type { Recipe } from './recipes/index.js';

/** Character portraits and sheet views: SDXL's tall bucket. */
export const PORTRAIT_SIZE: [number, number] = [832, 1216];

/** Width/height of the panel on paper (rects are normalized separately per axis, so convert to mm first). */
export function panelAspect(page: Page, format: PageFormat, panelId: string): number {
  const hit = computeRects(page.layout, format).find((r) => r.panelId === panelId);
  if (!hit) throw new PermanentError(`Panel ${panelId} is not in the layout of page ${page.id}`);
  return (hit.rect.w * format.widthMm) / (hit.rect.h * format.heightMm);
}

export function panelSize(page: Page, format: PageFormat, panelId: string, recipe: Recipe): [number, number] {
  return pickSize(panelAspect(page, format, panelId), recipe.sizes.length > 0 ? recipe.sizes : SDXL_SIZES);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/route.test.ts`
Expected: PASS — `Tests  14 passed (14)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/imaging/route.ts packages/server/src/imaging/size.ts packages/server/test/route.test.ts
git commit -m "feat(server): settings-driven recipe routing and panel-aspect generation sizes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: `generateImage` — the only path from ComfyUI output to Image rows

**Files:**
- Create: `packages/server/src/imaging/image-row.ts`, `packages/server/src/imaging/generate.ts`
- Create: `packages/server/test/helpers/library.ts`, `packages/server/test/helpers/seed.ts`
- Test: `packages/server/test/generate.test.ts`

**Interfaces:**
- Consumes: `RECIPES`, `Recipe`, `RecipeParams` (Task 13), `ComfyClient` (Task 11), `pngSize` (Task 8), `Store`, `GpuArbiter`, `JobContext`, `PermanentError`, `newId`, `createPage` (M1).
- Produces:
  - `createImageWithId(store, id, row: Omit<Image, 'id' | 'createdAt'>): Image`
  - `DEFAULT_REF_WEIGHT = 0.7`, `SEED_MODULUS = 2 ** 32`, `randomSeed(): number`
  - `interface GenerateRequest { mangaId; owner: { type: 'character'|'panel'; id }; role: RefSlot | null; recipe; prompt; negative; width; height; seed; loras: LoraRef[]; refImageIds: string[]; control: GenParams['control']; initImageId: string | null; denoise: number | null; upscale: 2|4|null }`
  - `generateImage(deps: { store; comfy; gpu }, req: GenerateRequest, ctx: { signal; progress }): Promise<Image>` (Contract C.7)
  - test helpers: `openTestLibrary(): TestLibrary { dir; store; close() }`; `seedManga(store, opts?) → { manga; chapter; page; panels }`; `seedCharacter(store, mangaId, name, tags?)`; `seedImage(store, mangaId, owner, role, size?)`; `giveRefs(store, character, slots)`; `updatePanel(store, panelId, script, extra?)`

Order of work inside `generateImage`: validate against the recipe metadata (no ComfyUI call for a bad request) → `comfy.ensureServer` ("Starting image server") → `gpu.acquire('comfy')` (frees ollama first when it holds the GPU) → upload refs/control/init → `recipe.build` (a `RecipeInputError` becomes a `PermanentError`) → `comfy.run` with job progress → write `<imageId>.png` via `store.files.writeImage` → insert the Image row with full `GenParams`. LoRAs are dropped for recipes that cannot take them (style LoRAs are manga-wide; `anime-refine` re-applies them after a qwen/klein pass).

- [ ] **Step 1: Write the test helpers**

```ts
// packages/server/test/helpers/library.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store/index.js';

export interface TestLibrary { dir: string; store: Store; close(): void }

export function openTestLibrary(): TestLibrary {
  const dir = mkdtempSync(join(tmpdir(), 'manga-m2-'));
  const store = openStore(dir);
  return {
    dir, store,
    close(): void {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
```

```ts
// packages/server/test/helpers/seed.ts
import {
  DEFAULT_PAGE_FORMAT, STYLE_PRESETS, newId,
  type Chapter, type Character, type ColorMode, type Image, type Manga, type Page, type Panel, type PanelScript, type RefSlot,
} from '@manga/shared';
import { createPage } from '../../src/domain/pages.js';
import { encodeSolidPng } from '../../src/dev/png.js';
import { createImageWithId } from '../../src/imaging/image-row.js';
import type { Store } from '../../src/store/index.js';

export interface SeededManga { manga: Manga; chapter: Chapter; page: Page; panels: Panel[] }

export function seedManga(store: Store, opts: { preset?: string; colorMode?: ColorMode; layout?: string } = {}): SeededManga {
  const preset = STYLE_PRESETS[opts.preset ?? 'manga-bw']!;
  const manga = store.mangas.create({
    title: `Test ${newId('mg')}`, synopsis: '', language: 'en', colorMode: opts.colorMode ?? preset.colorMode, readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
  const chapter = store.chapters.create({ mangaId: manga.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
  const detail = createPage(store, chapter.id, opts.layout ?? '2x2');
  return { manga, chapter, page: detail.page, panels: detail.panels };
}

export function seedCharacter(store: Store, mangaId: string, name: string, appearanceTags = ''): Character {
  return store.characters.create({ mangaId, name, role: 'main', personality: '', speechStyle: '', appearanceTags, seed: 1234, recipe: null, refs: {} });
}

export function seedImage(
  store: Store, mangaId: string, owner: { type: 'character' | 'panel'; id: string }, role: RefSlot | null, size: [number, number] = [832, 1216],
): Image {
  const id = newId('im');
  const path = store.files.writeImage(mangaId, id, encodeSolidPng(size[0], size[1], [90, 90, 90]));
  return createImageWithId(store, id, {
    mangaId, ownerType: owner.type, ownerId: owner.id, role, path, width: size[0], height: size[1],
    source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}

export function giveRefs(store: Store, character: Character, slots: RefSlot[]): Character {
  const refs = { ...character.refs };
  for (const slot of slots) refs[slot] = seedImage(store, character.mangaId, { type: 'character', id: character.id }, slot).id;
  return store.characters.update(character.id, { refs });
}

export function updatePanel(store: Store, panelId: string, script: Partial<PanelScript>, extra: Parameters<Store['panels']['update']>[1] = {}): Panel {
  const panel = store.panels.require(panelId);
  return store.panels.update(panelId, { script: { ...panel.script, ...script }, ...extra });
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/generate.test.ts
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { generateImage, type GenerateRequest } from '../src/imaging/generate.js';
import { pngSize } from '../src/imaging/png-size.js';
import { GpuArbiter, PermanentError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, seedImage, seedManga } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let comfy: ComfyClient;
let gpu: GpuArbiter;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 });
  gpu = new GpuArbiter();
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

const context = (): { labels: string[]; ctx: { signal: AbortSignal; progress: (label: string) => void } } => {
  const labels: string[] = [];
  return { labels, ctx: { signal: new AbortController().signal, progress: (label: string) => { labels.push(label); } } };
};
const request = (mangaId: string, over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  mangaId, owner: { type: 'panel', id: 'pn_generate01' }, role: null, recipe: 'anime', prompt: 'P', negative: 'N', width: 832, height: 1216, seed: 7,
  loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }], refImageIds: [], control: null, initImageId: null,
  denoise: null, upscale: null, ...over,
});

describe('generateImage', () => {
  it('writes the PNG, records full GenParams and holds the GPU for ComfyUI', async () => {
    const { manga } = seedManga(lib.store);
    const { labels, ctx } = context();
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id), ctx);
    expect(image).toMatchObject({ mangaId: manga.id, ownerType: 'panel', ownerId: 'pn_generate01', role: null, width: 832, height: 1216, source: 'generated', parentImageId: null, review: null });
    expect(image.path).toBe(lib.store.files.imageRel(manga.id, image.id));
    expect(pngSize(readFileSync(lib.store.files.abs(image.path)))).toEqual({ width: 832, height: 1216 });
    expect(image.gen).toMatchObject({
      recipe: 'anime', prompt: 'P', negative: 'N', seed: 7, steps: 28, cfg: 5.5, width: 832, height: 1216,
      loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }], refs: [], control: null, initImageId: null, denoise: null,
    });
    expect(image.gen?.comfyPromptId).toBe(fake.promptIds[0]);
    expect(lib.store.images.require(image.id)).toEqual(image);
    expect(gpu.current).toBe('comfy');
    expect(labels).toContain('Sampling');
    expect(nodesOf(fake.graphs[0]!, 'KSampler')[0]!.inputs['seed']).toBe(7);
  });

  it('uploads reference images and passes their ComfyUI names to the recipe', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl');
    const portrait = seedImage(lib.store, manga.id, { type: 'character', id: aiko.id }, 'portrait');
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { recipe: 'anime-ref', refImageIds: [portrait.id] }), context().ctx);
    expect([...fake.uploads.keys()]).toEqual([`manga-builder/${portrait.id}.png`]);
    expect(nodesOf(fake.graphs[0]!, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${portrait.id}.png`]);
    expect(image.gen?.refs).toEqual([portrait.id]);
  });

  it('marks upscales as upscaled children of their source', async () => {
    const { manga } = seedManga(lib.store);
    const source = seedImage(lib.store, manga.id, { type: 'panel', id: 'pn_generate01' }, null, [100, 80]);
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, {
      recipe: 'upscale', prompt: '', negative: '', width: 200, height: 160, seed: 0, loras: [], initImageId: source.id, upscale: 2,
    }), context().ctx);
    expect(image).toMatchObject({ source: 'upscaled', parentImageId: source.id, width: 200, height: 160, ownerId: 'pn_generate01' });
    expect(image.gen).toMatchObject({ recipe: 'upscale', initImageId: source.id, denoise: null });
  });

  it('drops style LoRAs for recipes that cannot take them', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const portrait = seedImage(lib.store, manga.id, { type: 'character', id: aiko.id }, 'portrait');
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { recipe: 'qwen-edit-ref', refImageIds: [portrait.id] }), context().ctx);
    expect(image.gen?.loras).toEqual([]);
    expect(nodesOf(fake.graphs[0]!, 'LoraLoader')).toHaveLength(0);
  });

  it.each<[string, Partial<GenerateRequest>, string]>([
    ['an unknown recipe', { recipe: 'nope' }, 'Unknown recipe "nope"'],
    ['too many references', { recipe: 'anime-ref', refImageIds: ['im_a', 'im_b', 'im_c'] }, 'at most 2 reference image(s)'],
    ['missing references', { recipe: 'anime-ref' }, 'needs at least one reference image'],
    ['a pose on a recipe without pose support', { control: { kind: 'pose', imageId: 'im_x', strength: 0.8 } }, 'does not take a pose image'],
    ['an init image on a recipe without img2img', { recipe: 'anima', initImageId: 'im_x' }, 'does not take an input image'],
  ])('refuses %s before touching ComfyUI', async (_name, over, message) => {
    const { manga } = seedManga(lib.store);
    const err = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, over), context().ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain(message);
    expect(fake.graphs).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('turns a recipe input error into a PermanentError', async () => {
    const { manga } = seedManga(lib.store);
    const err = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { recipe: 'anime-pose' }), context().ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('anime-pose: anime-pose needs a pose image');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/generate.test.ts`
Expected: FAIL — `Failed to load url ../../src/imaging/image-row.js` (imported by the seed helper).

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/src/imaging/image-row.ts
import type { Image } from '@manga/shared';
import type { Store } from '../store/index.js';

export type NewImageRow = Omit<Image, 'id' | 'createdAt'>;

/** Inserts an Image row under an id chosen by the caller (the PNG is written to <id>.png first). */
export function createImageWithId(store: Store, id: string, row: NewImageRow): Image {
  const created = store.images.create({ ...row, id } as Parameters<Store['images']['create']>[0]);
  if (created.id !== id) throw new Error(`images.create ignored the explicit id ${id} (got ${created.id}); see M2 Task 1`);
  return created;
}
```

```ts
// packages/server/src/imaging/generate.ts
import { newId, type GenParams, type Image, type LoraRef, type RefSlot } from '@manga/shared';
import { PermanentError, type GpuArbiter, type JobContext } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import type { ComfyClient } from './comfy.js';
import type { ComfyGraph } from './comfy-graph.js';
import { createImageWithId } from './image-row.js';
import { pngSize } from './png-size.js';
import { RECIPES, type Recipe, type RecipeParams } from './recipes/index.js';

/** IP-Adapter weight for anime-ref (P1 default for --ref-weight). */
export const DEFAULT_REF_WEIGHT = 0.7;
export const SEED_MODULUS = 2 ** 32;

export function randomSeed(): number {
  return Math.floor(Math.random() * SEED_MODULUS);
}

export interface GenerateRequest {
  mangaId: string;
  owner: { type: 'character' | 'panel'; id: string };
  role: RefSlot | null;
  recipe: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  loras: LoraRef[];
  refImageIds: string[];
  control: GenParams['control'];
  initImageId: string | null;
  denoise: number | null;
  upscale: 2 | 4 | null;
}

export interface GenerateDeps { store: Store; comfy: ComfyClient; gpu: GpuArbiter }
export interface GenerateContext { signal: AbortSignal; progress: JobContext['progress'] }

function check(recipe: Recipe, req: GenerateRequest): void {
  if (req.refImageIds.length > recipe.maxRefs) {
    throw new PermanentError(`${recipe.label} takes at most ${recipe.maxRefs} reference image(s); got ${req.refImageIds.length}`);
  }
  if (recipe.requiresRefs && req.refImageIds.length === 0) throw new PermanentError(`${recipe.label} needs at least one reference image`);
  if (req.control?.kind === 'pose' && !recipe.supportsPose) throw new PermanentError(`${recipe.label} does not take a pose image`);
  if (req.control?.kind === 'lineart' && !recipe.supportsLineart) throw new PermanentError(`${recipe.label} does not take a lineart image`);
  if (req.initImageId !== null && !recipe.supportsInit) throw new PermanentError(`${recipe.label} does not take an input image`);
}

/** The one entry point for creating Image rows from ComfyUI output (Contract C.7). */
export async function generateImage(deps: GenerateDeps, req: GenerateRequest, ctx: GenerateContext): Promise<Image> {
  const recipe = RECIPES[req.recipe];
  if (!recipe) throw new PermanentError(`Unknown recipe "${req.recipe}"`);
  check(recipe, req);
  const { store, comfy, gpu } = deps;
  const loras = recipe.supportsLoras ? req.loras : [];

  await comfy.ensureServer((label) => ctx.progress(label));
  await gpu.acquire('comfy');

  const upload = (imageId: string): Promise<string> => comfy.uploadImage(store.files.abs(store.images.require(imageId).path));
  if (req.refImageIds.length > 0 || req.control !== null || req.initImageId !== null) ctx.progress('Uploading images');
  const refs: string[] = [];
  for (const id of req.refImageIds) refs.push(await upload(id));
  const control = req.control ? { kind: req.control.kind, image: await upload(req.control.imageId), strength: req.control.strength } : null;
  const init = req.initImageId ? { image: await upload(req.initImageId), denoise: req.denoise ?? 1 } : null;

  const params: RecipeParams = {
    prompt: req.prompt, negative: req.negative, width: req.width, height: req.height, seed: req.seed,
    steps: recipe.defaults.steps, cfg: recipe.defaults.cfg, loras, refs, refWeight: DEFAULT_REF_WEIGHT,
    control, init, upscale: req.upscale, filenamePrefix: `manga-builder/${req.mangaId}/${req.owner.id}`,
  };
  let graph: ComfyGraph;
  try {
    graph = recipe.build(params);
  } catch (err) {
    throw new PermanentError(`${recipe.id}: ${(err as Error).message}`);
  }

  const result = await comfy.run(graph, { signal: ctx.signal, onProgress: ctx.progress });
  const bytes = result.images[0];
  if (!bytes) throw new PermanentError('ComfyUI returned no image');
  const size = pngSize(bytes);
  const id = newId('im');
  const path = store.files.writeImage(req.mangaId, id, bytes);
  const gen: GenParams = {
    recipe: recipe.id, prompt: req.prompt, negative: req.negative, seed: req.seed, steps: params.steps, cfg: params.cfg,
    width: req.width, height: req.height, loras, refs: [...req.refImageIds], control: req.control, initImageId: req.initImageId,
    denoise: init && recipe.family !== 'upscale' ? init.denoise : null, comfyPromptId: result.promptId, durationMs: result.durationMs,
  };
  return createImageWithId(store, id, {
    mangaId: req.mangaId, ownerType: req.owner.type, ownerId: req.owner.id, role: req.role, path, width: size.width, height: size.height,
    source: req.upscale ? 'upscaled' : 'generated', parentImageId: req.upscale ? req.initImageId : null, gen, review: null,
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/generate.test.ts`
Expected: PASS — `Tests  10 passed (10)`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/imaging/image-row.ts packages/server/src/imaging/generate.ts packages/server/test/helpers/library.ts packages/server/test/helpers/seed.ts packages/server/test/generate.test.ts
git commit -m "feat(server): generateImage uploads inputs, runs the recipe and records full GenParams" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The `llm.step` dispatcher

**Files:**
- Create: `packages/server/src/jobs/llm-step.ts`
- Create: `packages/server/test/helpers/job-context.ts`
- Test: `packages/server/test/llm-step.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `JobHandler`, `PermanentError`, `JobQueue`, `GpuArbiter` (`./index.js` — M1's barrel; `llm-step.ts` is never added to that barrel), `EventBus`, `LlmStepPayload`, `JobKind`.
- Produces (Contract C.7):
  - `type LlmStepHandler = (ctx: JobContext, payload: LlmStepPayload) => Promise<unknown>`
  - `registerLlmStep(type: LlmStepPayload['type'], handler: LlmStepHandler): void` (module-level registry; the last registration for a type wins)
  - `llmStepJobHandler(): JobHandler`
  - test helper `jobContext(store, kind, payload, opts?: { gpu?: GpuArbiter }) → { ctx: JobContext; events: ServerEvent[]; progress: Array<{ label; value?; max? }>; controller: AbortController }`

- [ ] **Step 1: Write the helper and the failing test**

```ts
// packages/server/test/helpers/job-context.ts
import type { JobKind, ServerEvent } from '@manga/shared';
import { EventBus } from '../../src/events/bus.js';
import { GpuArbiter, JobQueue, type JobContext } from '../../src/jobs/index.js';
import type { Store } from '../../src/store/index.js';

export interface TestJobContext {
  ctx: JobContext;
  events: ServerEvent[];
  progress: Array<{ label: string; value?: number; max?: number }>;
  controller: AbortController;
}

/** A JobContext around a real Job row, without starting the queue. */
export function jobContext(store: Store, kind: JobKind, payload: unknown, opts: { gpu?: GpuArbiter } = {}): TestJobContext {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.on((e) => { events.push(e); });
  const gpu = opts.gpu ?? new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const job = store.jobs.insert({ kind, lane: 'gpu', payload, priority: 0, maxAttempts: 1, nextRunAt: new Date().toISOString(), episodeRunId: null });
  const progress: TestJobContext['progress'] = [];
  const controller = new AbortController();
  const ctx: JobContext = {
    job, signal: controller.signal, store, bus, gpu, queue,
    progress: (label, value, max) => {
      progress.push({ label, ...(value !== undefined ? { value } : {}), ...(max !== undefined ? { max } : {}) });
    },
  };
  return { ctx, events, progress, controller };
}
```

```ts
// packages/server/test/llm-step.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmStepPayload } from '@manga/shared';
import { llmStepJobHandler, registerLlmStep } from '../src/jobs/llm-step.js';
import { PermanentError } from '../src/jobs/index.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

describe('llm.step dispatcher', () => {
  it('routes the payload to the handler registered for its type', async () => {
    const seen: LlmStepPayload[] = [];
    registerLlmStep('appearance', async (_ctx, payload) => {
      seen.push(payload);
      return { appearanceTags: '1girl' };
    });
    const payload: LlmStepPayload = { type: 'appearance', characterId: 'cr_dispatch01', description: 'a girl' };
    const { ctx } = jobContext(lib.store, 'llm.step', payload);
    await expect(llmStepJobHandler()(ctx)).resolves.toEqual({ appearanceTags: '1girl' });
    expect(seen).toEqual([payload]);
  });

  it('lets a later registration replace an earlier one', async () => {
    registerLlmStep('panel-prompt', async () => 'first');
    registerLlmStep('panel-prompt', async () => 'second');
    const { ctx } = jobContext(lib.store, 'llm.step', { type: 'panel-prompt', panelId: 'pn_dispatch01' });
    await expect(llmStepJobHandler()(ctx)).resolves.toBe('second');
  });

  it('fails permanently for a type nobody registered', async () => {
    const { ctx } = jobContext(lib.store, 'llm.step', { type: 'episode', runId: 'er_dispatch01', step: 'premise' });
    const err = await llmStepJobHandler()(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('No llm.step handler registered for "episode"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/llm-step.test.ts`
Expected: FAIL — `Failed to load url ../src/jobs/llm-step.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/jobs/llm-step.ts
import type { LlmStepPayload } from '@manga/shared';
import { PermanentError, type JobContext, type JobHandler } from './index.js';

export type LlmStepHandler = (ctx: JobContext, payload: LlmStepPayload) => Promise<unknown>;

const steps = new Map<LlmStepPayload['type'], LlmStepHandler>();

/** M2 registers 'panel-prompt' and 'appearance'; M4 registers 'episode'. The last registration for a type wins. */
export function registerLlmStep(type: LlmStepPayload['type'], handler: LlmStepHandler): void {
  steps.set(type, handler);
}

export function llmStepJobHandler(): JobHandler {
  return async (ctx: JobContext) => {
    const payload = ctx.job.payload as LlmStepPayload;
    const type = typeof payload === 'object' && payload !== null ? payload.type : undefined;
    const handler = type ? steps.get(type) : undefined;
    if (!handler) throw new PermanentError(`No llm.step handler registered for "${String(type)}"`);
    return handler(ctx, payload);
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/llm-step.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/jobs/llm-step.ts packages/server/test/helpers/job-context.ts packages/server/test/llm-step.test.ts
git commit -m "feat(server): llm.step dispatcher with a per-type handler registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: `image.generate` for panels

> **Controller ruling (M1 pre-flight R6):** M1 defines `emitEntity` in `packages/server/src/events/bus.ts`, re-exported from `api/util.ts`. Do NOT re-implement it in `src/handlers/context.ts`. Instead, re-export it there with `export { emitEntity } from '../events/bus.js';`, so this task's importers keep working unchanged.

**Files:**
- Create: `packages/server/src/handlers/types.ts`, `packages/server/src/handlers/context.ts`, `packages/server/src/handlers/panel-image.ts`
- Create: `packages/server/test/helpers/handler-services.ts`
- Test: `packages/server/test/panel-image.test.ts`

**Interfaces:**
- Consumes: `generateImage`, `randomSeed` (Task 15), `routeRecipe`, `refineFor` (Task 14), `panelSize` (Task 14), `RECIPES`, `Recipe` (Task 13), `Engines` (Task 2), `ComfyClient` (Task 11), `assemblePrompt` (`@manga/shared`), `JobContext`, `EventBus`, `Store`.
- Produces:
  - `interface HandlerServices { engines: Engines; requireComfy(): ComfyClient }`
  - `nonEmpty(s): s is string`; `interface PanelContext { panel; page; manga; characters: Character[]; refCharacters: Character[] }`; `panelContext(store, panelId): PanelContext`
  - `interface PickedRef { imageId: string; character: Character }`; `pickRefs(store, recipe, refCharacters): PickedRef[]`
  - `emitEntity(bus, entity, id, op, mangaId): void`
  - `REFINE_DENOISE = 0.3`; `generatePanelImage(ctx, services, payload: Extract<ImageGeneratePayload, { target: 'panel' }>): Promise<ImageGenerateResult>`
  - test helper `handlerServices(store, comfy, scripts?) → TestServices { engines; requireComfy; claude: ScriptedEngine; local: ScriptedEngine }`

Rules (spec §6.1–§6.3 and the brief):
- characters = existing characters named in `script.characters`, then those in `refCharacterIds` (deleted ids are skipped); reference characters = `refCharacterIds` that exist and have a portrait or full-body image;
- prompt = `assemblePrompt(styleGuide, colorMode, every character's appearanceTags verbatim, panel.prompt.scene [+ sceneSuffix])`, negative extra = `panel.prompt.negative [+ negativeExtra]`;
- recipe = payload recipe, else `routeRecipe`; references: one character → its portrait + full body, several → one image each, capped at `recipe.maxRefs`;
- seed = payload seed, else `panel.seed` when `seedLock`, else random; always written back;
- size = nearest bucket to the panel's millimetre aspect;
- if a refine recipe applies (B&W after qwen/klein), run it as img2img on the first image at denoise 0.3 and make **that** the active image; both images stay as variants.

- [ ] **Step 1: Write the helper and the failing test**

```ts
// packages/server/test/helpers/handler-services.ts
import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { Engines } from '../../src/engines/resolve.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import type { HandlerServices } from '../../src/handlers/types.js';
import type { ComfyClient } from '../../src/imaging/comfy.js';
import type { Store } from '../../src/store/index.js';

export interface TestServices extends HandlerServices { claude: ScriptedEngine; local: ScriptedEngine }

export function handlerServices(
  store: Store, comfy: ComfyClient,
  scripts: { claude?: Record<string, ScriptedResponse>; local?: Record<string, ScriptedResponse> } = {},
): TestServices {
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...scripts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...scripts.local });
  return { claude, local, engines: new Engines({ settings: () => store.settings.get(), claude, local }), requireComfy: () => comfy };
}
```

```ts
// packages/server/test/panel-image.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemblePrompt, type ImageGeneratePayload } from '@manga/shared';
import { generatePanelImage } from '../src/handlers/panel-image.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { panelSize } from '../src/imaging/size.js';
import { PermanentError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices, type TestServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let services: TestServices;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  services = handlerServices(lib.store, new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 }));
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

type PanelPayload = Extract<ImageGeneratePayload, { target: 'panel' }>;
const stage = (characterId: string, position: 'left' | 'center' | 'right' = 'center') => ({ characterId, pose: 'standing', expression: 'calm', position });
const run = (panelId: string, extra: Omit<PanelPayload, 'target' | 'panelId'> = {}) =>
  generatePanelImage(jobContext(lib.store, 'image.generate', {}).ctx, services, { target: 'panel', panelId, ...extra });

describe('image.generate (panel)', () => {
  it('assembles the prompt from style, B&W tokens, verbatim character tags and the scene', async () => {
    const { manga, page, panels } = seedManga(lib.store, { layout: '2-rows' });
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair, twintails');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: 'rooftop, sunset', negative: 'blurry background' } });
    const { ctx, events } = jobContext(lib.store, 'image.generate', {});
    const result = await generatePanelImage(ctx, services, { target: 'panel', panelId: panel.id });

    expect(lib.store.panels.require(panel.id).activeImageId).toBe(result.imageId);
    const graph = fake.graphs[0]!;
    const expected = assemblePrompt({ styleGuide: manga.styleGuide, colorMode: 'bw', characterTags: ['1girl, silver hair, twintails'], scene: 'rooftop, sunset', extraNegative: 'blurry background' });
    expect(nodesOf(graph, 'CLIPTextEncode').map((n) => n.inputs['text'])).toEqual([expected.prompt, expected.negative]);
    expect(expected.prompt).toContain('1girl, silver hair, twintails');
    expect(nodesOf(graph, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
    const [width, height] = panelSize(page, manga.pageFormat, panel.id, RECIPES['anime']!);
    expect(width).toBeGreaterThan(height);
    expect(nodesOf(graph, 'EmptyLatentImage')[0]!.inputs).toMatchObject({ width, height });
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: result.imageId, op: 'created', mangaId: manga.id });
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: panel.id, op: 'updated', mangaId: manga.id });
  });

  it('writes a fresh seed back when unlocked and keeps a locked one', async () => {
    const { panels } = seedManga(lib.store);
    const unlocked = await run(panels[0]!.id);
    const after = lib.store.panels.require(panels[0]!.id);
    expect(nodesOf(fake.graphs[0]!, 'KSampler')[0]!.inputs['seed']).toBe(after.seed);
    expect(lib.store.images.require(unlocked.imageId).gen?.seed).toBe(after.seed);
    lib.store.panels.update(panels[1]!.id, { seedLock: true, seed: 4242 });
    await run(panels[1]!.id);
    expect(nodesOf(fake.graphs[1]!, 'KSampler')[0]!.inputs['seed']).toBe(4242);
    expect(lib.store.panels.require(panels[1]!.id).seed).toBe(4242);
  });

  it('lets the payload override recipe and seed', async () => {
    const { panels } = seedManga(lib.store);
    await run(panels[0]!.id, { recipe: 'anima', seed: 99 });
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'UNETLoader')[0]!.inputs['unet_name']).toBe('anima-aesthetic-v1.1.safetensors');
    expect(nodesOf(graph, 'KSampler')[0]!.inputs['seed']).toBe(99);
    expect(lib.store.panels.require(panels[0]!.id).seed).toBe(99);
  });

  it('adds sceneSuffix and negativeExtra for review retries', async () => {
    const { panels } = seedManga(lib.store);
    await run(panels[0]!.id, { sceneSuffix: 'exactly two people', negativeExtra: 'letters, writing' });
    const [positive, negative] = nodesOf(fake.graphs[0]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    expect(positive).toContain('exactly two people');
    expect(negative).toContain('letters, writing');
  });

  it('routes two referenced characters through qwen-edit-ref, then refines B&W with anime-refine', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const ren = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(ren.id, 'right')] }, {
      refCharacterIds: [aiko.id, ren.id], prompt: { scene: 'the character from picture 1 argues with the character from picture 2', negative: '' },
    });
    const result = await run(panel.id);

    expect(fake.graphs).toHaveLength(2);
    const [qwen, refine] = fake.graphs;
    const encode = nodesOf(qwen!, 'TextEncodeQwenImageEditPlus')[0]!;
    const loadName = (link: unknown): unknown => qwen![(link as [string, number])[0]]!.inputs['image'];
    expect(loadName(encode.inputs['image1'])).toBe(`manga-builder/${aiko.refs.portrait}.png`);
    expect(loadName(encode.inputs['image2'])).toBe(`manga-builder/${ren.refs.portrait}.png`);

    const images = lib.store.images.listByOwner('panel', panel.id);
    const first = images.find((i) => i.gen?.recipe === 'qwen-edit-ref')!;
    const second = images.find((i) => i.gen?.recipe === 'anime-refine')!;
    expect(result.imageId).toBe(second.id);
    expect(second.gen).toMatchObject({ initImageId: first.id, denoise: 0.3 });
    expect(nodesOf(refine!, 'KSampler')[0]!.inputs['denoise']).toBe(0.3);
    expect(nodesOf(refine!, 'LoadImage')[0]!.inputs['image']).toBe(`manga-builder/${first.id}.png`);
    expect(lib.store.panels.require(panel.id).activeImageId).toBe(second.id);
  });

  it('uses the portrait and full body of a single referenced character with anime-ref', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait', 'fullbody']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { refCharacterIds: [aiko.id] });
    await run(panel.id);
    expect(fake.graphs).toHaveLength(1);
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(1);
    expect(nodesOf(graph, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${aiko.refs.portrait}.png`, `manga-builder/${aiko.refs.fullbody}.png`]);
  });

  it('ignores deleted characters and characters without refs', async () => {
    const { manga, panels } = seedManga(lib.store);
    const ren = seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage('cr_deleted0001', 'left'), stage(ren.id, 'right')] }, {
      refCharacterIds: ['cr_deleted0001', ren.id],
    });
    const result = await run(panel.id);
    expect(result.imageId).toMatch(/^im_/);
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(0);
    expect(nodesOf(graph, 'CheckpointLoaderSimple')).toHaveLength(1);
    expect(String(nodesOf(graph, 'CLIPTextEncode')[0]!.inputs['text'])).toContain('1boy, black hair');
  });

  it('fails clearly when a forced recipe needs references the panel does not have', async () => {
    const { panels } = seedManga(lib.store);
    const err = await run(panels[0]!.id, { recipe: 'anime-ref' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain('needs at least one reference image');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/panel-image.test.ts`
Expected: FAIL — `Failed to load url ../../src/handlers/types.js` (imported by the helper).

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/handlers/types.ts
import type { Engines } from '../engines/resolve.js';
import type { ComfyClient } from '../imaging/comfy.js';

/** What job handlers need from the M2 services (M2Services satisfies it; tests build it directly). */
export interface HandlerServices {
  engines: Engines;
  requireComfy(): ComfyClient;
}
```

```ts
// packages/server/src/handlers/context.ts
import type { Character, EntityName, Manga, Page, Panel } from '@manga/shared';
import type { EventBus } from '../events/bus.js';
import type { Recipe } from '../imaging/recipes/index.js';
import type { Store } from '../store/index.js';

export const nonEmpty = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

export interface PanelContext { panel: Panel; page: Page; manga: Manga; characters: Character[]; refCharacters: Character[] }

/** Characters that exist (script order, then ref toggles) and the toggled ones that have a usable reference image. */
export function panelContext(store: Store, panelId: string): PanelContext {
  const panel = store.panels.require(panelId);
  const page = store.pages.require(panel.pageId);
  const manga = store.mangas.require(page.mangaId);
  const ids = [...new Set([...panel.script.characters.map((c) => c.characterId), ...panel.refCharacterIds])];
  const characters = ids
    .map((id) => store.characters.get(id))
    .filter((c): c is Character => c !== null && c.mangaId === manga.id);
  const hasRef = (c: Character): boolean => [c.refs.portrait, c.refs.fullbody].some((id) => id !== undefined && store.images.get(id) !== null);
  const refCharacters = panel.refCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => c !== undefined && hasRef(c));
  return { panel, page, manga, characters, refCharacters };
}

export interface PickedRef { imageId: string; character: Character }

/** One character → its portrait and full body; several → one image each (portrait first). Capped at recipe.maxRefs. */
export function pickRefs(store: Store, recipe: Recipe, refCharacters: Character[]): PickedRef[] {
  if (recipe.maxRefs === 0) return [];
  const usable = (id: string | undefined): id is string => id !== undefined && store.images.get(id) !== null;
  const only = refCharacters.length === 1 ? refCharacters[0]! : null;
  const picked: PickedRef[] = only
    ? [only.refs.portrait, only.refs.fullbody].filter(usable).map((imageId) => ({ imageId, character: only }))
    : refCharacters.flatMap((character) => {
      const imageId = [character.refs.portrait, character.refs.fullbody].find(usable);
      return imageId ? [{ imageId, character }] : [];
    });
  return picked.slice(0, recipe.maxRefs);
}

export function emitEntity(bus: EventBus, entity: EntityName, id: string, op: 'created' | 'updated' | 'deleted', mangaId: string | null): void {
  bus.emit({ type: 'entity', entity, id, op, mangaId });
}
```

```ts
// packages/server/src/handlers/panel-image.ts
import { assemblePrompt, type ImageGeneratePayload, type ImageGenerateResult } from '@manga/shared';
import { generateImage, randomSeed, type GenerateRequest } from '../imaging/generate.js';
import { RECIPES } from '../imaging/recipes/index.js';
import { refineFor, routeRecipe } from '../imaging/route.js';
import { panelSize } from '../imaging/size.js';
import { PermanentError, type JobContext } from '../jobs/index.js';
import { emitEntity, nonEmpty, panelContext, pickRefs } from './context.js';
import type { HandlerServices } from './types.js';

/** Spec §6.1: "WAI img2img, denoise ≈0.3 + manga LoRA". */
export const REFINE_DENOISE = 0.3;

export async function generatePanelImage(
  ctx: JobContext, services: HandlerServices, p: Extract<ImageGeneratePayload, { target: 'panel' }>,
): Promise<ImageGenerateResult> {
  const { store, bus } = ctx;
  const { panel, page, manga, characters, refCharacters } = panelContext(store, p.panelId);
  const settings = store.settings.get();
  const route = routeRecipe({ settings, manga, panel, refCount: refCharacters.length, charCount: characters.length });
  const recipeId = p.recipe ?? route.recipe;
  const recipe = RECIPES[recipeId];
  if (!recipe) throw new PermanentError(`Unknown recipe "${recipeId}"`);
  const refineWith = p.recipe ? refineFor(settings, manga, recipeId) : route.refineWith;
  if (refineWith !== null && !RECIPES[refineWith]) throw new PermanentError(`Unknown refine recipe "${refineWith}" (settings.routing.bwRefine)`);

  const scene = [panel.prompt.scene, p.sceneSuffix].filter(nonEmpty).join(', ');
  const extraNegative = [panel.prompt.negative, p.negativeExtra].filter(nonEmpty).join(', ');
  const { prompt, negative } = assemblePrompt({
    styleGuide: manga.styleGuide, colorMode: manga.colorMode,
    characterTags: characters.map((c) => c.appearanceTags).filter(nonEmpty), scene,
    ...(extraNegative ? { extraNegative } : {}),
  });
  const seed = p.seed ?? (panel.seedLock ? panel.seed : randomSeed());
  const [width, height] = panelSize(page, manga.pageFormat, panel.id, recipe);
  const deps = { store, comfy: services.requireComfy(), gpu: ctx.gpu };
  const io = { signal: ctx.signal, progress: ctx.progress };
  const base: Omit<GenerateRequest, 'recipe' | 'width' | 'height' | 'refImageIds' | 'initImageId' | 'denoise'> = {
    mangaId: manga.id, owner: { type: 'panel', id: panel.id }, role: null, prompt, negative, seed,
    loras: manga.styleGuide.loras, control: null, upscale: null,
  };

  const first = await generateImage(deps, {
    ...base, recipe: recipeId, width, height, refImageIds: pickRefs(store, recipe, refCharacters).map((r) => r.imageId), initImageId: null, denoise: null,
  }, io);
  emitEntity(bus, 'image', first.id, 'created', manga.id);
  let active = first;
  if (refineWith) {
    ctx.progress('Refining ink and screentone');
    active = await generateImage(deps, {
      ...base, recipe: refineWith, width: first.width, height: first.height, refImageIds: [], initImageId: first.id, denoise: REFINE_DENOISE,
    }, io);
    emitEntity(bus, 'image', active.id, 'created', manga.id);
  }
  store.panels.update(panel.id, { activeImageId: active.id, seed });
  emitEntity(bus, 'panel', panel.id, 'updated', manga.id);
  return { imageId: active.id };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/panel-image.test.ts`
Expected: PASS — `Tests  8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/handlers packages/server/test/helpers/handler-services.ts packages/server/test/panel-image.test.ts
git commit -m "feat(server): panel image generation with routing, refs, seed write-back and B&W refine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Character portraits, sheet views and `character.refs`

**Files:**
- Create: `packages/server/src/handlers/character-images.ts`
- Test: `packages/server/test/character-images.test.ts`

**Interfaces:**
- Consumes: `generateImage` (Task 15), `PORTRAIT_SIZE` (Task 14), `emitEntity`, `nonEmpty`, `HandlerServices` (Task 17), `assemblePrompt`, `BASE_NEGATIVE`, `CharacterRefsPayload`, `CharacterRefsResult`, `ImageGenerateResult`.
- Produces:
  - `PORTRAIT_SCENE`, `FULLBODY_SCENE`, `SHEET_NEGATIVE`, `VIEW_INSTRUCTION`, `SLOT_LABEL`
  - `generatePortrait(ctx, services, p: { characterId: string; seed?: number | null }): Promise<ImageGenerateResult>` — role `'portrait'`, 832×1216, **not** auto-picked
  - `generateSlot(ctx, services, p: { characterId: string; slot: 'fullbody' | 'side' | 'back' }): Promise<ImageGenerateResult>` — sets `character.refs[slot]`
  - `generateCharacterRefs(ctx, services, p: CharacterRefsPayload): Promise<CharacterRefsResult>` — fullbody → side → back in one job

Spec §6.4: portraits are bust, front view, plain background from `appearanceTags` + `seed` (recipe `anime` unless the character has a prompt-only recipe set); the sheet makes `fullbody` with `anime-ref` from the portrait, then `side` and `back` with `qwen-edit-ref` from portrait + full body. Sheet views become the character's refs straight away because the next view needs the previous one.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/character-images.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCharacterRefs, generatePortrait, generateSlot } from '../src/handlers/character-images.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { PermanentError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices, type TestServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let services: TestServices;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  services = handlerServices(lib.store, new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 }));
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

const ctx = () => jobContext(lib.store, 'image.generate', {}).ctx;

describe('character images', () => {
  it('generates an unpicked bust portrait from the appearance tags and seed', async () => {
    const { manga } = seedManga(lib.store);
    const created = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
    const aiko = lib.store.characters.update(created.id, { recipe: 'anime-ref' });
    const first = await generatePortrait(ctx(), services, { characterId: aiko.id });
    const image = lib.store.images.require(first.imageId);
    expect(image).toMatchObject({ ownerType: 'character', ownerId: aiko.id, role: 'portrait', width: 832, height: 1216 });
    expect(image.gen).toMatchObject({ recipe: 'anime', seed: 1234 });
    expect(image.gen?.prompt).toContain('1girl, silver hair');
    expect(image.gen?.prompt).toContain('upper body');
    expect(image.gen?.negative).toContain('multiple views');
    expect(lib.store.characters.require(aiko.id).refs).toEqual({});
    const second = await generatePortrait(ctx(), services, { characterId: aiko.id, seed: 77 });
    expect(lib.store.images.require(second.imageId).gen?.seed).toBe(77);
  });

  it('refuses a sheet view without a portrait', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl');
    const err = await generateSlot(ctx(), services, { characterId: aiko.id, slot: 'fullbody' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('Aiko has no portrait yet: generate portraits and pick one first');
  });

  it('makes the full body with anime-ref from the portrait and stores it as a ref', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const { ctx: jobCtx, events } = jobContext(lib.store, 'image.generate', {});
    const result = await generateSlot(jobCtx, services, { characterId: aiko.id, slot: 'fullbody' });
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(1);
    expect(nodesOf(graph, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${aiko.refs.portrait}.png`]);
    expect(String(nodesOf(graph, 'CLIPTextEncode')[0]!.inputs['text'])).toContain('full body');
    expect(lib.store.images.require(result.imageId).role).toBe('fullbody');
    expect(lib.store.characters.require(aiko.id).refs).toEqual({ portrait: aiko.refs.portrait, fullbody: result.imageId });
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: aiko.id, op: 'updated', mangaId: manga.id });
  });

  it('refuses side and back views before the full body exists', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const err = await generateSlot(ctx(), services, { characterId: aiko.id, slot: 'side' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe("Aiko has no full-body reference yet: generate the sheet's full-body view first");
  });

  it('character.refs makes full body, side and back in order inside one job', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const { ctx: jobCtx, progress } = jobContext(lib.store, 'character.refs', { characterId: aiko.id });
    const result = await generateCharacterRefs(jobCtx, services, { characterId: aiko.id });

    expect(result.imageIds).toHaveLength(3);
    const [fullbody, side, back] = result.imageIds;
    expect(lib.store.characters.require(aiko.id).refs).toEqual({ portrait: aiko.refs.portrait, fullbody, side, back });
    expect(fake.graphs).toHaveLength(3);
    for (const [index, view] of [[1, 'right profile'], [2, 'from directly behind']] as const) {
      const graph = fake.graphs[index]!;
      const encode = nodesOf(graph, 'TextEncodeQwenImageEditPlus')[0]!;
      const loadName = (link: unknown): unknown => graph[(link as [string, number])[0]]!.inputs['image'];
      expect(loadName(encode.inputs['image1'])).toBe(`manga-builder/${aiko.refs.portrait}.png`);
      expect(loadName(encode.inputs['image2'])).toBe(`manga-builder/${fullbody}.png`);
      expect(String(encode.inputs['prompt'])).toContain(view);
      expect(String(encode.inputs['prompt'])).toContain('1girl, silver hair');
    }
    const labels = progress.map((p) => p.label);
    expect(labels.some((l) => l.startsWith('Full body (1/3): '))).toBe(true);
    expect(labels.some((l) => l.startsWith('Side view (2/3): '))).toBe(true);
    expect(labels.some((l) => l.startsWith('Back view (3/3): '))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/character-images.test.ts`
Expected: FAIL — `Failed to load url ../src/handlers/character-images.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/handlers/character-images.ts
import {
  BASE_NEGATIVE, assemblePrompt,
  type Character, type CharacterRefsPayload, type CharacterRefsResult, type ImageGenerateResult, type LoraRef, type Manga,
} from '@manga/shared';
import { generateImage } from '../imaging/generate.js';
import { PORTRAIT_SIZE } from '../imaging/size.js';
import { PermanentError, type JobContext } from '../jobs/index.js';
import { emitEntity, nonEmpty } from './context.js';
import type { HandlerServices } from './types.js';

export const PORTRAIT_SCENE = 'solo, upper body, portrait, looking at viewer, facing viewer, simple background, white background';
export const FULLBODY_SCENE = 'solo, full body, standing, front view, facing viewer, arms at sides, simple background, white background';
export const SHEET_NEGATIVE = 'multiple views, 2girls, 2boys, multiple persons, cropped head, out of frame';
export const VIEW_INSTRUCTION: Record<'side' | 'back', string> = {
  side: 'Show the same character as in picture 1 and picture 2: full body, standing, seen exactly from the side in right profile view, plain white background. Keep the face, hair, outfit and colours exactly as in the pictures.',
  back: 'Show the same character as in picture 1 and picture 2: full body, standing, seen from directly behind (back view, face not visible), plain white background. Keep the hair, outfit and colours exactly as in the pictures.',
};
export const SLOT_LABEL: Record<'fullbody' | 'side' | 'back', string> = { fullbody: 'Full body', side: 'Side view', back: 'Back view' };

/** Recipes that can draw a character from tags alone. */
const PORTRAIT_RECIPES = new Set(['anime', 'anima', 'anima-turbo', 'klein-ref']);

type Slot = 'fullbody' | 'side' | 'back';
interface SlotSpec { recipe: string; prompt: string; negative: string; refImageIds: string[]; loras: LoraRef[] }

function usableImage(ctx: JobContext, id: string | undefined): string | null {
  return id !== undefined && ctx.store.images.get(id) !== null ? id : null;
}

function slotSpec(ctx: JobContext, character: Character, manga: Manga, slot: Slot): SlotSpec {
  const portrait = usableImage(ctx, character.refs.portrait);
  if (!portrait) throw new PermanentError(`${character.name} has no portrait yet: generate portraits and pick one first`);
  if (slot === 'fullbody') {
    const { prompt, negative } = assemblePrompt({
      styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags: [character.appearanceTags].filter(nonEmpty),
      scene: FULLBODY_SCENE, extraNegative: SHEET_NEGATIVE,
    });
    return { recipe: 'anime-ref', prompt, negative, refImageIds: [portrait], loras: manga.styleGuide.loras };
  }
  const fullbody = usableImage(ctx, character.refs.fullbody);
  if (!fullbody) throw new PermanentError(`${character.name} has no full-body reference yet: generate the sheet's full-body view first`);
  const prompt = [VIEW_INSTRUCTION[slot], nonEmpty(character.appearanceTags) ? `Character: ${character.appearanceTags}.` : ''].filter(nonEmpty).join(' ');
  return { recipe: 'qwen-edit-ref', prompt, negative: BASE_NEGATIVE, refImageIds: [portrait, fullbody], loras: [] };
}

export async function generatePortrait(ctx: JobContext, services: HandlerServices, p: { characterId: string; seed?: number | null }): Promise<ImageGenerateResult> {
  const character = ctx.store.characters.require(p.characterId);
  const manga = ctx.store.mangas.require(character.mangaId);
  const recipe = character.recipe && PORTRAIT_RECIPES.has(character.recipe) ? character.recipe : 'anime';
  const { prompt, negative } = assemblePrompt({
    styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags: [character.appearanceTags].filter(nonEmpty),
    scene: PORTRAIT_SCENE, extraNegative: SHEET_NEGATIVE,
  });
  const [width, height] = PORTRAIT_SIZE;
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: manga.id, owner: { type: 'character', id: character.id }, role: 'portrait', recipe, prompt, negative, width, height,
    seed: p.seed ?? character.seed, loras: manga.styleGuide.loras, refImageIds: [], control: null, initImageId: null, denoise: null, upscale: null,
  }, { signal: ctx.signal, progress: ctx.progress });
  emitEntity(ctx.bus, 'image', image.id, 'created', manga.id);
  return { imageId: image.id };
}

export async function generateSlot(ctx: JobContext, services: HandlerServices, p: { characterId: string; slot: Slot }): Promise<ImageGenerateResult> {
  const character = ctx.store.characters.require(p.characterId);
  const manga = ctx.store.mangas.require(character.mangaId);
  const spec = slotSpec(ctx, character, manga, p.slot);
  const [width, height] = PORTRAIT_SIZE;
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: manga.id, owner: { type: 'character', id: character.id }, role: p.slot, recipe: spec.recipe, prompt: spec.prompt,
    negative: spec.negative, width, height, seed: character.seed, loras: spec.loras, refImageIds: spec.refImageIds,
    control: null, initImageId: null, denoise: null, upscale: null,
  }, { signal: ctx.signal, progress: ctx.progress });
  const latest = ctx.store.characters.require(character.id);
  ctx.store.characters.update(character.id, { refs: { ...latest.refs, [p.slot]: image.id } });
  emitEntity(ctx.bus, 'image', image.id, 'created', manga.id);
  emitEntity(ctx.bus, 'character', character.id, 'updated', manga.id);
  return { imageId: image.id };
}

export async function generateCharacterRefs(ctx: JobContext, services: HandlerServices, p: CharacterRefsPayload): Promise<CharacterRefsResult> {
  const slots = ['fullbody', 'side', 'back'] as const;
  const imageIds: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const step: JobContext = {
      ...ctx,
      progress: (label, value, max) => ctx.progress(`${SLOT_LABEL[slot]} (${index + 1}/${slots.length}): ${label}`, value, max),
    };
    imageIds.push((await generateSlot(step, services, { characterId: p.characterId, slot })).imageId);
  }
  return { imageIds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/character-images.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/handlers/character-images.ts packages/server/test/character-images.test.ts
git commit -m "feat(server): character portraits and sheet views (fullbody via anime-ref, side/back via qwen-edit-ref)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: `image.review` and `image.upscale`

**Files:**
- Create: `packages/server/src/handlers/review.ts`, `packages/server/src/handlers/upscale.ts`
- Test: `packages/server/test/review-upscale.test.ts`

**Interfaces:**
- Consumes: `panelContext`, `emitEntity`, `HandlerServices` (Task 17), `loadPrompt`, `scriptBlock` (Task 4), `generateImage` (Task 15), `ReviewIssueKindSchema`, `ImageReviewPayload`, `ImageReviewResult`, `ImageUpscalePayload`, `ImageUpscaleResult`, `ReviewResult`.
- Produces:
  - `ReviewOutputSchema` (`{ pass: boolean; issues: Array<{ kind: ReviewIssueKind; note: string }> }`)
  - `reviewRequest(panel: Panel | null, characters: Character[], referenceNames: string[]): string`
  - `reviewImage(ctx, services, p: ImageReviewPayload): Promise<ImageReviewResult>` — stores `Image.review` with `engine` = the engine that answered
  - `upscaleImage(ctx, services, p: ImageUpscalePayload): Promise<ImageUpscaleResult>` — `source: 'upscaled'`, `parentImageId`, same owner, `role: null`

The reviewer gets the panel script, the character portraits and the image (spec §8). Picture numbering is the same for both engines: `JsonRequest.images = [image, ...portraits]`; Claude receives them as a numbered path list for its Read tool (Task 6), ollama as base64 in the same order (Task 7). The job lane comes from `engines.laneFor('review')` when it is enqueued (Task 22).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/review-upscale.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewImage } from '../src/handlers/review.js';
import { upscaleImage } from '../src/handlers/upscale.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { loadPrompt } from '../src/prompts/load.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedImage, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let comfy: ComfyClient;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 });
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

function panelWithAiko() {
  const { manga, panels } = seedManga(lib.store);
  const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
  const panel = updatePanel(lib.store, panels[0]!.id, {
    action: 'Aiko waves', characters: [{ characterId: aiko.id, pose: 'waving', expression: 'smile', position: 'center' }],
  });
  const image = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null);
  return { manga, aiko, panel, image };
}

describe('image.review', () => {
  it('asks the review engine with the script, the image and the portraits, and stores the verdict', async () => {
    const services = handlerServices(lib.store, comfy, {
      claude: { review: () => ({ pass: false, issues: [{ kind: 'text', note: 'A speech bubble is drawn top left.' }] }) },
    });
    const { manga, aiko, panel, image } = panelWithAiko();
    const { ctx, events } = jobContext(lib.store, 'image.review', { imageId: image.id, panelId: panel.id });
    const result = await reviewImage(ctx, services, { imageId: image.id, panelId: panel.id });

    expect(result).toMatchObject({ engine: 'claude', pass: false, issues: [{ kind: 'text', note: 'A speech bubble is drawn top left.' }] });
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
    expect(lib.store.images.require(image.id).review).toEqual(result);
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'review', task: 'review', system: loadPrompt('review') });
    expect(call.images).toEqual([lib.store.files.abs(image.path), lib.store.files.abs(lib.store.images.require(aiko.refs.portrait!).path)]);
    expect(call.prompt).toContain('- Action: Aiko waves');
    expect(call.prompt).toContain('- Picture 1: the generated image to check.');
    expect(call.prompt).toContain('- Picture 2: reference portrait of Aiko.');
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'updated', mangaId: manga.id });
  });

  it('uses the local engine when the review task is switched to local', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { tasks: { review: 'local' } } });
    const { panel, image } = panelWithAiko();
    const result = await reviewImage(jobContext(lib.store, 'image.review', {}).ctx, services, { imageId: image.id, panelId: panel.id });
    expect(result.engine).toBe('local');
    expect(services.local.calls).toHaveLength(1);
    expect(services.claude.calls).toHaveLength(0);
  });

  it('reviews a character image without a panel and never compares it with itself', async () => {
    const services = handlerServices(lib.store, comfy);
    const { aiko } = panelWithAiko();
    const portraitId = aiko.refs.portrait!;
    await reviewImage(jobContext(lib.store, 'image.review', {}).ctx, services, { imageId: portraitId, panelId: null });
    const call = services.claude.calls[0]!;
    expect(call.prompt).toContain('No panel script: this is a character reference image of Aiko.');
    expect(call.images).toEqual([lib.store.files.abs(lib.store.images.require(portraitId).path)]);
  });

  it('fails without touching the image when the answer stays invalid', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { review: () => ({ pass: 'maybe' }) } });
    const { panel, image } = panelWithAiko();
    const err = await reviewImage(jobContext(lib.store, 'image.review', {}).ctx, services, { imageId: image.id, panelId: panel.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect(lib.store.images.require(image.id).review).toBeNull();
  });
});

describe('image.upscale', () => {
  it('stores a 4x-AnimeSharp upscale as an upscaled child with the same owner', async () => {
    const services = handlerServices(lib.store, comfy);
    const { manga, panels } = seedManga(lib.store);
    const source = seedImage(lib.store, manga.id, { type: 'panel', id: panels[0]!.id }, null, [100, 80]);
    const { ctx, events } = jobContext(lib.store, 'image.upscale', { imageId: source.id, factor: 4 });
    const result = await upscaleImage(ctx, services, { imageId: source.id, factor: 4 });
    const image = lib.store.images.require(result.imageId);
    expect(image).toMatchObject({ ownerType: 'panel', ownerId: panels[0]!.id, role: null, width: 400, height: 320, source: 'upscaled', parentImageId: source.id });
    expect(nodesOf(fake.graphs[0]!, 'ImageUpscaleWithModel')).toHaveLength(1);
    expect(nodesOf(fake.graphs[0]!, 'ImageScaleBy')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'created', mangaId: manga.id });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/review-upscale.test.ts`
Expected: FAIL — `Failed to load url ../src/handlers/review.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/handlers/review.ts
import { z } from 'zod';
import {
  ReviewIssueKindSchema,
  type Character, type ImageReviewPayload, type ImageReviewResult, type Panel, type ReviewResult,
} from '@manga/shared';
import type { JobContext } from '../jobs/index.js';
import { loadPrompt } from '../prompts/load.js';
import { scriptBlock } from '../prompts/script-block.js';
import { emitEntity, panelContext } from './context.js';
import type { HandlerServices } from './types.js';

export const ReviewOutputSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.object({ kind: ReviewIssueKindSchema, note: z.string().min(1) })),
});

export function reviewRequest(panel: Panel | null, characters: Character[], referenceNames: string[]): string {
  const lines = [
    panel
      ? scriptBlock(panel.script, characters)
      : `No panel script: this is a character reference image of ${characters.map((c) => c.name).join(', ') || 'a character'}. Check only character-count, identity, anatomy and text.`,
    '',
    'Pictures:',
    '- Picture 1: the generated image to check.',
  ];
  referenceNames.forEach((name, i) => lines.push(`- Picture ${i + 2}: reference portrait of ${name}.`));
  lines.push('', 'Check picture 1 against the script and the references.');
  return lines.join('\n');
}

export async function reviewImage(ctx: JobContext, services: HandlerServices, p: ImageReviewPayload): Promise<ImageReviewResult> {
  const { store } = ctx;
  const image = store.images.require(p.imageId);
  const panelId = p.panelId ?? (image.ownerType === 'panel' ? image.ownerId : null);
  const pc = panelId ? panelContext(store, panelId) : null;
  const characters = pc ? pc.characters : image.ownerType === 'character' ? [store.characters.require(image.ownerId)] : [];
  const references = characters.flatMap((c) => {
    const ref = c.refs.portrait ? store.images.get(c.refs.portrait) : null;
    return ref && ref.id !== image.id ? [{ name: c.name, path: store.files.abs(ref.path) }] : [];
  });
  const engine = services.engines.for('review');
  ctx.progress(engine.name === 'claude' ? 'Reviewing with Claude' : 'Reviewing with the local model');
  const out = await engine.completeJson({
    name: 'review', task: 'review', system: loadPrompt('review'),
    prompt: reviewRequest(pc?.panel ?? null, characters, references.map((r) => r.name)),
    schema: ReviewOutputSchema, images: [store.files.abs(image.path), ...references.map((r) => r.path)],
    signal: ctx.signal, onProgress: (label) => ctx.progress(label),
  });
  const review: ReviewResult = { engine: engine.name, pass: out.pass, issues: out.issues, at: new Date().toISOString() };
  store.images.update(image.id, { review });
  emitEntity(ctx.bus, 'image', image.id, 'updated', image.mangaId);
  return review;
}
```

```ts
// packages/server/src/handlers/upscale.ts
import type { ImageUpscalePayload, ImageUpscaleResult } from '@manga/shared';
import { generateImage } from '../imaging/generate.js';
import type { JobContext } from '../jobs/index.js';
import { emitEntity } from './context.js';
import type { HandlerServices } from './types.js';

/** Print upscale (spec §9.2): cached as an 'upscaled' Image with parentImageId; M4's export enqueues it. */
export async function upscaleImage(ctx: JobContext, services: HandlerServices, p: ImageUpscalePayload): Promise<ImageUpscaleResult> {
  const source = ctx.store.images.require(p.imageId);
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: source.mangaId, owner: { type: source.ownerType, id: source.ownerId }, role: null, recipe: 'upscale', prompt: '', negative: '',
    width: source.width * p.factor, height: source.height * p.factor, seed: 0, loras: [], refImageIds: [], control: null,
    initImageId: source.id, denoise: null, upscale: p.factor,
  }, { signal: ctx.signal, progress: ctx.progress });
  emitEntity(ctx.bus, 'image', image.id, 'created', source.mangaId);
  return { imageId: image.id };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/review-upscale.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/handlers/review.ts packages/server/src/handlers/upscale.ts packages/server/test/review-upscale.test.ts
git commit -m "feat(server): image review with script and portrait references; 4x-AnimeSharp upscale" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: LLM steps `panel-prompt` and `appearance`

**Files:**
- Create: `packages/server/src/handlers/panel-prompt.ts`, `packages/server/src/handlers/appearance.ts`
- Test: `packages/server/test/llm-steps.test.ts`

**Interfaces:**
- Consumes: `LlmStepHandler` (Task 16), `panelContext`, `pickRefs`, `emitEntity`, `HandlerServices` (Task 17), `routeRecipe`, `promptStyleFor` (Task 14), `RECIPES`, `loadPrompt`, `scriptBlock`, `sanitizeTags`, `sanitizeSentences`, `normalizeAppearanceTags` (Task 4), `InvalidOutputError`, `PermanentError`.
- Produces:
  - `PanelPromptOutputSchema` (`{ scene: string }`), `panelPromptRequest(store, pc, recipeId, style): string`, `panelPromptStep(services): LlmStepHandler` — writes `panel.prompt.scene`, keeps `panel.prompt.negative`, returns `{ scene }`
  - `AppearanceOutputSchema` (`{ appearanceTags: string }`), `appearanceStep(services): LlmStepHandler` — writes `character.appearanceTags`, returns `{ appearanceTags }`

Both use the `prompts` task (spec §9.2 "AI write prompt", §11 "AI suggest … via the prompts task"). The scene style follows the recipe the panel will route to: Danbooru tags for SDXL/Anima, sentences for Qwen/klein (with "picture N shows <name>" so the model can refer to reference pictures without describing them). Whatever comes back is sanitized again in code — the prompt forbids appearance, names and lettering words, and the code removes lettering words regardless.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/llm-steps.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appearanceStep } from '../src/handlers/appearance.js';
import { panelPromptStep } from '../src/handlers/panel-prompt.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { PermanentError } from '../src/jobs/index.js';
import { loadPrompt } from '../src/prompts/load.js';
import { handlerServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
const comfy = new ComfyClient({ url: 'http://127.0.0.1:9', launcher: null });
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

const stage = (characterId: string, position: 'left' | 'center' | 'right' = 'center') => ({ characterId, pose: 'standing', expression: 'calm', position });

describe('llm.step panel-prompt', () => {
  it('writes sanitized Danbooru tags for anime-routed panels without appearance in the request', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { 'panel-prompt': () => ({ scene: 'solo, speech bubble, standing, manga, rooftop, Solo' }) } });
    const { manga, panels } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: '', negative: 'keep me' } });
    const payload = { type: 'panel-prompt' as const, panelId: panel.id };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(panelPromptStep(services)(ctx, payload)).resolves.toEqual({ scene: 'solo, standing, rooftop' });
    expect(lib.store.panels.require(panel.id).prompt).toEqual({ scene: 'solo, standing, rooftop', negative: 'keep me' });
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'panel-prompt', task: 'prompts', system: loadPrompt('panel-prompt-tags') });
    expect(call.prompt).toContain('1. Aiko: position center; pose: standing; expression: calm');
    expect(call.prompt).not.toContain('silver hair');
    expect(call.prompt.endsWith('Write the scene tags for this panel.')).toBe(true);
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: panel.id, op: 'updated', mangaId: manga.id });
  });

  it('writes sentences with picture numbers when the panel routes to qwen-edit-ref', async () => {
    const services = handlerServices(lib.store, comfy, {
      claude: { 'panel-prompt': () => ({ scene: 'The character from picture 1 shouts at the character from picture 2, no speech bubbles.' }) },
    });
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const ren = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Ren', '1boy'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(ren.id, 'right')] }, { refCharacterIds: [aiko.id, ren.id] });
    const payload = { type: 'panel-prompt' as const, panelId: panel.id };
    await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload);
    const call = services.claude.calls[0]!;
    expect(call.system).toBe(loadPrompt('panel-prompt-natural'));
    expect(call.prompt).toContain('- picture 1 shows Aiko');
    expect(call.prompt).toContain('- picture 2 shows Ren');
    expect(lib.store.panels.require(panel.id).prompt.scene).toBe('The character from picture 1 shouts at the character from picture 2.');
  });

  it('refuses an answer made only of forbidden words', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { 'panel-prompt': () => ({ scene: 'manga, speech bubble, text' }) } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    const err = await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect(lib.store.panels.require(panels[0]!.id).prompt.scene).toBe('');
  });

  it('asks the local engine when the prompts task is local', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { tasks: { prompts: 'local' } } });
    const { panels } = seedManga(lib.store);
    const payload = { type: 'panel-prompt' as const, panelId: panels[0]!.id };
    await panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload);
    expect(services.local.calls).toHaveLength(1);
    expect(services.claude.calls).toHaveLength(0);
  });

  it('rejects a payload of another type', async () => {
    const services = handlerServices(lib.store, comfy);
    const payload = { type: 'appearance' as const, characterId: 'cr_other000001', description: 'x' };
    await expect(panelPromptStep(services)(jobContext(lib.store, 'llm.step', payload).ctx, payload)).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('llm.step appearance', () => {
  it('turns a description into normalized appearance tags on the character', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { appearance: () => ({ appearanceTags: '1girl, Silver Hair, twintails, silver hair, manga' }) } });
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const payload = { type: 'appearance' as const, characterId: aiko.id, description: 'A girl with silver twin-tails.' };
    const { ctx, events } = jobContext(lib.store, 'llm.step', payload);
    await expect(appearanceStep(services)(ctx, payload)).resolves.toEqual({ appearanceTags: '1girl, silver hair, twintails' });
    expect(lib.store.characters.require(aiko.id).appearanceTags).toBe('1girl, silver hair, twintails');
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'appearance', task: 'prompts', system: loadPrompt('appearance') });
    expect(call.prompt).toContain('A girl with silver twin-tails.');
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: aiko.id, op: 'updated', mangaId: manga.id });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/llm-steps.test.ts`
Expected: FAIL — `Failed to load url ../src/handlers/appearance.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/handlers/panel-prompt.ts
import { z } from 'zod';
import { InvalidOutputError } from '../engines/errors.js';
import { RECIPES } from '../imaging/recipes/index.js';
import { promptStyleFor, routeRecipe, type PromptStyle } from '../imaging/route.js';
import { PermanentError } from '../jobs/index.js';
import type { LlmStepHandler } from '../jobs/llm-step.js';
import { loadPrompt } from '../prompts/load.js';
import { sanitizeSentences, sanitizeTags } from '../prompts/sanitize.js';
import { scriptBlock } from '../prompts/script-block.js';
import type { Store } from '../store/index.js';
import { emitEntity, panelContext, pickRefs, type PanelContext } from './context.js';
import type { HandlerServices } from './types.js';

export const PanelPromptOutputSchema = z.object({ scene: z.string().min(1) });

export function panelPromptRequest(store: Store, pc: PanelContext, recipeId: string, style: PromptStyle): string {
  const lines = [scriptBlock(pc.panel.script, pc.characters)];
  if (style === 'natural') {
    const recipe = RECIPES[recipeId];
    const picked = recipe ? pickRefs(store, recipe, pc.refCharacters) : [];
    lines.push('', 'Reference pictures:');
    if (picked.length === 0) lines.push('- none');
    picked.forEach((ref, i) => lines.push(`- picture ${i + 1} shows ${ref.character.name}`));
  }
  lines.push('', style === 'tags' ? 'Write the scene tags for this panel.' : 'Write the scene sentences for this panel.');
  return lines.join('\n');
}

export function panelPromptStep(services: HandlerServices): LlmStepHandler {
  return async (ctx, payload) => {
    if (payload.type !== 'panel-prompt') throw new PermanentError(`panel-prompt step received a "${payload.type}" payload`);
    const pc = panelContext(ctx.store, payload.panelId);
    const settings = ctx.store.settings.get();
    const { recipe } = routeRecipe({ settings, manga: pc.manga, panel: pc.panel, refCount: pc.refCharacters.length, charCount: pc.characters.length });
    const style = promptStyleFor(recipe);
    const engine = services.engines.for('prompts');
    ctx.progress('Writing the image prompt');
    const out = await engine.completeJson({
      name: 'panel-prompt', task: 'prompts', system: loadPrompt(style === 'tags' ? 'panel-prompt-tags' : 'panel-prompt-natural'),
      prompt: panelPromptRequest(ctx.store, pc, recipe, style), schema: PanelPromptOutputSchema,
      signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    const scene = style === 'tags' ? sanitizeTags(out.scene) : sanitizeSentences(out.scene);
    if (!scene) throw new InvalidOutputError('panel-prompt: nothing was left of the scene after removing forbidden words', out.scene);
    ctx.store.panels.update(pc.panel.id, { prompt: { scene, negative: pc.panel.prompt.negative } });
    emitEntity(ctx.bus, 'panel', pc.panel.id, 'updated', pc.manga.id);
    return { scene };
  };
}
```

```ts
// packages/server/src/handlers/appearance.ts
import { z } from 'zod';
import { InvalidOutputError } from '../engines/errors.js';
import { PermanentError } from '../jobs/index.js';
import type { LlmStepHandler } from '../jobs/llm-step.js';
import { loadPrompt } from '../prompts/load.js';
import { normalizeAppearanceTags } from '../prompts/sanitize.js';
import { emitEntity } from './context.js';
import type { HandlerServices } from './types.js';

export const AppearanceOutputSchema = z.object({ appearanceTags: z.string().min(1) });

export function appearanceStep(services: HandlerServices): LlmStepHandler {
  return async (ctx, payload) => {
    if (payload.type !== 'appearance') throw new PermanentError(`appearance step received a "${payload.type}" payload`);
    const character = ctx.store.characters.require(payload.characterId);
    const engine = services.engines.for('prompts');
    ctx.progress('Writing appearance tags');
    const out = await engine.completeJson({
      name: 'appearance', task: 'prompts', system: loadPrompt('appearance'),
      prompt: `Character: ${character.name} (${character.role})\n\nDescription:\n${payload.description.trim()}\n\nWrite the appearance tags.`,
      schema: AppearanceOutputSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    const appearanceTags = normalizeAppearanceTags(out.appearanceTags);
    if (!appearanceTags) throw new InvalidOutputError('appearance: no usable tags were left', out.appearanceTags);
    ctx.store.characters.update(character.id, { appearanceTags });
    emitEntity(ctx.bus, 'character', character.id, 'updated', character.mangaId);
    return { appearanceTags };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/llm-steps.test.ts`
Expected: PASS — `Tests  6 passed (6)`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/handlers/panel-prompt.ts packages/server/src/handlers/appearance.ts packages/server/test/llm-steps.test.ts
git commit -m "feat(server): AI panel scene prompts (tags or sentences) and appearance tag suggestions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: M2 services, the `ai` and `imaging` modules, `main.ts` and `MANGA_FAKES=1`

> **Controller ruling (M1 pre-flight F4):** `manga serve` must start the same modules as `main.ts`.
>
> In addition to this task's steps:
> 1. Create `packages/server/src/all-modules.ts` with `export function defaultModules(deps: CoreDeps): AppModule[] { return [aiModule(deps), imagingModule(deps)]; }`.
> 2. Re-export it from `packages/server/src/index.ts`.
> 3. Make `main.ts` pass `modules: defaultModules`, not the inline array.
> 4. In `packages/cli/src/commands/server.ts`, make `serve` call `startServer({ modules: defaultModules })`, importing `defaultModules` from `@manga/server` next to `startServer`.
> 5. Extend the M1 CLI `serve` test, or add one, so it asserts that `GET /api/recipes` is 200 on a `serve`-started server.

**Files:**
- Create: `packages/server/src/handlers/index.ts`
- Create: `packages/server/src/modules/services.ts`, `packages/server/src/modules/ai.ts`, `packages/server/src/modules/imaging.ts`
- Modify: `packages/server/src/main.ts` (the `modules:` line and two imports)
- Create: `packages/server/test/helpers/m2-server.ts`
- Test: `packages/server/test/modules.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–20; `startServer`, `CoreDeps`, `AppModule` (`../app.js`); `JobQueue.register/enqueue/pauseLane/waitFor`, `GpuArbiter.setReleaser/acquire`.
- Produces:
  - `imageGenerateHandler(services): JobHandler`, `registerImagingJobs(queue, services): void`
  - `QUOTA_FALLBACK_MS`; `interface M2Options { fakes?; claude?: TextEngine; local?: TextEngine; comfy?: ComfyClient; claudeBinArgs?: string[] }`
  - `interface M2Services extends HandlerServices { fakes; claude; local; engines; comfy: ComfyClient | null; fakeComfy: FakeComfy | null }`
  - `servicesFor(deps: CoreDeps, opts?: M2Options): M2Services` (memoised per `deps`; `opts` only count on the first call)
  - `aiModule(deps, services = servicesFor(deps)): AppModule`, `imagingModule(deps, services = servicesFor(deps)): AppModule` (Contract C.5)
  - test helper `startM2TestServer(opts?) → M2TestServer { url; deps; services; fake; claude; local; library; api(method, path, body?); close() }`

Wiring (spec §7, brief):
- `aiModule` sets the `ollama` GPU releaser (`OllamaEngine.unload()`: `keep_alive: 0` for loaded models), the `claude`/`ollama` status providers, registers `panel-prompt` and `appearance` with the dispatcher and `llm.step` on the queue.
- `imagingModule` creates the `ComfyClient` (real: with `ComfyLauncher`; fakes: in-process FakeComfy on a random port), sets the `comfy` GPU releaser (`POST /free`) and status provider, and registers `image.generate`, `image.review`, `image.upscale`, `character.refs`.
- `ClaudeEngine.onRateLimit` → `queue.pauseLane('claude', resetsAt ?? now + 15 min, reason)`; the job itself fails with `QuotaExceededError` (a `TransientError`), so the queue retries it with backoff once the lane resumes.
- `MANGA_FAKES=1` → `ScriptedEngine('claude'|'local', FAKE_RESPONSES)` and FakeComfy.

- [ ] **Step 1: Write the server test helper**

```ts
// packages/server/test/helpers/m2-server.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@manga/shared';
import { startServer, type CoreDeps } from '../../src/app.js';
import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import { ComfyClient } from '../../src/imaging/comfy.js';
import { aiModule } from '../../src/modules/ai.js';
import { imagingModule } from '../../src/modules/imaging.js';
import { servicesFor, type M2Options, type M2Services } from '../../src/modules/services.js';
import { startFakeComfy, type FakeComfy } from '../fakes/fake-comfy.js';

export interface M2TestServer {
  url: string;
  deps: CoreDeps;
  services: M2Services;
  fake: FakeComfy;
  claude: ScriptedEngine;
  local: ScriptedEngine;
  library: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export interface M2TestServerOptions {
  claude?: Record<string, ScriptedResponse>;
  local?: Record<string, ScriptedResponse>;
  /** Build the real ClaudeEngine from config.claudeBin (+ services().claudeBinArgs) instead of the scripted one. */
  realClaude?: boolean;
  config?: Partial<AppConfig>;
  services?: (deps: CoreDeps) => Partial<M2Options>;
}

/** A full server on a temp library and a random port, wired to FakeComfy and scripted engines. */
export async function startM2TestServer(opts: M2TestServerOptions = {}): Promise<M2TestServer> {
  const library = mkdtempSync(join(tmpdir(), 'manga-m2-server-'));
  const fake = await startFakeComfy();
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.local });
  const holder: { services?: M2Services } = {};
  const started = await startServer({
    config: { libraryPath: library, port: 0, ...opts.config },
    modules: (deps) => {
      const services = servicesFor(deps, {
        fakes: false, ...(opts.realClaude ? {} : { claude }), local,
        comfy: new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 }), ...opts.services?.(deps),
      });
      holder.services = services;
      return [aiModule(deps, services), imagingModule(deps, services)];
    },
  });
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${started.url}${path}`, {
      method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    url: started.url, deps: started.deps, services: holder.services!, fake, claude, local, library, api,
    async close(): Promise<void> {
      await started.stop();
      await fake.close();
      rmSync(library, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/modules.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceStatus } from '@manga/shared';
import { startServer } from '../src/app.js';
import { OllamaEngine } from '../src/engines/ollama.js';
import { aiModule } from '../src/modules/ai.js';
import { imagingModule } from '../src/modules/imaging.js';
import { servicesFor } from '../src/modules/services.js';
import { startFakeOllama } from './fakes/fake-ollama.js';
import { startM2TestServer, type M2TestServer } from './helpers/m2-server.js';
import { seedManga } from './helpers/seed.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url));

let server: M2TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('M2 modules', () => {
  it('report real service status', async () => {
    server = await startM2TestServer();
    const status = await server.api<ServiceStatus>('GET', '/api/status');
    expect(status.body.claude).toEqual({ ok: true, detail: 'scripted claude engine (fakes)' });
    expect(status.body.ollama).toEqual({ ok: true, detail: 'scripted local engine (fakes)' });
    expect(status.body.comfy).toEqual({ ok: true, detail: 'FakeGPU · 15.0 GB free' });
  });

  it('register the imaging job handlers on the queue', async () => {
    server = await startM2TestServer();
    const { panels } = seedManga(server.deps.store);
    const job = server.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: panels[0]!.id } });
    const done = await server.deps.queue.waitFor(job.id);
    expect(done.status).toBe('succeeded');
    expect(server.deps.store.panels.require(panels[0]!.id).activeImageId).toBe((done.result as { imageId: string }).imageId);
  });

  it('free the other side of the GPU when the owner changes', async () => {
    const ollama = await startFakeOllama();
    try {
      server = await startM2TestServer({
        services: (deps) => ({ local: new OllamaEngine({ url: ollama.url, models: () => deps.store.settings.get().ollama, gpu: deps.gpu }) }),
      });
      await server.deps.gpu.acquire('comfy');
      await server.deps.gpu.acquire('ollama');
      expect(server.fake.calls).toContainEqual({ method: 'POST', path: '/free', body: { unload_models: true, free_memory: true } });
      ollama.loaded.add('qwen3:14b');
      await server.deps.gpu.acquire('comfy');
      expect(ollama.requests.filter((r) => r.path === '/api/generate').map((r) => r.body)).toEqual([{ model: 'qwen3:14b', keep_alive: 0 }]);
    } finally {
      await ollama.close();
    }
  });

  it('pause the claude lane until the reported reset when Claude is out of quota', async () => {
    const record = join(tmpdir(), `claude-record-${process.pid}-${Date.now()}.json`);
    server = await startM2TestServer({
      realClaude: true,
      config: { claudeBin: process.execPath },
      services: () => ({ claudeBinArgs: [FAKE_CLAUDE, fixture('rate-limited'), record] }),
    });
    const { panels } = seedManga(server.deps.store);
    server.deps.queue.enqueue({ kind: 'llm.step', lane: 'claude', payload: { type: 'panel-prompt', panelId: panels[0]!.id } });
    let paused = server.deps.queue.pausedLanes();
    for (let i = 0; i < 200 && paused.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      paused = server.deps.queue.pausedLanes();
    }
    expect(paused).toEqual([{ lane: 'claude', until: '2100-01-01T00:00:00.000Z', reason: 'Claude quota exhausted (five_hour window)' }]);
  });

  it('MANGA_FAKES=1 wires FakeComfy and scripted engines with no options at all', async () => {
    const library = mkdtempSync(join(tmpdir(), 'manga-fakes-'));
    process.env['MANGA_FAKES'] = '1';
    const started = await startServer({ config: { libraryPath: library, port: 0 }, modules: (d) => [aiModule(d), imagingModule(d)] });
    try {
      const status = (await (await fetch(`${started.url}/api/status`)).json()) as ServiceStatus;
      expect(status.comfy.detail).toContain('FakeGPU');
      expect(status.claude.detail).toBe('scripted claude engine (fakes)');
      const { panels } = seedManga(started.deps.store);
      const job = started.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: panels[0]!.id } });
      expect((await started.deps.queue.waitFor(job.id)).status).toBe('succeeded');
      expect(servicesFor(started.deps).fakeComfy).not.toBeNull();
    } finally {
      delete process.env['MANGA_FAKES'];
      await started.stop();
      rmSync(library, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/server/test/modules.test.ts`
Expected: FAIL — `Failed to load url ../../src/modules/ai.js` (imported by the helper).

- [ ] **Step 4: Write the job-handler registration**

```ts
// packages/server/src/handlers/index.ts
import type { CharacterRefsPayload, ImageGeneratePayload, ImageReviewPayload, ImageUpscalePayload } from '@manga/shared';
import { PermanentError, type JobHandler, type JobQueue } from '../jobs/index.js';
import { generateCharacterRefs, generatePortrait, generateSlot } from './character-images.js';
import { generatePanelImage } from './panel-image.js';
import { reviewImage } from './review.js';
import type { HandlerServices } from './types.js';
import { upscaleImage } from './upscale.js';

export function imageGenerateHandler(services: HandlerServices): JobHandler {
  return async (ctx) => {
    const payload = ctx.job.payload as ImageGeneratePayload;
    switch (payload.target) {
      case 'panel':
        return generatePanelImage(ctx, services, payload);
      case 'character-portrait':
        return generatePortrait(ctx, services, payload);
      case 'character-slot':
        return generateSlot(ctx, services, payload);
      default:
        throw new PermanentError(`Unknown image.generate target "${String((payload as { target?: unknown }).target)}"`);
    }
  };
}

export function registerImagingJobs(queue: JobQueue, services: HandlerServices): void {
  queue.register('image.generate', imageGenerateHandler(services));
  queue.register('image.review', (ctx) => reviewImage(ctx, services, ctx.job.payload as ImageReviewPayload));
  queue.register('image.upscale', (ctx) => upscaleImage(ctx, services, ctx.job.payload as ImageUpscalePayload));
  queue.register('character.refs', (ctx) => generateCharacterRefs(ctx, services, ctx.job.payload as CharacterRefsPayload));
}
```

- [ ] **Step 5: Write the services and the two modules**

```ts
// packages/server/src/modules/services.ts
import { join } from 'node:path';
import type { Settings } from '@manga/shared';
import type { CoreDeps } from '../app.js';
import type { FakeComfy } from '../dev/fake-comfy.js';
import { FAKE_RESPONSES } from '../dev/fake-responses.js';
import { ClaudeEngine } from '../engines/claude.js';
import { OllamaEngine } from '../engines/ollama.js';
import { Engines } from '../engines/resolve.js';
import { ScriptedEngine } from '../engines/scripted.js';
import type { TextEngine } from '../engines/types.js';
import type { HandlerServices } from '../handlers/types.js';
import type { ComfyClient } from '../imaging/comfy.js';
import { PermanentError } from '../jobs/index.js';

/** When Claude reports exhaustion without a reset time, the claude lane pauses this long. */
export const QUOTA_FALLBACK_MS = 15 * 60_000;

export interface M2Options {
  /** Default: process.env.MANGA_FAKES === '1'. */
  fakes?: boolean;
  claude?: TextEngine;
  local?: TextEngine;
  comfy?: ComfyClient;
  /** Arguments placed before the claude arguments (tests point claudeBin at node + a fake script). */
  claudeBinArgs?: string[];
}

export interface M2Services extends HandlerServices {
  readonly fakes: boolean;
  readonly claude: TextEngine;
  readonly local: TextEngine;
  readonly engines: HandlerServices['engines'];
  /** Set by imagingModule.register (FakeComfy needs an async start). */
  comfy: ComfyClient | null;
  fakeComfy: FakeComfy | null;
}

const registry = new WeakMap<CoreDeps, M2Services>();

/** One set of M2 services per server, shared by aiModule and imagingModule. */
export function servicesFor(deps: CoreDeps, opts: M2Options = {}): M2Services {
  const existing = registry.get(deps);
  if (existing) return existing;
  const fakes = opts.fakes ?? process.env['MANGA_FAKES'] === '1';
  const settings = (): Settings => deps.store.settings.get();
  const claude = opts.claude ?? (fakes
    ? new ScriptedEngine('claude', FAKE_RESPONSES)
    : new ClaudeEngine({
      bin: deps.config.claudeBin,
      ...(opts.claudeBinArgs ? { binArgs: opts.claudeBinArgs } : {}),
      cwd: deps.store.files.claudeCwd(),
      mangasDir: join(deps.store.files.root, 'mangas'),
      models: () => settings().claude.models,
      onRateLimit: (resetsAt, reason) => {
        deps.queue.pauseLane('claude', resetsAt ? new Date(resetsAt) : new Date(Date.now() + QUOTA_FALLBACK_MS), reason);
      },
    }));
  const local = opts.local ?? (fakes
    ? new ScriptedEngine('local', FAKE_RESPONSES)
    : new OllamaEngine({ url: deps.config.ollamaUrl, models: () => settings().ollama, gpu: deps.gpu }));
  const services: M2Services = {
    fakes, claude, local,
    engines: new Engines({ settings, claude, local }),
    comfy: opts.comfy ?? null,
    fakeComfy: null,
    requireComfy(): ComfyClient {
      if (!services.comfy) throw new PermanentError('The imaging module is not initialised (no ComfyUI client)');
      return services.comfy;
    },
  };
  registry.set(deps, services);
  return services;
}
```

```ts
// packages/server/src/modules/ai.ts
import type { AppModule, CoreDeps } from '../app.js';
import { OllamaEngine } from '../engines/ollama.js';
import { appearanceStep } from '../handlers/appearance.js';
import { panelPromptStep } from '../handlers/panel-prompt.js';
import { llmStepJobHandler, registerLlmStep } from '../jobs/llm-step.js';
import { servicesFor, type M2Services } from './services.js';

export function aiModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  return {
    name: 'ai',
    register(): void {
      const local = services.local;
      deps.gpu.setReleaser('ollama', async () => {
        if (local instanceof OllamaEngine) await local.unload();
      });
      deps.statusProviders.claude = () => services.claude.health();
      deps.statusProviders.ollama = () => services.local.health();
      registerLlmStep('panel-prompt', panelPromptStep(services));
      registerLlmStep('appearance', appearanceStep(services));
      deps.queue.register('llm.step', llmStepJobHandler());
    },
  };
}
```

```ts
// packages/server/src/modules/imaging.ts
import type { AppModule, CoreDeps } from '../app.js';
import { startFakeComfy } from '../dev/fake-comfy.js';
import { registerImagingJobs } from '../handlers/index.js';
import { ComfyClient } from '../imaging/comfy.js';
import { ComfyLauncher } from '../imaging/launcher.js';
import { servicesFor, type M2Services } from './services.js';

export function imagingModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  return {
    name: 'imaging',
    async register(): Promise<void> {
      if (!services.comfy) {
        if (services.fakes) {
          services.fakeComfy = await startFakeComfy();
          services.comfy = new ComfyClient({ url: services.fakeComfy.url, launcher: null, pollMs: 50 });
        } else {
          services.comfy = new ComfyClient({
            url: deps.config.comfyUrl,
            launcher: new ComfyLauncher({ comfyRoot: deps.config.comfyRoot, comfyUrl: deps.config.comfyUrl }),
          });
        }
      }
      const comfy = services.comfy;
      deps.gpu.setReleaser('comfy', () => comfy.free());
      deps.statusProviders.comfy = () => comfy.health();
      registerImagingJobs(deps.queue, services);
    },
    async stop(): Promise<void> {
      await services.fakeComfy?.close();
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/modules.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

- [ ] **Step 7: Switch `main.ts` to the M2 modules**

In `packages/server/src/main.ts` replace `modules: () => []` with `modules: (d) => [aiModule(d), imagingModule(d)]` and add these imports next to the existing ones:

```ts
import { aiModule } from './modules/ai.js';
import { imagingModule } from './modules/imaging.js';
```

Build the server and smoke it in fakes mode:

```bash
npx tsc --build packages/server/tsconfig.json
export MANGA_FAKES=1 MANGA_LIBRARY="$(mktemp -d)" MANGA_PORT=4399
node packages/server/dist/main.js > /tmp/m2-fakes.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4399/api/health > /dev/null && break; sleep 1; done
curl -s http://127.0.0.1:4399/api/status
kill $SERVER_PID
unset MANGA_FAKES MANGA_LIBRARY MANGA_PORT
```

Expected: the `curl` prints JSON containing `"comfy":{"ok":true,"detail":"FakeGPU · 15.0 GB free"}` and `"claude":{"ok":true,"detail":"scripted claude engine (fakes)"}`. (This also proves `loadPrompt` is not needed at startup and FakeComfy runs from `dist/dev/`.)

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test` — Expected: all test files pass (M1 and M2).
Run: `npm run typecheck` — Expected: exit code 0.

```bash
git add packages/server/src/handlers/index.ts packages/server/src/modules packages/server/src/main.ts packages/server/test/helpers/m2-server.ts packages/server/test/modules.test.ts
git commit -m "feat(server): ai and imaging modules, GPU releasers, status providers, quota pause and MANGA_FAKES" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: M2 REST routes

**Files:**
- Create: `packages/server/src/api/reply.ts`, `packages/server/src/api/imaging-routes.ts`, `packages/server/src/api/ai-routes.ts`
- Modify: `packages/server/src/modules/imaging.ts`, `packages/server/src/modules/ai.ts` (register the routes; full new content below)
- Test: `packages/server/test/routes-m2.test.ts`

**Interfaces:**
- Consumes: `GeneratePanelSchema`, `PortraitsSchema`, `SuggestAppearanceSchema`, `ApiErrorBody`, `JobRef`, `JobRefs`, payload types (`@manga/shared`); `RECIPES`, `recipeInfo` (Task 13); `SEED_MODULUS` (Task 15); `M2Services` (Task 21); M1's error handler turns `NotFoundError` into 404 `not_found`.
- Produces (Contract B, M2 rows):

| Route | Behaviour |
|---|---|
| GET `/api/recipes` | `RecipeInfo[]` for the nine recipes |
| POST `/api/characters/:id/portraits` `{n}` | `JobRefs`: n × `image.generate {target:'character-portrait', seed: character.seed + i}` in lane `gpu` |
| POST `/api/characters/:id/sheet` | `JobRef` (`character.refs`, lane `gpu`); 409 `conflict` without a picked portrait |
| POST `/api/characters/:id/suggest-appearance` `{description}` | `JobRef` (`llm.step {type:'appearance'}`, lane `engines.laneFor('prompts')`) |
| POST `/api/panels/:id/generate` `{recipe?, seed?}` | `JobRef` (`image.generate {target:'panel'}`, lane `gpu`); 400 `validation` for an unknown recipe |
| POST `/api/panels/:id/review` | `JobRef` (`image.review`, lane `engines.laneFor('review')`); 409 `conflict` without an active image |
| POST `/api/panels/:id/prompt` | `JobRef` (`llm.step {type:'panel-prompt'}`, lane `engines.laneFor('prompts')`) |

- `sendError(reply, status, code, message, details?): FastifyReply`, `zodMessage(error): string`
- `registerImagingRoutes(app, deps, services)`, `registerAiRoutes(app, deps, services)`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/routes-m2.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Image, JobRef, JobRefs, Panel, RecipeInfo } from '@manga/shared';
import { pngSize } from '../src/imaging/png-size.js';
import { startM2TestServer, type M2TestServer } from './helpers/m2-server.js';
import { giveRefs, seedCharacter, seedManga } from './helpers/seed.js';

let s: M2TestServer;
beforeEach(async () => { s = await startM2TestServer(); });
afterEach(async () => { await s.close(); });

describe('M2 routes', () => {
  it('GET /api/recipes lists the nine recipes', async () => {
    const res = await s.api<RecipeInfo[]>('GET', '/api/recipes');
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id).sort()).toEqual(['anima', 'anima-turbo', 'anime', 'anime-pose', 'anime-ref', 'anime-refine', 'klein-ref', 'qwen-edit-ref', 'upscale']);
    expect(res.body.find((r) => r.id === 'qwen-edit-ref')).toEqual({
      id: 'qwen-edit-ref', label: 'Qwen Image Edit 2511 (1-3 references)', maxRefs: 3, requiresRefs: true,
      supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
    });
  });

  it('portraits enqueue n generate jobs with consecutive seeds and leave the pick to the user', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko', '1girl');
    const res = await s.api<JobRefs>('POST', `/api/characters/${aiko.id}/portraits`, { n: 2 });
    expect(res.status).toBe(200);
    const jobs = await Promise.all(res.body.jobIds.map((id) => s.deps.queue.waitFor(id)));
    expect(jobs.map((j) => [j.kind, j.lane, j.status])).toEqual([['image.generate', 'gpu', 'succeeded'], ['image.generate', 'gpu', 'succeeded']]);
    expect(jobs.map((j) => (j.payload as { seed: number }).seed)).toEqual([1234, 1235]);
    expect(s.deps.store.images.listByOwner('character', aiko.id).map((i) => i.role)).toEqual(['portrait', 'portrait']);
    expect(s.deps.store.characters.require(aiko.id).refs.portrait).toBeUndefined();
    const invalid = await s.api<ApiErrorBody>('POST', `/api/characters/${aiko.id}/portraits`, { n: 9 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation');
  });

  it('sheet needs a picked portrait, then fills fullbody, side and back', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko', '1girl');
    const conflict = await s.api<ApiErrorBody>('POST', `/api/characters/${aiko.id}/sheet`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toEqual({ code: 'conflict', message: 'Aiko has no portrait yet: generate portraits and pick one first' });
    giveRefs(s.deps.store, aiko, ['portrait']);
    const ok = await s.api<JobRef>('POST', `/api/characters/${aiko.id}/sheet`);
    const job = await s.deps.queue.waitFor(ok.body.jobId);
    expect(job).toMatchObject({ kind: 'character.refs', lane: 'gpu', status: 'succeeded' });
    expect(Object.keys(s.deps.store.characters.require(aiko.id).refs).sort()).toEqual(['back', 'fullbody', 'portrait', 'side']);
  });

  it('panel generate validates the recipe and serves the new active image', async () => {
    const { panels } = seedManga(s.deps.store);
    const panelId = panels[0]!.id;
    const bad = await s.api<ApiErrorBody>('POST', `/api/panels/${panelId}/generate`, { recipe: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toContain('Unknown recipe "nope"');
    const ok = await s.api<JobRef>('POST', `/api/panels/${panelId}/generate`, { seed: 5 });
    const job = await s.deps.queue.waitFor(ok.body.jobId);
    expect(job).toMatchObject({ kind: 'image.generate', lane: 'gpu', status: 'succeeded', payload: { target: 'panel', panelId, seed: 5 } });
    const panel = (await s.api<Panel>('GET', `/api/panels/${panelId}`)).body;
    expect(panel.seed).toBe(5);
    const file = await fetch(`${s.url}/files/images/${panel.activeImageId}.png`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('image/png');
    expect(pngSize(new Uint8Array(await file.arrayBuffer())).width).toBeGreaterThan(0);
  });

  it('panel review needs an active image, then stores the verdict', async () => {
    const { panels } = seedManga(s.deps.store);
    const panelId = panels[0]!.id;
    const conflict = await s.api<ApiErrorBody>('POST', `/api/panels/${panelId}/review`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    await s.deps.queue.waitFor((await s.api<JobRef>('POST', `/api/panels/${panelId}/generate`, {})).body.jobId);
    const review = await s.api<JobRef>('POST', `/api/panels/${panelId}/review`);
    const job = await s.deps.queue.waitFor(review.body.jobId);
    expect(job).toMatchObject({ kind: 'image.review', lane: 'claude', status: 'succeeded' });
    const activeId = s.deps.store.panels.require(panelId).activeImageId!;
    expect((await s.api<Image>('GET', `/api/images/${activeId}`)).body.review).toMatchObject({ engine: 'claude', pass: true, issues: [] });
  });

  it('prompt and suggest-appearance run as llm.step in the lane of their engine', async () => {
    const { manga, panels } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko');
    const prompt = await s.api<JobRef>('POST', `/api/panels/${panels[0]!.id}/prompt`);
    const promptJob = await s.deps.queue.waitFor(prompt.body.jobId);
    expect(promptJob).toMatchObject({ kind: 'llm.step', lane: 'claude', status: 'succeeded', payload: { type: 'panel-prompt', panelId: panels[0]!.id } });
    expect(s.deps.store.panels.require(panels[0]!.id).prompt.scene).toBe('solo, standing, school rooftop, chain-link fence, sunset, wind');

    expect((await s.api('PATCH', '/api/settings', { engine: { mode: 'local' } })).status).toBe(200);
    const suggest = await s.api<JobRef>('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: 'silver twin-tails' });
    const suggestJob = await s.deps.queue.waitFor(suggest.body.jobId);
    expect(suggestJob).toMatchObject({ kind: 'llm.step', lane: 'gpu', status: 'succeeded' });
    expect(s.deps.store.characters.require(aiko.id).appearanceTags).toBe('1girl, silver hair, long hair, twintails, amber eyes, red scarf, school uniform, pleated skirt');
    expect(s.local.calls.map((c) => c.name)).toEqual(['appearance']);
    expect((await s.api('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: '' })).status).toBe(400);
  });

  it('answers 404 for unknown ids', async () => {
    const res = await s.api<ApiErrorBody>('POST', '/api/panels/pn_missing0001/generate', {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/routes-m2.test.ts`
Expected: FAIL — the first test gets `404` for `/api/recipes` (routes not registered yet).

- [ ] **Step 3: Write the routes**

```ts
// packages/server/src/api/reply.ts
import type { FastifyReply } from 'fastify';
import type { ApiErrorBody } from '@manga/shared';
import type { z } from 'zod';

export function sendError(reply: FastifyReply, status: number, code: ApiErrorBody['error']['code'], message: string, details?: unknown): FastifyReply {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return reply.code(status).send(body);
}

export function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}
```

```ts
// packages/server/src/api/imaging-routes.ts
import type { FastifyInstance } from 'fastify';
import {
  GeneratePanelSchema, PortraitsSchema,
  type CharacterRefsPayload, type ImageGeneratePayload, type ImageReviewPayload, type JobRef, type JobRefs,
} from '@manga/shared';
import type { CoreDeps } from '../app.js';
import { SEED_MODULUS } from '../imaging/generate.js';
import { RECIPES, recipeInfo } from '../imaging/recipes/index.js';
import type { M2Services } from '../modules/services.js';
import { sendError, zodMessage } from './reply.js';

type IdParams = { Params: { id: string } };

export function registerImagingRoutes(app: FastifyInstance, deps: CoreDeps, services: M2Services): void {
  const { store, queue } = deps;

  app.get('/api/recipes', async () => Object.values(RECIPES).map(recipeInfo));

  app.post<IdParams>('/api/characters/:id/portraits', async (req, reply) => {
    const character = store.characters.require(req.params.id);
    const body = PortraitsSchema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'validation', zodMessage(body.error), body.error.issues);
    const jobIds = Array.from({ length: body.data.n }, (_, i) => {
      const payload: ImageGeneratePayload = { target: 'character-portrait', characterId: character.id, seed: (character.seed + i) % SEED_MODULUS };
      return queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload }).id;
    });
    return { jobIds } satisfies JobRefs;
  });

  app.post<IdParams>('/api/characters/:id/sheet', async (req, reply) => {
    const character = store.characters.require(req.params.id);
    const portrait = character.refs.portrait ? store.images.get(character.refs.portrait) : null;
    if (!portrait) return sendError(reply, 409, 'conflict', `${character.name} has no portrait yet: generate portraits and pick one first`);
    const payload: CharacterRefsPayload = { characterId: character.id };
    return { jobId: queue.enqueue({ kind: 'character.refs', lane: 'gpu', payload }).id } satisfies JobRef;
  });

  app.post<IdParams>('/api/panels/:id/generate', async (req, reply) => {
    const panel = store.panels.require(req.params.id);
    const body = GeneratePanelSchema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'validation', zodMessage(body.error), body.error.issues);
    const { recipe, seed } = body.data;
    if (recipe !== undefined && !RECIPES[recipe]) {
      return sendError(reply, 400, 'validation', `Unknown recipe "${recipe}". Known recipes: ${Object.keys(RECIPES).join(', ')}`);
    }
    const payload: ImageGeneratePayload = {
      target: 'panel', panelId: panel.id, ...(recipe !== undefined ? { recipe } : {}), ...(seed !== undefined ? { seed } : {}),
    };
    return { jobId: queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload }).id } satisfies JobRef;
  });

  app.post<IdParams>('/api/panels/:id/review', async (req, reply) => {
    const panel = store.panels.require(req.params.id);
    if (!panel.activeImageId) return sendError(reply, 409, 'conflict', 'This panel has no image to review yet');
    const payload: ImageReviewPayload = { imageId: panel.activeImageId, panelId: panel.id };
    return { jobId: queue.enqueue({ kind: 'image.review', lane: services.engines.laneFor('review'), payload }).id } satisfies JobRef;
  });
}
```

```ts
// packages/server/src/api/ai-routes.ts
import type { FastifyInstance } from 'fastify';
import { SuggestAppearanceSchema, type JobRef, type LlmStepPayload } from '@manga/shared';
import type { CoreDeps } from '../app.js';
import type { M2Services } from '../modules/services.js';
import { sendError, zodMessage } from './reply.js';

type IdParams = { Params: { id: string } };

export function registerAiRoutes(app: FastifyInstance, deps: CoreDeps, services: M2Services): void {
  const { store, queue } = deps;

  app.post<IdParams>('/api/characters/:id/suggest-appearance', async (req, reply) => {
    const character = store.characters.require(req.params.id);
    const body = SuggestAppearanceSchema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'validation', zodMessage(body.error), body.error.issues);
    const payload: LlmStepPayload = { type: 'appearance', characterId: character.id, description: body.data.description };
    return { jobId: queue.enqueue({ kind: 'llm.step', lane: services.engines.laneFor('prompts'), payload }).id } satisfies JobRef;
  });

  app.post<IdParams>('/api/panels/:id/prompt', async (req) => {
    const panel = store.panels.require(req.params.id);
    const payload: LlmStepPayload = { type: 'panel-prompt', panelId: panel.id };
    return { jobId: queue.enqueue({ kind: 'llm.step', lane: services.engines.laneFor('prompts'), payload }).id } satisfies JobRef;
  });
}
```

- [ ] **Step 4: Register the routes from the modules (full new content of both files)**

```ts
// packages/server/src/modules/imaging.ts
import type { FastifyInstance } from 'fastify';
import type { AppModule, CoreDeps } from '../app.js';
import { registerImagingRoutes } from '../api/imaging-routes.js';
import { startFakeComfy } from '../dev/fake-comfy.js';
import { registerImagingJobs } from '../handlers/index.js';
import { ComfyClient } from '../imaging/comfy.js';
import { ComfyLauncher } from '../imaging/launcher.js';
import { servicesFor, type M2Services } from './services.js';

export function imagingModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  return {
    name: 'imaging',
    async register(app: FastifyInstance): Promise<void> {
      if (!services.comfy) {
        if (services.fakes) {
          services.fakeComfy = await startFakeComfy();
          services.comfy = new ComfyClient({ url: services.fakeComfy.url, launcher: null, pollMs: 50 });
        } else {
          services.comfy = new ComfyClient({
            url: deps.config.comfyUrl,
            launcher: new ComfyLauncher({ comfyRoot: deps.config.comfyRoot, comfyUrl: deps.config.comfyUrl }),
          });
        }
      }
      const comfy = services.comfy;
      deps.gpu.setReleaser('comfy', () => comfy.free());
      deps.statusProviders.comfy = () => comfy.health();
      registerImagingJobs(deps.queue, services);
      registerImagingRoutes(app, deps, services);
    },
    async stop(): Promise<void> {
      await services.fakeComfy?.close();
    },
  };
}
```

```ts
// packages/server/src/modules/ai.ts
import type { FastifyInstance } from 'fastify';
import type { AppModule, CoreDeps } from '../app.js';
import { registerAiRoutes } from '../api/ai-routes.js';
import { OllamaEngine } from '../engines/ollama.js';
import { appearanceStep } from '../handlers/appearance.js';
import { panelPromptStep } from '../handlers/panel-prompt.js';
import { llmStepJobHandler, registerLlmStep } from '../jobs/llm-step.js';
import { servicesFor, type M2Services } from './services.js';

export function aiModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  return {
    name: 'ai',
    register(app: FastifyInstance): void {
      const local = services.local;
      deps.gpu.setReleaser('ollama', async () => {
        if (local instanceof OllamaEngine) await local.unload();
      });
      deps.statusProviders.claude = () => services.claude.health();
      deps.statusProviders.ollama = () => services.local.health();
      registerLlmStep('panel-prompt', panelPromptStep(services));
      registerLlmStep('appearance', appearanceStep(services));
      deps.queue.register('llm.step', llmStepJobHandler());
      registerAiRoutes(app, deps, services);
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/server/test/routes-m2.test.ts packages/server/test/modules.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  12 passed (12)`.

Run: `npm test` — Expected: every test file passes.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/reply.ts packages/server/src/api/imaging-routes.ts packages/server/src/api/ai-routes.ts packages/server/src/modules packages/server/test/routes-m2.test.ts
git commit -m "feat(server): M2 REST routes for recipes, portraits, sheets, panel generate/review/prompt and appearance" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: CLI — `character generate|sheet|suggest`, `panel prompt|generate|review`, `recipes`

**Files:**
- Create: `packages/cli/src/commands/ai.ts`
- Modify: the CLI entry file that calls M1's `register*Commands` (one import + one call)
- Test: `packages/cli/test/ai-commands.test.ts`

**Interfaces:**
- Consumes (Contract D): `ApiClient`, `ApiError` (`src/client.ts`), `CliContext` (`src/context.ts`: `api`, `json`, `out`, `waitJobs`, `resolve`); global options `--json`, `--wait`, `--url`; commander 14 (`optsWithGlobals`, `cmd.error(msg, { exitCode })`). Server test helpers from `packages/server/test/helpers/`.
- Produces:
  - `registerAiCommands(program: Command, ctx: () => Promise<CliContext>): void` — adds to the existing `character` and `panel` groups (creating them if absent), replacing any same-named subcommands, plus top-level `recipes`
  - `finishJobs(c, cmd, jobIds): Promise<void>` (prints `{ jobIds }`, or with `--wait` the finished `Job[]`; sets exit code 1 when a job did not succeed)
  - `describeJob(job: Job): string`, `formatRecipe(r: RecipeInfo): string`

Commands (spec §12): `manga character generate <char> [--n 4] [--manga m]`, `manga character sheet <char> [--manga m]`, `manga character suggest <char> --description ".." [--manga m]`, `manga panel prompt <panel> [--ai | --scene ..]`, `manga panel generate <panel> [--recipe ..] [--seed ..]`, `manga panel review <panel>`, `manga recipes`. Usage errors exit 2; API errors propagate as `ApiError` to M1's entry (exit 1).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/ai-commands.test.ts
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, RecipeInfo } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import type { CliContext } from '../src/context.js';
import { describeJob, registerAiCommands } from '../src/commands/ai.js';
import { startM2TestServer, type M2TestServer } from '../../server/test/helpers/m2-server.js';
import { giveRefs, seedCharacter, seedManga } from '../../server/test/helpers/seed.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function testContext(baseUrl: string, outputs: unknown[]): CliContext {
  const api = new ApiClient(baseUrl);
  return {
    api, json: true, baseUrl,
    out: (data) => { outputs.push(data); },
    waitJobs: async (ids) => {
      const done: Job[] = [];
      for (const id of ids) {
        for (;;) {
          const job = await api.get<Job>(`/api/jobs/${id}`);
          if (TERMINAL.has(job.status)) {
            done.push(job);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return done;
    },
    resolve: {
      manga: (ref) => api.get(`/api/mangas/${ref}`),
      character: (ref) => api.get(`/api/characters/${ref}`),
      chapter: (ref) => api.get(`/api/chapters/${ref}`),
      page: (id) => api.get(`/api/pages/${id}`),
      panel: (id) => api.get(`/api/panels/${id}`),
      frame: (id) => api.get(`/api/frames/${id}`),
    },
  };
}

function program(ctx: CliContext, existing?: (root: Command) => void): Command {
  const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride();
  existing?.(root);
  registerAiCommands(root, async () => ctx);
  return root;
}

let s: M2TestServer;
let outputs: unknown[];
let ctx: CliContext;
beforeEach(async () => {
  s = await startM2TestServer();
  outputs = [];
  ctx = testContext(s.url, outputs);
});
afterEach(async () => { await s.close(); });

describe('manga panel …', () => {
  it('panel generate --wait runs the job end to end', async () => {
    const { panels } = seedManga(s.deps.store);
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'generate', panels[0]!.id, '--seed', '11'], { from: 'user' });
    const jobs = outputs[0] as Job[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'image.generate', status: 'succeeded' });
    const panel = s.deps.store.panels.require(panels[0]!.id);
    expect(panel.activeImageId).toBe((jobs[0]!.result as { imageId: string }).imageId);
    expect(panel.seed).toBe(11);
  });

  it('without --wait prints the job ids', async () => {
    const { panels } = seedManga(s.deps.store);
    await program(ctx).parseAsync(['--json', 'panel', 'generate', panels[0]!.id], { from: 'user' });
    expect(outputs[0]).toEqual({ jobIds: [expect.stringMatching(/^jb_/)] });
  });

  it('panel prompt needs --ai or --scene; --scene edits in place, --ai asks the engine', async () => {
    const { panels } = seedManga(s.deps.store);
    const id = panels[0]!.id;
    await expect(program(ctx).parseAsync(['panel', 'prompt', id], { from: 'user' })).rejects.toMatchObject({ exitCode: 2 });
    await program(ctx).parseAsync(['--json', 'panel', 'prompt', id, '--scene', 'rain, night'], { from: 'user' });
    expect(s.deps.store.panels.require(id).prompt.scene).toBe('rain, night');
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'prompt', id, '--ai'], { from: 'user' });
    expect(s.deps.store.panels.require(id).prompt.scene).toBe('solo, standing, school rooftop, chain-link fence, sunset, wind');
  });

  it('panel review --wait returns the verdict', async () => {
    const { panels } = seedManga(s.deps.store);
    const id = panels[0]!.id;
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'generate', id], { from: 'user' });
    await program(ctx).parseAsync(['--json', '--wait', 'panel', 'review', id], { from: 'user' });
    expect((outputs[1] as Job[])[0]!.result).toMatchObject({ engine: 'claude', pass: true });
  });

  it('replaces a pre-existing subcommand of the same name', async () => {
    const { panels } = seedManga(s.deps.store);
    const root = program(ctx, (r) => {
      r.command('panel').command('prompt <panel>').action(() => { throw new Error('old prompt command'); });
    });
    const panelGroup = root.commands.find((c) => c.name() === 'panel')!;
    expect(panelGroup.commands.filter((c) => c.name() === 'prompt')).toHaveLength(1);
    await root.parseAsync(['--json', 'panel', 'prompt', panels[0]!.id, '--scene', 'x'], { from: 'user' });
    expect(s.deps.store.panels.require(panels[0]!.id).prompt.scene).toBe('x');
  });
});

describe('manga character … and recipes', () => {
  it('generate, suggest and sheet', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko');
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'generate', aiko.id, '--n', '2'], { from: 'user' });
    expect((outputs[0] as Job[]).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'suggest', aiko.id, '--description', 'silver twin-tails'], { from: 'user' });
    expect(s.deps.store.characters.require(aiko.id).appearanceTags).toContain('twintails');
    await expect(program(ctx).parseAsync(['--json', 'character', 'sheet', aiko.id], { from: 'user' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    giveRefs(s.deps.store, s.deps.store.characters.require(aiko.id), ['portrait']);
    await program(ctx).parseAsync(['--json', '--wait', 'character', 'sheet', aiko.id], { from: 'user' });
    expect(Object.keys(s.deps.store.characters.require(aiko.id).refs).sort()).toEqual(['back', 'fullbody', 'portrait', 'side']);
  });

  it('recipes lists all nine', async () => {
    await program(ctx).parseAsync(['--json', 'recipes'], { from: 'user' });
    expect((outputs[0] as RecipeInfo[]).map((r) => r.id)).toContain('qwen-edit-ref');
    expect(outputs[0]).toHaveLength(9);
  });

  it('describeJob summarises results for humans', () => {
    const base = {
      id: 'jb_describe01', kind: 'image.generate', lane: 'gpu', status: 'succeeded', priority: 0, payload: {}, result: null, error: null,
      attempts: 1, maxAttempts: 3, nextRunAt: '', progress: null, episodeRunId: null, createdAt: '', startedAt: null, finishedAt: null,
    } as Job;
    expect(describeJob({ ...base, result: { imageId: 'im_1' } })).toBe('jb_describe01  image im_1');
    expect(describeJob({ ...base, result: { engine: 'claude', pass: false, issues: [{ kind: 'text', note: 'Bubble.' }], at: '' } })).toBe('jb_describe01  fail\n  - text: Bubble.');
    expect(describeJob({ ...base, status: 'failed', error: 'boom' })).toBe('jb_describe01  failed  boom');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/cli/test/ai-commands.test.ts`
Expected: FAIL — `Failed to load url ../src/commands/ai.js`.

- [ ] **Step 3: Write the commands**

```ts
// packages/cli/src/commands/ai.ts
import type { Command } from 'commander';
import type { Character, Job, JobRef, JobRefs, Panel, RecipeInfo, ReviewResult } from '@manga/shared';
import type { CliContext } from '../context.js';

type ContextFactory = () => Promise<CliContext>;

function group(parent: Command, name: string, description: string): Command {
  return parent.commands.find((c) => c.name() === name) ?? parent.command(name).description(description);
}

/** Drops a subcommand an earlier registration (e.g. M1) added under the same name. */
function replace(parent: Command, name: string): void {
  const list = parent.commands as Command[];
  const index = list.findIndex((c) => c.name() === name);
  if (index >= 0) list.splice(index, 1);
}

function wholeNumber(cmd: Command, flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) cmd.error(`${flag} must be a whole number, got "${value}"`, { exitCode: 2 });
  return n;
}

export function describeJob(job: Job): string {
  if (job.status !== 'succeeded') return `${job.id}  ${job.status}${job.error ? `  ${job.error}` : ''}`;
  const r = (typeof job.result === 'object' && job.result !== null ? job.result : {}) as Record<string, unknown>;
  if (typeof r['imageId'] === 'string') return `${job.id}  image ${r['imageId']}`;
  if (Array.isArray(r['imageIds'])) return `${job.id}  images ${(r['imageIds'] as string[]).join(', ')}`;
  if (typeof r['scene'] === 'string') return `${job.id}  scene: ${r['scene']}`;
  if (typeof r['appearanceTags'] === 'string') return `${job.id}  tags: ${r['appearanceTags']}`;
  if (typeof r['pass'] === 'boolean') {
    const issues = (r['issues'] as ReviewResult['issues'] | undefined) ?? [];
    return `${job.id}  ${r['pass'] ? 'pass' : 'fail'}${issues.map((i) => `\n  - ${i.kind}: ${i.note}`).join('')}`;
  }
  return `${job.id}  succeeded`;
}

export function formatRecipe(r: RecipeInfo): string {
  const flags = [
    r.requiresRefs ? 'needs refs' : '', r.supportsPose ? 'pose' : '', r.supportsLineart ? 'lineart' : '',
    r.supportsLoras ? 'loras' : '', r.supportsInit ? 'img2img' : '',
  ].filter(Boolean).join(', ');
  return `${r.id.padEnd(14)} ${r.label}  refs<=${r.maxRefs}${flags ? `  (${flags})` : ''}`;
}

/** Without --wait prints { jobIds }; with --wait streams progress (ctx.waitJobs) and prints the finished jobs. */
export async function finishJobs(c: CliContext, cmd: Command, jobIds: string[]): Promise<void> {
  const wait = Boolean((cmd.optsWithGlobals() as { wait?: boolean }).wait);
  if (!wait) {
    c.out({ jobIds }, () => jobIds.join('\n'));
    return;
  }
  const jobs = await c.waitJobs(jobIds);
  c.out(jobs, () => jobs.map(describeJob).join('\n'));
  const failed = jobs.filter((j) => j.status !== 'succeeded');
  if (failed.length > 0) {
    for (const job of failed) process.stderr.write(`${job.id} ${job.status}${job.error ? `: ${job.error}` : ''}\n`);
    process.exitCode = 1;
  }
}

export function registerAiCommands(program: Command, ctx: ContextFactory): void {
  const character = group(program, 'character', 'Characters');
  for (const name of ['generate', 'sheet', 'suggest']) replace(character, name);

  character.command('generate <char>')
    .description('Generate portrait variants; pick one with `character pick`')
    .option('--n <count>', 'number of variants (1-8)', '4')
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { n: string; manga?: string }, cmd: Command) => {
      const n = wholeNumber(cmd, '--n', opts.n) ?? 4;
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRefs>(`/api/characters/${target.id}/portraits`, { n });
      await finishJobs(c, cmd, res.jobIds);
    });

  character.command('sheet <char>')
    .description('Generate full-body, side and back reference views from the picked portrait')
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { manga?: string }, cmd: Command) => {
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRef>(`/api/characters/${target.id}/sheet`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  character.command('suggest <char>')
    .description('Turn a description into appearance tags (AI)')
    .requiredOption('--description <text>', 'what the character looks like')
    .option('--manga <manga>', 'manga the character belongs to')
    .action(async (ref: string, opts: { description: string; manga?: string }, cmd: Command) => {
      const c = await ctx();
      const target: Character = await c.resolve.character(ref, opts.manga);
      const res = await c.api.post<JobRef>(`/api/characters/${target.id}/suggest-appearance`, { description: opts.description });
      await finishJobs(c, cmd, [res.jobId]);
    });

  const panel = group(program, 'panel', 'Panels');
  for (const name of ['prompt', 'generate', 'review']) replace(panel, name);

  panel.command('prompt <panel>')
    .description('Set the scene prompt by hand (--scene) or let the AI write it (--ai)')
    .option('--ai', 'let the AI write the scene')
    .option('--scene <text>', 'scene text')
    .action(async (id: string, opts: { ai?: boolean; scene?: string }, cmd: Command) => {
      if (opts.ai && opts.scene !== undefined) cmd.error('pass either --ai or --scene, not both', { exitCode: 2 });
      if (!opts.ai && opts.scene === undefined) cmd.error('pass --ai or --scene <text>', { exitCode: 2 });
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      if (opts.scene !== undefined) {
        const updated = await c.api.patch<Panel>(`/api/panels/${target.id}`, { prompt: { scene: opts.scene, negative: target.prompt.negative } });
        c.out(updated, () => updated.prompt.scene);
        return;
      }
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/prompt`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  panel.command('generate <panel>')
    .description('Generate a new image variant for the panel')
    .option('--recipe <id>', 'recipe (see `manga recipes`)')
    .option('--seed <n>', 'seed')
    .action(async (id: string, opts: { recipe?: string; seed?: string }, cmd: Command) => {
      const seed = wholeNumber(cmd, '--seed', opts.seed);
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      const body = { ...(opts.recipe !== undefined ? { recipe: opts.recipe } : {}), ...(seed !== undefined ? { seed } : {}) };
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/generate`, body);
      await finishJobs(c, cmd, [res.jobId]);
    });

  panel.command('review <panel>')
    .description("Ask the AI to check the panel's active image")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const c = await ctx();
      const target: Panel = await c.resolve.panel(id);
      const res = await c.api.post<JobRef>(`/api/panels/${target.id}/review`);
      await finishJobs(c, cmd, [res.jobId]);
    });

  replace(program, 'recipes');
  program.command('recipes')
    .description('List image recipes')
    .action(async () => {
      const c = await ctx();
      const list = await c.api.get<RecipeInfo[]>('/api/recipes');
      c.out(list, () => list.map(formatRecipe).join('\n'));
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/ai-commands.test.ts`
Expected: PASS — `Tests  8 passed (8)`. (Commander prints `error: pass --ai or --scene <text>` to stderr during the usage-error test; that is expected.)

- [ ] **Step 5: Wire the commands into the CLI entry**

Find the entry that registers M1's groups:

```bash
grep -rln "registerPanelCommands" packages/cli/src
```

In that file (not in `src/commands/`), add the import next to the other command imports and the call **after** the existing `register*Commands(...)` calls, using the same program and context-factory variables that the neighbouring calls use:

```ts
import { registerAiCommands } from './commands/ai.js';
// … after the existing register*Commands(program, ctx) calls:
registerAiCommands(program, ctx);
```

(Use the file's real variable names if they are not `program` and `ctx`.) Then:

Run: `npx tsc --build packages/cli/tsconfig.json && node packages/cli/dist/main.js --help` (use the entry path from `packages/cli/package.json` `bin` if it differs)
Expected: the command list includes `recipes`; `node <entry> panel --help` lists `prompt`, `generate` and `review`; `node <entry> character --help` lists `generate`, `sheet` and `suggest`.

Run: `npm test` — Expected: every test file passes. Run: `npm run typecheck` — Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src packages/cli/test/ai-commands.test.ts
git commit -m "feat(cli): character generate/sheet/suggest, panel prompt/generate/review and recipes commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24: Manual live check against real ComfyUI and real Claude, and contract update

This is not part of `npm test`. It proves the recipes and prompts produce usable art on this machine, and it is where the plan's unverified runtime assumptions (the Qwen-Edit custom-size latent, IP-Adapter settings, the `--tools` allowlist under a real login) are confirmed or tuned.

**Files:**
- Modify (only if tuning is needed): the recipe constants from Tasks 12–13 and their tests

- [ ] **Step 1: Confirm the contract already records M2's additions**

The "Contract notes" at the top of this plan were copied into `docs/superpowers/plans/2026-09-27-00-contracts.md` during planning. Confirm, and change nothing if all six match:

```bash
grep -n "id?: string\|M1 does \*\*not\*\* register\|servicesFor\|pollMs?: number\|interrupt(promptId?\|--tools" docs/superpowers/plans/2026-09-27-00-contracts.md
```

Expected: at least six matching lines, one for each of the six additions. If any are missing, add them to the contract in the same wording as the notes at the top of this plan, then commit with `docs(contracts): record M2's additive contract changes`.

- [ ] **Step 2: Preconditions**

```bash
claude auth status
ls /c/Users/roman/Dev/Exalink/claude-image-gen/ComfyUI/custom_nodes/ComfyUI_IPAdapter_plus
ls /c/Users/roman/Dev/Exalink/claude-image-gen/models/unet/qwen-image-edit-2511-Q5_K_M.gguf /c/Users/roman/Dev/Exalink/claude-image-gen/docs/BAKEOFF.md
```

Expected: `"loggedIn": true`; the IPAdapter folder and both files exist. If `loggedIn` is `false`, **stop and ask Roman to run `claude auth login` in a normal terminal** — the server strips the Claude Code host-session variables, so a login that only exists inside the desktop app does not count (this is intended: spec §3.2, subscription auth). If P1 files are missing, stop: P1 is not done.

- [ ] **Step 3: Build, link and point at a throw-away library**

```bash
npm run build
npm run link-cli
export MANGA_LIBRARY="$USERPROFILE/MangaBuilder-live"
export MANGA_PORT=4318
unset MANGA_FAKES
manga status --json
```

Expected: `claude.ok` true; `comfy` either ok or `not running (starts automatically on the first image)`; the CLI auto-started the server (Contract D).

- [ ] **Step 4: A character, end to end**

```bash
manga create "Live Check" --lang en --color bw --dir rtl --style manga-bw --json
manga character add "Live Check" --name Aiko --personality "stubborn, loyal" --json
manga character suggest Aiko --manga "Live Check" --description "A 16-year-old girl with long silver twin-tails, amber eyes, a red scarf over a navy school uniform with a pleated skirt." --wait --json
manga character generate Aiko --manga "Live Check" --n 2 --wait --json
```

Expected: the `suggest` job succeeds with Danbooru-style tags starting `1girl`, no names, none of the forbidden words. Each portrait job succeeds (the first one may show `Starting image server`, up to 240 s). For each `imageId` in the output, **Read the PNG** with the Read tool at `$MANGA_LIBRARY/mangas/<mangaId>/images/<imageId>.png` and judge it: one girl, bust, front view, plain background; silver twin-tails, amber eyes, red scarf, school uniform; black-and-white screentone look; clean hands and face; no text, bubbles or watermark.

- [ ] **Step 5: The character sheet**

```bash
manga character pick Aiko <bestImageId> --slot portrait --manga "Live Check"
manga character sheet Aiko --manga "Live Check" --wait --json
```

Expected: one `character.refs` job succeeds with three `imageIds` (several minutes: Qwen-Edit streams weights). Read all three PNGs: full body front view that is clearly the same girl; a right-profile side view; a back view with the face hidden; outfit and hair identical across them.

- [ ] **Step 6: A panel**

```bash
manga chapter add "Live Check" "Chapter 1" --json
manga page add "Live Check/1" --layout 2-rows --json
manga panel script <panelId> --action "Aiko stands at the school rooftop fence at sunset, the wind pulling her scarf" --shot medium --chars Aiko
curl -s -X PATCH "http://127.0.0.1:4318/api/panels/<panelId>" -H "content-type: application/json" -d '{"refCharacterIds":["<aikoId>"]}'
manga panel prompt <panelId> --ai --wait --json
manga panel generate <panelId> --wait --json
manga panel review <panelId> --wait --json
```

Expected: the prompt job returns tags (no hair/eye/outfit words, no names, no lettering words); the generate job routes to `anime-ref` and produces a landscape image (1216×832). Read it: Aiko recognisably matches her portrait, stands at a fence at sunset, one person, B&W screentone, no text. Compare the review verdict with your own judgement.

- [ ] **Step 7: Tune if needed (at most three rounds per problem), then stop the server**

If an image fails the checks, find the cause before changing anything: open the run in ComfyUI's history (`curl -s http://127.0.0.1:8188/history/<gen.comfyPromptId>`), compare with P1's smoke graph for the same preset, and change only the constant that explains the failure (e.g. `DEFAULT_REF_WEIGHT`, `IPADAPTER.*`, `QWEN_EDIT.*`, the edit-model latent, `REFINE_DENOISE`). Update the matching unit test in the same change, run `npm test`, regenerate, and Read the new image. Commit each tuning separately:

```bash
git add packages/server/src/imaging packages/server/test
git commit -m "tune(imaging): <constant> <old> -> <new> (<what the live image showed>)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Finally stop the live server (pid from `$MANGA_LIBRARY/server.json`):

```bash
taskkill //PID "$(node -e "console.log(require(process.env.MANGA_LIBRARY + '/server.json').pid)")" //F
unset MANGA_LIBRARY MANGA_PORT
```

Report to Roman: which images passed on the first try, what was tuned and why, and the review verdicts next to your own.

