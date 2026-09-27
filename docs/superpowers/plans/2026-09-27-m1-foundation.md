# Manga Builder M1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the manga-builder monorepo foundation — shared schemas and layout engine, SQLite store, REST + WebSocket API, durable job queue, and a `manga` CLI for every non-AI action — fully tested without any AI engine or GPU.

**Architecture:** npm workspaces with three TypeScript ESM packages. `@manga/shared` is pure and browser-safe: zod schemas, API DTOs, events, job payloads, the guillotine layout engine with 16 presets, and prompt helpers. `@manga/server` is a single Fastify 5 process bound to 127.0.0.1. It owns a better-sqlite3 store in the library folder, synchronous domain services, an event bus, a durable job queue with resource lanes, and the REST/WebSocket API. It also serves `packages/ui/dist` when that folder exists. `@manga/cli` is a thin commander client of that API. It auto-starts the server when none is running. Every route follows the same shape: validate the body with a shared zod schema, call one domain function, emit an `entity` event.

**Tech Stack:** Node ≥ 22 (machine: 25.2.1), npm 11.6.2, TypeScript 5.9.3, zod 4, Fastify 5 (+ `@fastify/websocket`, `@fastify/static`, `@fastify/multipart`), better-sqlite3 12, commander 14, ws 8, vitest 3.2.4.

**Spec:** `docs/superpowers/specs/2026-09-27-manga-builder-design.md`. **Binding contracts:** `docs/superpowers/plans/2026-09-27-00-contracts.md`. This plan is milestone **M1**. Every cross-milestone name, type, route and signature below matches the contracts. Where M1 had to add something, the **Contract notes** section lists it.

## Global Constraints

*(Copied verbatim from the contracts' "Global constraints (all milestones)")*

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

**M1 execution constraints (in addition to the above):**

- The dev machine runs Windows 11, Node 25.2.1 and npm 11.6.2. Every command in this plan is written for **Git Bash**. Run commands from the repo root `C:\Users\roman\Dev\Exalink\manga-builder` unless a step says otherwise.
- `better-sqlite3` needs a prebuilt binary for Node 25. Task 1 verifies it right after `npm install`. If the check fails with a "was compiled against a different Node.js version" or "Could not locate the bindings file" error, run `npm rebuild better-sqlite3` (this needs the Visual Studio C++ build tools) and repeat the check.
- Commit with two `-m` flags so the trailer is its own paragraph: `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- One responsibility per file. Tests live in each package's `test/` folder. Helpers live in `test/helpers/` or `test/helpers.ts`, which the vitest include pattern does not pick up as tests.
- `@manga/shared` must never import `node:*` modules. The UI imports it too.
- vitest does not type-check. `npm run build` (`tsc --build`) is the type check. Every task that adds source ends by running it.

## Review Focus

The spec implies these five inputs, but no ordinary happy-path test covers them. They are the most likely to hurt a real user. Each one has a pinning test in the task named at the end of its line.

1. **Applying a preset with fewer panels to a page that already has art.** Without `confirm` the server must refuse with 409 `needs_confirm`, list exactly the panels to be dropped, and change nothing. With `confirm`, surviving panels (mapped in reading order) keep their images. Only the dropped panels' images and files are deleted, and their lettering stays on the page, unanchored. → Task 12 (domain), Task 16 (API), Task 20 (CLI prints the list and exits 1).
2. **Uploading something that is not a PNG/JPEG.** Examples: a text file renamed `.png`, a GIF, a missing `slot`, or a JSON body instead of multipart. The answer must be 400 `validation`, and nothing may be written to the library or the database. → Task 15.
3. **A CLI call while the server is down or `server.json` is stale.** The server may have died, leaving a `server.json` that points at a dead port. The CLI must spawn a server and then talk to the configured port, not the stale one. With an explicit `--url` it must never spawn. If the spawned server does not come up, it must say where the log is. → Task 18.
4. **Ambiguous or differently-cased references.** A user may type `manga show "night market"` when the title is "Night Market", or there may be two mangas with the same title. The CLI must match case-insensitively, refuse an ambiguous name with a clear "use the id" message, and exit 1. → Task 18.
5. **Changing a manga's reading direction after pages exist.** Presets are mirrored for RTL at creation. When `readingDirection` changes, every page layout and text frame of that manga must be mirrored so the story order stays the same. Otherwise every page reads in the wrong order. → Task 13.

## Contract notes (additive changes M1 makes; report upstream)

None of these changes a contract name or signature. Each one adds something the contract left open:

- **C.1 `New*` types** are `Omit<Entity, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }`. The repo assigns `newId()` unless an id is supplied. Panels must use their layout-leaf id, and an image id must exist before its file is written.
- **C.1 `images` repo** update patch is `Partial<Pick<Image, 'review' | 'ownerId'>>` (the contract has `'review'` only). A merge moves the removed panel's variants to the kept panel.
- **C.1 `pages`** gains `listByManga(mangaId)`. It is used by reading-direction mirroring and character deletion.
- **C.1 cascade:** `domain/delete.ts` also exports `deleteCharacter(store, id)`, which strips the character from panel scripts and ref lists, and `deletePanelRows` / `removeFiles` helpers.
- **C.5 `buildApp`** takes an optional third argument `{ uiDir?: string | null }`, and `startServer` options accept `uiDir`, so tests control static serving. `startServer` returns `{ app, deps, url, stop }` as specified.
- **C.5 startup order:** listen first, then run module `start()` hooks and `queue.start()`. A second server that fails with `EADDRINUSE` therefore never resets the running server's jobs.
- **B `GET /api/recipes`:** per the contract update, M1 does **not** register it (M2 owns it; Fastify would throw on a duplicate route). Without M2, it answers the JSON 404.
- **B `GET /api/frames/:id`** is added. `Resolver.frame()` needs it.
- **D `CliContext`** gains `wait: boolean` and `io: CliIo` (stdout/stderr writers plus an optional `AbortSignal`), so commands are testable. `registerServerCommands(program, ctx, io?)` takes `io` because `serve` must not auto-start a server.
- **Package subpaths:** `@manga/server` exports `./config` (`loadConfig`, `readServerInfo`, … without loading SQLite) and `./main` (the entry point the CLI spawns).
- **Library layout:** an auto-started server writes its output to `<library>/logs/server.log`.
- **Root scripts:** M1 ships `build` as `tsc --build`, and M3 appends the UI vite build. `e2e` (M3) and `smoke` (M4) are not added in M1, because their tools do not exist yet. `dev` is `tsc --build --watch` until M3 replaces it.
- **Root `vitest.config.ts`** also aliases `@manga/shared`, `@manga/server` and `@manga/server/config` to their `src/` entry points, so tests never need a prior build. It also sets `hookTimeout: 60_000`.
- **Contract update (M1-affecting), all satisfied:**
  - `store.images.create` keeps an explicit id. Every repo's `create` does.
  - `store/index.ts` re-exports every C.1 name: `openStore`, `NotFoundError` and all store types.
  - `jobs/index.ts` re-exports every C.4 name.
  - M1 does not register `GET /api/recipes`.
  - `startServer({ config: { port: 0 } })` puts the bound port in `url` and `server.json` (tested in Task 14).
  - `deps.statusProviders` is a plain mutable object that modules may reassign (tested in Task 14).
- **Uploaded JPEGs** keep their original bytes at the contract path `…/<imageId>.png`. `/files/images/:id.png` sniffs the bytes and sends `image/jpeg` for them.
- **Prompt stripping:** "manga"/"comic(s)" are stripped from the **scene** text only, because style prompt and character tags must be verbatim.

## File Structure

```
package.json                     root: workspaces, scripts, dev deps
tsconfig.base.json               compiler settings (verbatim from contract)
tsconfig.json                    project references: shared, server, cli
vitest.config.ts                 test include, aliases to src
.gitignore                       + *.tsbuildinfo
README.md                        setup, config, CLI quick reference

packages/shared/                 @manga/shared — pure, browser-safe
  src/index.ts                   re-exports every module
  src/ids.ts                     newId(prefix)
  src/schemas.ts                 zod entity schemas (verbatim from contract A.2)
  src/api.ts                     request DTO schemas + response interfaces (A.3)
  src/events.ts                  ServerEvent union (A.4)
  src/jobs.ts                    job payload/result types (A.7)
  src/layout/index.ts            re-exports tree, rects, presets
  src/layout/tree.ts             LayoutError, panelIds, split/merge/resize, readingOrder, mirror
  src/layout/rects.ts            Rect, computeRects, splitHandles (mm geometry → page-normalized)
  src/layout/presets.ts          16 preset templates, PRESET_NAMES, presetPanelCount, buildPreset
  src/prompt.ts                  BW_TOKENS, BASE_NEGATIVE, assemblePrompt
  src/sizes.ts                   SDXL_SIZES, pickSize
  src/styles.ts                  StylePreset, STYLE_PRESETS
  src/fonts.ts                   FONT_FOR_KIND, DEFAULT_FONT_SIZE, MIN_READABLE_PT, BUNDLED_FONTS
  test/*.test.ts

packages/server/                 @manga/server
  src/index.ts                   public exports
  src/main.ts                    process entry: startServer(), signals
  src/app.ts                     buildApp, startServer (C.5)
  src/deps.ts                    CoreDeps, StatusProviders, AppModule, defaults
  src/config.ts                  loadConfig, configPath (+ re-exports server-info)
  src/server-info.ts             <library>/server.json read/write/remove
  src/version.ts                 VERSION from package.json
  src/errors.ts                  HttpError, NotFoundError, ValidationError, ConflictError, StoreCorruptError
  src/util/defined.ts            defined(): drop undefined keys (exactOptionalPropertyTypes bridge)
  src/files/image-meta.ts        PNG/JPEG header parser, content-type sniffing
  src/store/types.ts             Store, Repo, JobRepo, LibraryFiles, New*/Patch types
  src/store/db.ts                openDatabase (WAL, FKs), migrate, schemaVersion
  src/store/migrations.ts        numbered SQL migrations
  src/store/table.ts             TableRepo: generic row↔entity mapping, zod-validated reads
  src/store/entities.ts          one repo class per entity + createEntityRepos
  src/store/jobs.ts              SqliteJobRepo (claimNext, resetRunning, counts, list)
  src/store/settings.ts          SqliteSettingsRepo, mergeSettings
  src/store/files.ts             createLibraryFiles (LibraryFiles)
  src/store/index.ts             openStore, re-exports
  src/events/bus.ts              EventBus (C.3)
  src/jobs/errors.ts             TransientError, PermanentError
  src/jobs/gpu.ts                GpuArbiter
  src/jobs/queue.ts              JobQueue, JobContext, JobHandler, EnqueueInput
  src/jobs/index.ts              barrel: every C.4 name (errors, GpuArbiter, JobQueue, types)
  src/domain/index.ts            re-exports domain modules
  src/domain/seed.ts             randomSeed
  src/domain/order.ts            chapterPages, renumberPages
  src/domain/panels.ts           newPanelInput, updatePanel
  src/domain/pages.ts            pageDetail, createPage, createCoverPage, applyPreset, split/merge/resize, NeedsConfirmError
  src/domain/mangas.ts           createManga, updateManga (mirrors on direction change), stylePreset
  src/domain/characters.ts       createCharacter, setCharacterRef
  src/domain/chapters.ts         createChapter, reorderPages
  src/domain/frames.ts           createFrame, updateFrame, defaultFrameBox
  src/domain/uploads.ts          saveUploadedImage
  src/domain/delete.ts           deleteManga/Chapter/Page/Character/Image, deletePanelRows, removeFiles
  src/api/errors.ts              toApiError, installErrorHandling
  src/api/util.ts                emitEntity, readUpload, IdParams, OK
  src/api/routes.ts              registerCoreRoutes
  src/api/system.ts              health, status, settings, layouts, style-presets
  src/api/events.ts              WebSocket /api/events
  src/api/static.ts              UI static files, SPA fallback, JSON 404
  src/api/mangas.ts              /api/mangas…
  src/api/characters.ts          /api/mangas/:id/characters, /api/characters…
  src/api/images.ts              /api/images/:id, /files/images/:id.png
  src/api/chapters.ts            /api/mangas/:id/chapters, /api/chapters…
  src/api/pages.ts               /api/pages/:id…, layout ops, frame create
  src/api/panels.ts              /api/panels/:id…
  src/api/frames.ts              /api/frames/:id
  src/api/jobs.ts                /api/jobs…
  test/helpers/{tmp,png,multipart,store,app}.ts
  test/*.test.ts

packages/cli/                    @manga/cli — `manga` binary
  src/index.ts                   #!/usr/bin/env node entry
  src/program.ts                 buildProgram, runCli, exit codes
  src/version.ts                 VERSION
  src/io.ts                      CliIo, processIo, onInterrupt
  src/errors.ts                  CliError
  src/args.ts                    option parsers
  src/format.ts                  table()
  src/client.ts                  ApiClient, ApiError
  src/resolver.ts                Resolver, createResolver
  src/context.ts                 CliContext, createContext
  src/autostart.ts               probeHealth, ensureServer, spawnServerDetached
  src/wait.ts                    waitForJobs, streamJobs, progress formatting
  src/commands/server.ts         serve, status, engine
  src/commands/mangas.ts         create, list, show, rm
  src/commands/characters.ts     character add|upload|pick
  src/commands/chapters.ts       chapter add|list|rm
  src/commands/pages.ts          page add|layout|split|merge|resize|show|rm, layouts
  src/commands/panels.ts         panel script|pick|variants|upload
  src/commands/text.ts           text add|edit|rm
  src/commands/jobs.ts           jobs [--watch], cancel
  test/helpers.ts
  test/*.test.ts
```

---

### Task 1: Monorepo scaffold and `newId`

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/ids.ts`, `packages/shared/src/index.ts`
- Create: `packages/server/package.json`, `packages/cli/package.json` (package manifests only, so one `npm install` covers everything)
- Modify: `.gitignore`
- Test: `packages/shared/test/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `newId(prefix: IdPrefix): string` and `type IdPrefix` from `@manga/shared`. Also the workspace layout and the root scripts `build`, `typecheck`, `test`, `dev`, `start`, `link-cli`.

- [ ] **Step 1: Write the root files**

`package.json`:

```json
{
  "name": "manga-builder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --build --force",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsc --build --watch --preserveWatchOutput",
    "start": "node packages/server/dist/main.js",
    "link-cli": "npm link --workspace @manga/cli"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "24.10.1",
    "@types/ws": "^8.18.1",
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
```

`tsconfig.base.json` (verbatim from the contract):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.json` (Task 7 adds server, Task 18 adds cli):

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" }
  ]
}
```

`vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, never against a stale dist/.
    alias: [
      { find: /^@manga\/shared$/, replacement: src('./packages/shared/src/index.ts') },
      { find: /^@manga\/server\/config$/, replacement: src('./packages/server/src/config.ts') },
      { find: /^@manga\/server$/, replacement: src('./packages/server/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts?(x)'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

Replace `.gitignore` with:

```
node_modules/
dist/
.vite/
*.log
*.tsbuildinfo
coverage/
playwright-report/
test-results/
.env
```

- [ ] **Step 2: Write the package manifests and the shared tsconfig**

`packages/shared/package.json`:

```json
{
  "name": "@manga/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "dependencies": {
    "zod": "^4.1.12"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"]
}
```

`packages/server/package.json`:

```json
{
  "name": "@manga/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./config": {
      "types": "./dist/config.d.ts",
      "default": "./dist/config.js"
    },
    "./main": "./dist/main.js",
    "./package.json": "./package.json"
  },
  "dependencies": {
    "@fastify/multipart": "^9.0.3",
    "@fastify/static": "^8.3.0",
    "@fastify/websocket": "^11.2.0",
    "@manga/shared": "*",
    "better-sqlite3": "^12.4.1",
    "fastify": "^5.6.1",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "ws": "^8.18.3"
  }
}
```

`packages/cli/package.json`:

```json
{
  "name": "@manga/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "manga": "./dist/index.js"
  },
  "dependencies": {
    "@manga/server": "*",
    "@manga/shared": "*",
    "commander": "^14.0.0",
    "ws": "^8.18.3"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: ends with `added N packages` and no `ERR!` lines. `node_modules/@manga/shared`, `node_modules/@manga/server` and `node_modules/@manga/cli` are symlinks into `packages/`. If a caret range fails to resolve, pin the newest available version and note it in the commit message (global constraint).

- [ ] **Step 4: Verify the better-sqlite3 native binary loads on Node 25**

Run:

```bash
node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log('sqlite', db.prepare('select sqlite_version() as v').get().v); db.close();"
```

Expected: `sqlite 3.x.y` (any 3.x version).
If it fails with "Could not locate the bindings file" or "compiled against a different Node.js version", run `npm rebuild better-sqlite3`, then repeat this step. The rebuild needs the Visual Studio C++ build tools; if they are missing, install "Desktop development with C++" and retry. Do not continue until this prints a version.

- [ ] **Step 5: Write the failing test**

`packages/shared/test/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { newId } from '@manga/shared';

describe('newId', () => {
  it('is the prefix, an underscore and 10 base32 characters', () => {
    for (const prefix of ['mg', 'cr', 'ch', 'pg', 'pn', 'tf', 'im', 'jb', 'er'] as const) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[a-z2-7]{10}$`));
    }
  });

  it('does not repeat across 10 000 draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newId('pn'));
    expect(seen.size).toBe(10_000);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/ids.test.ts`
Expected: FAIL. `packages/shared/src/index.ts` cannot be resolved ("Failed to load url" / "Cannot find module").

- [ ] **Step 7: Write the implementation**

`packages/shared/src/ids.ts`:

```ts
export type IdPrefix = 'mg' | 'cr' | 'ch' | 'pg' | 'pn' | 'tf' | 'im' | 'jb' | 'er';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 10 chars from 'abcdefghijklmnopqrstuvwxyz234567' via globalThis.crypto.getRandomValues, e.g. newId('mg') → 'mg_k3j9x2abq7'. */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte & 31);
  return `${prefix}_${out}`;
}
```

`packages/shared/src/index.ts`:

```ts
export * from './ids.js';
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/ids.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Type-check the build**

Run: `npm run build`
Expected: exits 0 with no output. `packages/shared/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts .gitignore packages/shared packages/server/package.json packages/cli/package.json
git commit -m "chore: scaffold npm workspaces and add newId to @manga/shared" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared schemas, API DTOs, events and job payloads

**Files:**
- Create: `packages/shared/src/schemas.ts` (verbatim, contract A.2), `packages/shared/src/api.ts`, `packages/shared/src/events.ts`, `packages/shared/src/jobs.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: everything in contract A.2, A.3, A.4 and A.7, exported from `@manga/shared`. This includes `MangaSchema`, `LayoutNode`, `PageSchema`, `PanelSchema`, `TextFrameSchema`, `ImageSchema`, `JobSchema`, `SettingsSchema`, `SettingsPatchSchema`, `AppConfigSchema`, `DEFAULT_PAGE_FORMAT`, `DEFAULT_SETTINGS`, `EMPTY_SCRIPT` and `DEFAULT_TRANSFORM`. It also includes every request schema (`CreateMangaSchema` … `ExportSchema`), the `PageDetail`, `JobRef(s)`, `PresetInfo`, `RecipeInfo`, `ServiceState`, `ServiceStatus` and `ApiErrorBody` interfaces, `EntityName`, `ServerEvent`, and the job payload types.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  CreateFrameSchema,
  CreateMangaSchema,
  DEFAULT_PAGE_FORMAT,
  DEFAULT_SETTINGS,
  EMPTY_SCRIPT,
  EpisodeInputSchema,
  LayoutNodeSchema,
  PageFormatSchema,
  PanelScriptSchema,
  SettingsPatchSchema,
  SettingsSchema,
  StartEpisodeSchema,
  UpdateMangaSchema,
} from '@manga/shared';

describe('schemas', () => {
  it('accept the defaults they ship with', () => {
    expect(PageFormatSchema.parse(DEFAULT_PAGE_FORMAT)).toEqual(DEFAULT_PAGE_FORMAT);
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(PanelScriptSchema.parse(EMPTY_SCRIPT)).toEqual(EMPTY_SCRIPT);
  });

  it('validate layout trees recursively and reject degenerate ratios and empty ids', () => {
    const ok = {
      type: 'split', dir: 'h', ratio: 0.5,
      a: { type: 'panel', id: 'pn_a' },
      b: { type: 'split', dir: 'v', ratio: 0.3, a: { type: 'panel', id: 'pn_b' }, b: { type: 'panel', id: 'pn_c' } },
    };
    expect(LayoutNodeSchema.parse(ok)).toEqual(ok);
    expect(LayoutNodeSchema.safeParse({ ...ok, ratio: 1 }).success).toBe(false);
    expect(LayoutNodeSchema.safeParse({ ...ok, b: { type: 'panel', id: '' } }).success).toBe(false);
  });

  it('fill request defaults', () => {
    expect(CreateMangaSchema.parse({ title: 'Oni' })).toEqual({
      title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset: 'manga-bw',
    });
    expect(CreateFrameSchema.parse({ kind: 'speech' })).toEqual({
      kind: 'speech', text: '', panelId: null, speakerId: null, rotation: 0, autoFit: true, align: 'center',
    });
    expect(EpisodeInputSchema.parse({ prompt: 'x' })).toEqual({ prompt: 'x', characterIds: [], pages: 8, tone: '' });
    expect(StartEpisodeSchema.parse({ input: { prompt: 'x' } }).mode).toBe('review');
    expect(AppConfigSchema.parse({ libraryPath: '/lib' }).port).toBe(4317);
  });

  it('keep partial updates partial', () => {
    expect(UpdateMangaSchema.parse({ title: 'New' })).toEqual({ title: 'New' });
    expect(SettingsPatchSchema.parse({ engine: { tasks: { story: 'local' } } })).toEqual({ engine: { tasks: { story: 'local' } } });
    expect(SettingsPatchSchema.safeParse({ engine: { mode: 'gpt' } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL. `AppConfigSchema` (and the rest) is not exported: "does not provide an export named" / `undefined` is not a function.

- [ ] **Step 3: Create `packages/shared/src/schemas.ts` verbatim from contract A.2**

```ts
import { z } from 'zod';

export const IdSchema = z.string().min(3);
export const LanguageSchema = z.enum(['en', 'uk']);
export const ColorModeSchema = z.enum(['bw', 'color']);
export const ReadingDirectionSchema = z.enum(['rtl', 'ltr']);
export type Language = z.infer<typeof LanguageSchema>;
export type ColorMode = z.infer<typeof ColorModeSchema>;
export type ReadingDirection = z.infer<typeof ReadingDirectionSchema>;

export const PageFormatSchema = z.object({
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  dpi: z.number().int().positive(),
  marginsMm: z.object({ top: z.number().min(0), bottom: z.number().min(0), inner: z.number().min(0), outer: z.number().min(0) }),
  gutterColMm: z.number().min(0),
  gutterRowMm: z.number().min(0),
  borderMm: z.number().min(0),
});
export type PageFormat = z.infer<typeof PageFormatSchema>;
export const DEFAULT_PAGE_FORMAT: PageFormat = {
  widthMm: 182, heightMm: 257, dpi: 300,
  marginsMm: { top: 12, bottom: 12, inner: 10, outer: 10 },
  gutterColMm: 3, gutterRowMm: 6, borderMm: 0.8,
};

export const LoraRefSchema = z.object({ name: z.string().min(1), strength: z.number().min(-2).max(2) });
export type LoraRef = z.infer<typeof LoraRefSchema>;
export const StyleGuideSchema = z.object({
  recipe: z.string().min(1),
  stylePrompt: z.string(),
  negativePrompt: z.string(),
  loras: z.array(LoraRefSchema),
});
export type StyleGuide = z.infer<typeof StyleGuideSchema>;

const Timestamps = { createdAt: z.string(), updatedAt: z.string() };

export const MangaSchema = z.object({
  id: IdSchema, title: z.string().min(1), synopsis: z.string(),
  language: LanguageSchema, colorMode: ColorModeSchema, readingDirection: ReadingDirectionSchema,
  pageFormat: PageFormatSchema, styleGuide: StyleGuideSchema,
  coverPageId: IdSchema.nullable(), ...Timestamps,
});
export type Manga = z.infer<typeof MangaSchema>;

export const CharacterRoleSchema = z.enum(['main', 'supporting', 'minor']);
export const RefSlotSchema = z.enum(['portrait', 'fullbody', 'side', 'back']);
export type RefSlot = z.infer<typeof RefSlotSchema>;
export const CharacterRefsSchema = z.object({
  portrait: IdSchema.optional(), fullbody: IdSchema.optional(), side: IdSchema.optional(), back: IdSchema.optional(),
});
export const CharacterSchema = z.object({
  id: IdSchema, mangaId: IdSchema, name: z.string().min(1), role: CharacterRoleSchema,
  personality: z.string(), speechStyle: z.string(), appearanceTags: z.string(),
  seed: z.number().int().min(0), recipe: z.string().nullable(), refs: CharacterRefsSchema, ...Timestamps,
});
export type Character = z.infer<typeof CharacterSchema>;

export const ChapterStatusSchema = z.enum(['draft', 'generating', 'ready']);
export const ChapterSchema = z.object({
  id: IdSchema, mangaId: IdSchema, number: z.number().int().min(1), title: z.string().min(1), synopsis: z.string(),
  coverPageId: IdSchema.nullable(), status: ChapterStatusSchema, order: z.number().int().min(0), ...Timestamps,
});
export type Chapter = z.infer<typeof ChapterSchema>;

export type SplitDir = 'h' | 'v';
/** 'h' = horizontal cut: a on top, b below. 'v' = vertical cut: a left, b right (absolute geometry). */
export type LayoutNode =
  | { type: 'panel'; id: string }
  | { type: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };
export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('panel'), id: IdSchema }),
    z.object({ type: z.literal('split'), dir: z.enum(['h', 'v']), ratio: z.number().gt(0).lt(1), a: LayoutNodeSchema, b: LayoutNodeSchema }),
  ]),
);

export const PageKindSchema = z.enum(['page', 'cover']);
export const PageSchema = z.object({
  id: IdSchema, mangaId: IdSchema, chapterId: IdSchema.nullable(), kind: PageKindSchema,
  order: z.number().int().min(0), layout: LayoutNodeSchema, ...Timestamps,
});
export type Page = z.infer<typeof PageSchema>;

export const ShotSchema = z.enum(['extreme-close', 'close', 'medium', 'wide', 'extreme-wide']);
export const AngleSchema = z.enum(['eye', 'low', 'high', 'dutch', 'overhead']);
export const StagePositionSchema = z.enum(['left', 'center', 'right']);
export const DialogueKindSchema = z.enum(['speech', 'thought', 'shout', 'narration', 'sfx']);
export type DialogueKind = z.infer<typeof DialogueKindSchema>;
export const PanelCharacterSchema = z.object({
  characterId: IdSchema, pose: z.string(), expression: z.string(), position: StagePositionSchema,
});
export const DialogueLineSchema = z.object({ speakerId: IdSchema.nullable(), kind: DialogueKindSchema, text: z.string().min(1) });
export type DialogueLine = z.infer<typeof DialogueLineSchema>;
export const PanelScriptSchema = z.object({
  action: z.string(), shot: ShotSchema, angle: AngleSchema,
  characters: z.array(PanelCharacterSchema), background: z.string(), dialogue: z.array(DialogueLineSchema),
});
export type PanelScript = z.infer<typeof PanelScriptSchema>;
export const EMPTY_SCRIPT: PanelScript = { action: '', shot: 'medium', angle: 'eye', characters: [], background: '', dialogue: [] };

/** x,y: offset of the image centre from the panel centre, in panel-normalized units. scale ≥ 1; 1 = cover-fit. */
export const ImageTransformSchema = z.object({ x: z.number(), y: z.number(), scale: z.number().min(1).max(8) });
export type ImageTransform = z.infer<typeof ImageTransformSchema>;
export const DEFAULT_TRANSFORM: ImageTransform = { x: 0, y: 0, scale: 1 };

export const PanelSchema = z.object({
  id: IdSchema, pageId: IdSchema, script: PanelScriptSchema,
  prompt: z.object({ scene: z.string(), negative: z.string() }),
  recipe: z.string().nullable(), seedLock: z.boolean(), seed: z.number().int().min(0),
  refCharacterIds: z.array(IdSchema), activeImageId: IdSchema.nullable(), imageTransform: ImageTransformSchema, ...Timestamps,
});
export type Panel = z.infer<typeof PanelSchema>;

export const FrameKindSchema = z.enum(['speech', 'thought', 'shout', 'narration', 'sfx', 'title']);
export type FrameKind = z.infer<typeof FrameKindSchema>;
/** Page-normalized box: 0..1 of page width/height. */
export const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
export type Box = z.infer<typeof BoxSchema>;
export const PointSchema = z.object({ x: z.number(), y: z.number() });
export const TextFrameSchema = z.object({
  id: IdSchema, pageId: IdSchema, panelId: IdSchema.nullable(), kind: FrameKindSchema, text: z.string(),
  speakerId: IdSchema.nullable(), box: BoxSchema, tail: PointSchema.nullable(), rotation: z.number(),
  font: z.string().min(1), fontSize: z.number().positive(), autoFit: z.boolean(),
  align: z.enum(['left', 'center', 'right']), order: z.number().int().min(0), ...Timestamps,
});
export type TextFrame = z.infer<typeof TextFrameSchema>;

export const ImageOwnerTypeSchema = z.enum(['character', 'panel']);
export const ImageSourceSchema = z.enum(['generated', 'uploaded', 'upscaled']);
export const GenParamsSchema = z.object({
  recipe: z.string(), prompt: z.string(), negative: z.string(), seed: z.number().int().min(0),
  steps: z.number().int().positive(), cfg: z.number(), width: z.number().int().positive(), height: z.number().int().positive(),
  loras: z.array(LoraRefSchema), refs: z.array(IdSchema),
  control: z.object({ kind: z.enum(['pose', 'lineart']), imageId: IdSchema, strength: z.number() }).nullable(),
  initImageId: IdSchema.nullable(), denoise: z.number().nullable(),
  comfyPromptId: z.string(), durationMs: z.number().int().min(0),
});
export type GenParams = z.infer<typeof GenParamsSchema>;
export const ReviewIssueKindSchema = z.enum(['character-count', 'identity', 'anatomy', 'text', 'script-mismatch', 'other']);
export type ReviewIssueKind = z.infer<typeof ReviewIssueKindSchema>;
export const ReviewResultSchema = z.object({
  engine: z.enum(['claude', 'local']), pass: z.boolean(),
  issues: z.array(z.object({ kind: ReviewIssueKindSchema, note: z.string() })), at: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export const ImageSchema = z.object({
  id: IdSchema, mangaId: IdSchema, ownerType: ImageOwnerTypeSchema, ownerId: IdSchema, role: RefSlotSchema.nullable(),
  path: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(),
  source: ImageSourceSchema, parentImageId: IdSchema.nullable(), gen: GenParamsSchema.nullable(),
  review: ReviewResultSchema.nullable(), createdAt: z.string(),
});
export type Image = z.infer<typeof ImageSchema>;

export const JobKindSchema = z.enum(['image.generate', 'image.review', 'image.upscale', 'character.refs', 'llm.step', 'export.render']);
export type JobKind = z.infer<typeof JobKindSchema>;
export const LaneSchema = z.enum(['gpu', 'claude', 'cpu']);
export type Lane = z.infer<typeof LaneSchema>;
export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const JobProgressSchema = z.object({ label: z.string(), value: z.number().optional(), max: z.number().optional() });
export type JobProgress = z.infer<typeof JobProgressSchema>;
export const JobSchema = z.object({
  id: IdSchema, kind: JobKindSchema, lane: LaneSchema, status: JobStatusSchema, priority: z.number().int(),
  payload: z.unknown(), result: z.unknown().nullable(), error: z.string().nullable(),
  attempts: z.number().int().min(0), maxAttempts: z.number().int().min(1), nextRunAt: z.string(),
  progress: JobProgressSchema.nullable(), episodeRunId: IdSchema.nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const EpisodeStepNameSchema = z.enum(['premise', 'outline', 'breakdown', 'scripts', 'prompts', 'render', 'lettering']);
export type EpisodeStepName = z.infer<typeof EpisodeStepNameSchema>;
export const EPISODE_STEPS: EpisodeStepName[] = ['premise', 'outline', 'breakdown', 'scripts', 'prompts', 'render', 'lettering'];
export const REVIEW_POINTS: ReadonlySet<EpisodeStepName> = new Set(['outline', 'scripts', 'render', 'lettering']);
export const StepStatusSchema = z.enum(['pending', 'running', 'awaiting-review', 'done', 'failed']);
export const EpisodeStepSchema = z.object({
  name: EpisodeStepNameSchema, status: StepStatusSchema, output: z.unknown().nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type EpisodeStep = z.infer<typeof EpisodeStepSchema>;
export const EpisodeInputSchema = z.object({
  prompt: z.string().min(1), characterIds: z.array(IdSchema).default([]),
  pages: z.number().int().min(1).max(30).default(8), tone: z.string().default(''),
});
export type EpisodeInput = z.infer<typeof EpisodeInputSchema>;
export const EpisodeRunStatusSchema = z.enum(['running', 'awaiting-review', 'done', 'failed', 'cancelled']);
export const EpisodeRunSchema = z.object({
  id: IdSchema, chapterId: IdSchema, input: EpisodeInputSchema, mode: z.enum(['review', 'autopilot']),
  steps: z.array(EpisodeStepSchema), currentStep: z.number().int().min(0), status: EpisodeRunStatusSchema, ...Timestamps,
});
export type EpisodeRun = z.infer<typeof EpisodeRunSchema>;

export const TaskSchema = z.enum(['story', 'prompts', 'dialogue', 'review']);
export type Task = z.infer<typeof TaskSchema>;
export const EngineNameSchema = z.enum(['claude', 'local']);
export type EngineName = z.infer<typeof EngineNameSchema>;
export const SettingsSchema = z.object({
  engine: z.object({
    mode: EngineNameSchema,
    tasks: z.object({ story: EngineNameSchema.optional(), prompts: EngineNameSchema.optional(), dialogue: EngineNameSchema.optional(), review: EngineNameSchema.optional() }),
  }),
  claude: z.object({ models: z.object({ story: z.string(), dialogue: z.string(), prompts: z.string(), review: z.string() }) }),
  ollama: z.object({ textModel: z.string(), visionModel: z.string() }),
  review: z.object({ autoInEpisode: z.boolean(), rounds: z.number().int().min(0).max(5) }),
  routing: z.object({
    noChars: z.string(), oneChar: z.string(), multiChar: z.string(),
    bwRefine: z.string().nullable(), driftFallback: z.string(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  engine: { mode: 'claude', tasks: {} },
  claude: { models: { story: 'opus', dialogue: 'opus', prompts: 'sonnet', review: 'sonnet' } },
  ollama: { textModel: 'qwen3:14b', visionModel: 'qwen3-vl:8b' },
  review: { autoInEpisode: true, rounds: 2 },
  routing: { noChars: 'anime', oneChar: 'anime-ref', multiChar: 'qwen-edit-ref', bwRefine: 'anime-refine', driftFallback: 'qwen-edit-ref' },
};
/** Each top-level section is optional; within a section every key is optional. `engine.tasks` is replaced whole. */
export const SettingsPatchSchema = z.object({
  engine: z.object({ mode: EngineNameSchema, tasks: SettingsSchema.shape.engine.shape.tasks }).partial().optional(),
  claude: z.object({ models: SettingsSchema.shape.claude.shape.models.partial() }).partial().optional(),
  ollama: SettingsSchema.shape.ollama.partial().optional(),
  review: SettingsSchema.shape.review.partial().optional(),
  routing: SettingsSchema.shape.routing.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const AppConfigSchema = z.object({
  libraryPath: z.string(), port: z.number().int().default(4317),
  comfyRoot: z.string().default('C:/Users/roman/Dev/Exalink/claude-image-gen'),
  comfyUrl: z.string().default('http://127.0.0.1:8188'),
  ollamaUrl: z.string().default('http://127.0.0.1:11434'),
  claudeBin: z.string().default('claude'),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
```

- [ ] **Step 4: Create `packages/shared/src/api.ts` (contract A.3, with the import list filled in)**

```ts
import { z } from 'zod';
import {
  BoxSchema,
  ChapterStatusSchema,
  CharacterRoleSchema,
  ColorModeSchema,
  EpisodeInputSchema,
  FrameKindSchema,
  IdSchema,
  ImageTransformSchema,
  LanguageSchema,
  PageFormatSchema,
  PanelScriptSchema,
  PointSchema,
  ReadingDirectionSchema,
  StyleGuideSchema,
} from './schemas.js';
import type { Image, Lane, Page, Panel, TextFrame } from './schemas.js';

export const CreateMangaSchema = z.object({
  title: z.string().min(1), synopsis: z.string().default(''),
  language: LanguageSchema.default('en'), colorMode: ColorModeSchema.default('bw'),
  readingDirection: ReadingDirectionSchema.default('rtl'), stylePreset: z.string().default('manga-bw'),
});
export const UpdateMangaSchema = z.object({
  title: z.string().min(1), synopsis: z.string(), language: LanguageSchema, colorMode: ColorModeSchema,
  readingDirection: ReadingDirectionSchema, pageFormat: PageFormatSchema, styleGuide: StyleGuideSchema,
}).partial();
export const CreateCharacterSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema.default('supporting'), personality: z.string().default(''),
  speechStyle: z.string().default(''), appearanceTags: z.string().default(''),
  seed: z.number().int().min(0).optional(), recipe: z.string().nullable().default(null),
});
export const UpdateCharacterSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema, personality: z.string(), speechStyle: z.string(),
  appearanceTags: z.string(), seed: z.number().int().min(0), recipe: z.string().nullable(),
}).partial();
export const CreateChapterSchema = z.object({ title: z.string().min(1), synopsis: z.string().default('') });
export const UpdateChapterSchema = z.object({ title: z.string().min(1), synopsis: z.string(), number: z.number().int().min(1), status: ChapterStatusSchema }).partial();
export const CreatePageSchema = z.object({ layoutPreset: z.string().default('2x2'), index: z.number().int().min(0).optional() });
export const ReorderSchema = z.object({ ids: z.array(IdSchema).min(1) });
export const ApplyPresetSchema = z.object({ preset: z.string(), confirm: z.boolean().default(false) });
export const SplitSchema = z.object({ panelId: IdSchema, dir: z.enum(['h', 'v']) });
export const MergeSchema = z.object({ panelIdA: IdSchema, panelIdB: IdSchema });
export const ResizeSchema = z.object({ path: z.array(z.enum(['a', 'b'])), ratio: z.number().gt(0).lt(1) });
export const UpdatePanelSchema = z.object({
  script: PanelScriptSchema, prompt: z.object({ scene: z.string(), negative: z.string() }),
  recipe: z.string().nullable(), seedLock: z.boolean(), seed: z.number().int().min(0),
  refCharacterIds: z.array(IdSchema), activeImageId: IdSchema.nullable(), imageTransform: ImageTransformSchema,
}).partial();
export const CreateFrameSchema = z.object({
  kind: FrameKindSchema, text: z.string().default(''), panelId: IdSchema.nullable().default(null),
  speakerId: IdSchema.nullable().default(null), box: BoxSchema.optional(), tail: PointSchema.nullable().optional(),
  rotation: z.number().default(0), font: z.string().optional(), fontSize: z.number().positive().optional(),
  autoFit: z.boolean().default(true), align: z.enum(['left', 'center', 'right']).default('center'),
});
export const UpdateFrameSchema = z.object({
  kind: FrameKindSchema, text: z.string(), panelId: IdSchema.nullable(), speakerId: IdSchema.nullable(),
  box: BoxSchema, tail: PointSchema.nullable(), rotation: z.number(), font: z.string().min(1),
  fontSize: z.number().positive(), autoFit: z.boolean(), align: z.enum(['left', 'center', 'right']), order: z.number().int().min(0),
}).partial();
export const PickImageSchema = z.object({ imageId: IdSchema });
export const GeneratePanelSchema = z.object({ recipe: z.string().optional(), seed: z.number().int().min(0).optional() });
export const PortraitsSchema = z.object({ n: z.number().int().min(1).max(8).default(4) });
export const SuggestAppearanceSchema = z.object({ description: z.string().min(1) });
export const StartEpisodeSchema = z.object({ input: EpisodeInputSchema, mode: z.enum(['review', 'autopilot']).default('review') });
export const StepOutputSchema = z.object({ output: z.unknown() });
export const RerunStepSchema = z.object({ confirm: z.boolean().default(false) });
export const ExportSchema = z.object({
  target: z.object({ type: z.enum(['page', 'chapter']), id: IdSchema }),
  format: z.enum(['png', 'pdf']).default('pdf'), outDir: z.string().optional(),
});

export interface PageDetail { page: Page; panels: Panel[]; frames: TextFrame[]; images: Record<string, Image> /* active images by id */ }
export interface JobRef { jobId: string }
export interface JobRefs { jobIds: string[] }
export interface PresetInfo { name: string; panelCount: number }
export interface RecipeInfo { id: string; label: string; maxRefs: number; requiresRefs: boolean; supportsPose: boolean; supportsLineart: boolean; supportsLoras: boolean; supportsInit: boolean }
export interface ServiceState { ok: boolean; detail: string }
export interface ServiceStatus { claude: ServiceState; ollama: ServiceState; comfy: ServiceState; queue: { queued: number; running: number; pausedLanes: Array<{ lane: Lane; until: string | null; reason: string }> } }
export interface ApiErrorBody { error: { code: 'not_found' | 'validation' | 'conflict' | 'needs_confirm' | 'engine_unavailable' | 'internal'; message: string; details?: unknown } }
```

- [ ] **Step 5: Create `packages/shared/src/events.ts` and `packages/shared/src/jobs.ts`**

`packages/shared/src/events.ts`:

```ts
import type { ServiceStatus } from './api.js';
import type { Job } from './schemas.js';

export type EntityName = 'manga' | 'character' | 'chapter' | 'page' | 'panel' | 'textFrame' | 'image' | 'episodeRun' | 'settings';
export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'entity'; entity: EntityName; id: string; op: 'created' | 'updated' | 'deleted'; mangaId: string | null }
  | { type: 'status'; status: ServiceStatus }
  | { type: 'hello'; serverTime: string };
```

`packages/shared/src/jobs.ts`:

```ts
import type { EpisodeStepName, ReviewResult } from './schemas.js';

export type ImageGeneratePayload =
  | { target: 'panel'; panelId: string; recipe?: string | null; seed?: number | null; negativeExtra?: string | null; sceneSuffix?: string | null }
  | { target: 'character-portrait'; characterId: string; seed?: number | null }
  | { target: 'character-slot'; characterId: string; slot: 'fullbody' | 'side' | 'back' };
export interface ImageGenerateResult { imageId: string }
export interface ImageReviewPayload { imageId: string; panelId: string | null }
export type ImageReviewResult = ReviewResult;
export interface ImageUpscalePayload { imageId: string; factor: 2 | 4 }
export interface ImageUpscaleResult { imageId: string }
export interface CharacterRefsPayload { characterId: string }                  // generates fullbody → side → back
export interface CharacterRefsResult { imageIds: string[] }
export type LlmStepPayload =
  | { type: 'episode'; runId: string; step: EpisodeStepName }
  | { type: 'panel-prompt'; panelId: string }
  | { type: 'appearance'; characterId: string; description: string };
export interface ExportRenderPayload { target: { type: 'page' | 'chapter'; id: string }; format: 'png' | 'pdf'; outDir?: string }
export interface ExportRenderResult { files: string[] }
```

Replace `packages/shared/src/index.ts` with:

```ts
export * from './ids.js';
export * from './schemas.js';
export * from './api.js';
export * from './events.js';
export * from './jobs.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test`
Expected: PASS (6 tests across `ids.test.ts` and `schemas.test.ts`).

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: exits 0 with no output.

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add entity schemas, API DTOs, server events and job payloads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Layout tree operations

**Files:**
- Create: `packages/shared/src/layout/tree.ts`, `packages/shared/src/layout/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/layout-tree.test.ts`

**Interfaces:**
- Consumes: `LayoutNode`, `SplitDir`, `ReadingDirection` from `schemas.ts`.
- Produces (contract A.5), with every operation pure and returning a new tree:
  - `class LayoutError extends Error { constructor(public code: 'not-found' | 'not-siblings' | 'unknown-preset', message: string) }`
  - `type LayoutErrorCode`, `type SplitPath = Array<'a' | 'b'>`, `MIN_RATIO = 0.08`, `MAX_RATIO = 0.92`
  - `panelIds(tree): string[]`: depth-first, a before b.
  - `splitPanel(tree, panelId, dir, newId): LayoutNode`: ratio 0.5, and the new panel is `b`.
  - `mergePanels(tree, a, b): { tree; keptId: a; removedId: b }`.
  - `resizeSplit(tree, path, ratio): LayoutNode`: clamps to [0.08, 0.92].
  - `readingOrder(tree, dir): string[]`.
  - `mirrorLayout(tree): LayoutNode`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/layout-tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  LayoutError,
  mergePanels,
  mirrorLayout,
  panelIds,
  readingOrder,
  resizeSplit,
  splitPanel,
  type LayoutNode,
} from '@manga/shared';

const P = (id: string): LayoutNode => ({ type: 'panel', id });
const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'h', ratio, a, b });
const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'v', ratio, a, b });

// 2x2: top row (p1 | p2), bottom row (p3 | p4)
const grid = H(0.5, V(0.5, P('p1'), P('p2')), V(0.5, P('p3'), P('p4')));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof LayoutError ? err.code : 'other';
  }
  return undefined;
}

describe('panelIds', () => {
  it('lists leaves depth-first, a before b', () => {
    expect(panelIds(grid)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(panelIds(P('solo'))).toEqual(['solo']);
  });
});

describe('splitPanel', () => {
  it('replaces the leaf with a 50/50 split whose b is the new panel', () => {
    expect(splitPanel(grid, 'p2', 'h', 'p5')).toEqual(
      H(0.5, V(0.5, P('p1'), H(0.5, P('p2'), P('p5'))), V(0.5, P('p3'), P('p4'))),
    );
  });

  it('does not mutate its input', () => {
    const before = structuredClone(grid);
    splitPanel(grid, 'p1', 'v', 'x');
    expect(grid).toEqual(before);
  });

  it('rejects an unknown panel', () => {
    expect(codeOf(() => splitPanel(grid, 'nope', 'h', 'x'))).toBe('not-found');
  });
});

describe('mergePanels', () => {
  it('merges the two leaves of one split, keeping A', () => {
    expect(mergePanels(grid, 'p4', 'p3')).toEqual({
      tree: H(0.5, V(0.5, P('p1'), P('p2')), P('p4')),
      keptId: 'p4',
      removedId: 'p3',
    });
  });

  it('refuses panels that are not siblings', () => {
    expect(codeOf(() => mergePanels(grid, 'p1', 'p3'))).toBe('not-siblings');
    expect(codeOf(() => mergePanels(grid, 'p1', 'p1'))).toBe('not-siblings');
  });

  it('refuses a leaf whose sibling is a subtree', () => {
    const t = H(0.5, P('top'), V(0.5, P('l'), P('r')));
    expect(codeOf(() => mergePanels(t, 'top', 'l'))).toBe('not-siblings');
  });

  it('refuses a panel that is not in the tree', () => {
    expect(codeOf(() => mergePanels(grid, 'p1', 'zz'))).toBe('not-found');
  });
});

describe('resizeSplit', () => {
  it('sets the ratio of the split at the path', () => {
    expect(resizeSplit(grid, ['b'], 0.3)).toEqual(H(0.5, V(0.5, P('p1'), P('p2')), V(0.3, P('p3'), P('p4'))));
    expect(resizeSplit(grid, [], 0.7)).toEqual({ ...grid, ratio: 0.7 });
  });

  it('clamps each side to at least 8% of the parent', () => {
    expect((resizeSplit(grid, [], 0.01) as { ratio: number }).ratio).toBe(0.08);
    expect((resizeSplit(grid, [], 0.999) as { ratio: number }).ratio).toBe(0.92);
  });

  it('rejects a path that does not end on a split', () => {
    expect(codeOf(() => resizeSplit(grid, ['a', 'a'], 0.5))).toBe('not-found');
    expect(codeOf(() => resizeSplit(P('solo'), [], 0.5))).toBe('not-found');
  });
});

describe('readingOrder', () => {
  it('reads top before bottom, left to right in LTR', () => {
    expect(readingOrder(grid, 'ltr')).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('reads top before bottom, right to left in RTL', () => {
    expect(readingOrder(grid, 'rtl')).toEqual(['p2', 'p1', 'p4', 'p3']);
  });

  it('finishes a column before moving across', () => {
    const t = V(0.5, H(0.5, P('l1'), P('l2')), P('right'));
    expect(readingOrder(t, 'rtl')).toEqual(['right', 'l1', 'l2']);
    expect(readingOrder(t, 'ltr')).toEqual(['l1', 'l2', 'right']);
  });
});

describe('mirrorLayout', () => {
  it('swaps the sides of vertical splits and flips their ratio', () => {
    const t = V(0.25, P('narrow'), H(0.5, P('a'), P('b')));
    expect(mirrorLayout(t)).toEqual(V(0.75, H(0.5, P('a'), P('b')), P('narrow')));
  });

  it('is its own inverse, and RTL-reading a mirrored tree equals LTR-reading the original', () => {
    expect(mirrorLayout(mirrorLayout(grid))).toEqual(grid);
    expect(readingOrder(mirrorLayout(grid), 'rtl')).toEqual(readingOrder(grid, 'ltr'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/layout-tree.test.ts`
Expected: FAIL. `LayoutError` / `splitPanel` are not exported.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/layout/tree.ts`:

```ts
import type { LayoutNode, ReadingDirection, SplitDir } from '../schemas.js';

export type LayoutErrorCode = 'not-found' | 'not-siblings' | 'unknown-preset';

export class LayoutError extends Error {
  constructor(public code: LayoutErrorCode, message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/** Steps from the root: 'a' = first child (top/left), 'b' = second child (bottom/right). */
export type SplitPath = Array<'a' | 'b'>;

/** Each side of a split keeps at least 8% of its parent. */
export const MIN_RATIO = 0.08;
export const MAX_RATIO = 0.92;

/** Depth-first, a before b. */
export function panelIds(tree: LayoutNode): string[] {
  return tree.type === 'panel' ? [tree.id] : [...panelIds(tree.a), ...panelIds(tree.b)];
}

function requirePanel(tree: LayoutNode, panelId: string): void {
  if (!panelIds(tree).includes(panelId)) throw new LayoutError('not-found', `panel ${panelId} is not in this layout`);
}

/** Replaces the leaf with a 50/50 split; the existing panel becomes `a`, the new one `b`. */
export function splitPanel(tree: LayoutNode, panelId: string, dir: SplitDir, newId: string): LayoutNode {
  requirePanel(tree, panelId);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'panel') {
      return node.id === panelId ? { type: 'split', dir, ratio: 0.5, a: node, b: { type: 'panel', id: newId } } : node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(tree);
}

/** Merges two panels that are the two leaves of the same split. Keeps A's id (and so A's content). */
export function mergePanels(tree: LayoutNode, a: string, b: string): { tree: LayoutNode; keptId: string; removedId: string } {
  requirePanel(tree, a);
  requirePanel(tree, b);
  let merged = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'panel') return node;
    const left = node.a;
    const right = node.b;
    if (
      left.type === 'panel' && right.type === 'panel' &&
      ((left.id === a && right.id === b) || (left.id === b && right.id === a))
    ) {
      merged = true;
      return { type: 'panel', id: a };
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  const next = walk(tree);
  if (!merged) throw new LayoutError('not-siblings', `panels ${a} and ${b} are not the two halves of one split`);
  return { tree: next, keptId: a, removedId: b };
}

function describePath(path: SplitPath): string {
  return path.length === 0 ? 'root' : path.join('');
}

/** Sets the ratio of the split at `path`, clamped to [MIN_RATIO, MAX_RATIO]. */
export function resizeSplit(tree: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  if (!Number.isFinite(ratio)) throw new RangeError('ratio must be a finite number');
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const walk = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.type === 'panel') throw new LayoutError('not-found', `no split at path ${describePath(path)}`);
    if (depth === path.length) return { ...node, ratio: clamped };
    return path[depth] === 'a' ? { ...node, a: walk(node.a, depth + 1) } : { ...node, b: walk(node.b, depth + 1) };
  };
  return walk(tree, 0);
}

/** Depth-first, top before bottom; across a vertical cut, right before left in RTL and left before right in LTR. */
export function readingOrder(tree: LayoutNode, dir: ReadingDirection): string[] {
  if (tree.type === 'panel') return [tree.id];
  const rightFirst = tree.dir === 'v' && dir === 'rtl';
  const first = rightFirst ? tree.b : tree.a;
  const second = rightFirst ? tree.a : tree.b;
  return [...readingOrder(first, dir), ...readingOrder(second, dir)];
}

/** Mirrors left↔right: swaps a/b of every 'v' split and sets ratio → 1 - ratio. 'h' splits keep their order. */
export function mirrorLayout(tree: LayoutNode): LayoutNode {
  if (tree.type === 'panel') return tree;
  if (tree.dir === 'v') {
    return { type: 'split', dir: 'v', ratio: 1 - tree.ratio, a: mirrorLayout(tree.b), b: mirrorLayout(tree.a) };
  }
  return { ...tree, a: mirrorLayout(tree.a), b: mirrorLayout(tree.b) };
}
```

`packages/shared/src/layout/index.ts`:

```ts
export * from './tree.js';
```

Replace `packages/shared/src/index.ts` with:

```ts
export * from './ids.js';
export * from './schemas.js';
export * from './api.js';
export * from './events.js';
export * from './jobs.js';
export * from './layout/index.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/layout-tree.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add layout tree operations (split, merge, resize, reading order, mirror)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Layout geometry — `computeRects` and `splitHandles`

**Files:**
- Create: `packages/shared/src/layout/rects.ts`
- Modify: `packages/shared/src/layout/index.ts`
- Test: `packages/shared/test/layout-rects.test.ts`

**Interfaces:**
- Consumes: `LayoutNode`, `PageFormat`, `SplitDir`, and `SplitPath` from `tree.ts`.
- Produces:
  - `interface Rect { x: number; y: number; w: number; h: number }`: page-normalized.
  - `computeRects(tree, format): Array<{ panelId: string; rect: Rect }>`: in `panelIds` order.
  - `splitHandles(tree, format): Array<{ path: SplitPath; dir: SplitDir; ratio: number; parent: Rect; gutter: Rect }>`: pre-order, root first.
- Geometry rules, from the contract:
  - The left margin is `marginsMm.inner` and the right margin is `marginsMm.outer`.
  - Each gutter is centred on its cut: `gutterRowMm` for `'h'` cuts and `gutterColMm` for `'v'` cuts.
  - The cut sits at `parent.start + parent.size × ratio`.
  - Rects are divided by the page `widthMm` / `heightMm`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/layout-rects.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeRects, DEFAULT_PAGE_FORMAT, splitHandles, type LayoutNode, type Rect } from '@manga/shared';

const F = DEFAULT_PAGE_FORMAT; // 182×257 mm; margins top/bottom 12, inner/outer 10; gutters col 3, row 6
const P = (id: string): LayoutNode => ({ type: 'panel', id });
const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'h', ratio, a, b });
const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'v', ratio, a, b });
const mm = (x: number, y: number, w: number, h: number): Rect => ({ x: x / 182, y: y / 257, w: w / 182, h: h / 257 });
const grid = H(0.5, V(0.5, P('tl'), P('tr')), V(0.5, P('bl'), P('br')));

function expectRect(actual: Rect | undefined, expected: Rect): void {
  expect(actual).toBeDefined();
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(actual?.[k]).toBeCloseTo(expected[k], 9);
}

describe('computeRects', () => {
  it('fills the area inside the margins with a single panel', () => {
    const rects = computeRects(P('solo'), F);
    expect(rects.map((r) => r.panelId)).toEqual(['solo']);
    expectRect(rects[0]?.rect, mm(10, 12, 162, 233));
  });

  it('centres a 6 mm row gutter and a 3 mm column gutter on each cut', () => {
    const rects = new Map(computeRects(grid, F).map((r) => [r.panelId, r.rect]));
    expectRect(rects.get('tl'), mm(10, 12, 79.5, 113.5));
    expectRect(rects.get('tr'), mm(92.5, 12, 79.5, 113.5));
    expectRect(rects.get('bl'), mm(10, 131.5, 79.5, 113.5));
    expectRect(rects.get('br'), mm(92.5, 131.5, 79.5, 113.5));
  });

  it('places the cut at the ratio of the parent', () => {
    // cut at 12 + 233 × 0.25 = 70.25 mm; gutter 67.25 … 73.25
    const rects = computeRects(H(0.25, P('top'), P('rest')), F);
    expectRect(rects[0]?.rect, mm(10, 12, 162, 55.25));
    expectRect(rects[1]?.rect, mm(10, 73.25, 162, 171.75));
  });

  it('uses marginsMm.inner on the left and marginsMm.outer on the right', () => {
    const f = { ...F, marginsMm: { top: 0, bottom: 0, inner: 20, outer: 5 } };
    expectRect(computeRects(P('x'), f)[0]?.rect, { x: 20 / 182, y: 0, w: 157 / 182, h: 1 });
  });
});

describe('splitHandles', () => {
  it('describes every split with its path, parent rect and gutter rect, root first', () => {
    const handles = splitHandles(grid, F);
    expect(handles.map((h) => [h.path.join(''), h.dir, h.ratio])).toEqual([['', 'h', 0.5], ['a', 'v', 0.5], ['b', 'v', 0.5]]);
    expectRect(handles[0]?.parent, mm(10, 12, 162, 233));
    expectRect(handles[0]?.gutter, mm(10, 125.5, 162, 6));
    expectRect(handles[1]?.parent, mm(10, 12, 162, 113.5));
    expectRect(handles[1]?.gutter, mm(89.5, 12, 3, 113.5));
    expectRect(handles[2]?.parent, mm(10, 131.5, 162, 113.5));
  });

  it('is empty for a single panel', () => {
    expect(splitHandles(P('solo'), F)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/layout-rects.test.ts`
Expected: FAIL. `computeRects` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/layout/rects.ts`:

```ts
import type { LayoutNode, PageFormat, SplitDir } from '../schemas.js';
import type { SplitPath } from './tree.js';

/** Page-normalized: 0..1 of the page width (x, w) and height (y, h). */
export interface Rect { x: number; y: number; w: number; h: number }

/** The same shape in millimetres, used while walking the tree. */
type MmRect = Rect;

function contentArea(f: PageFormat): MmRect {
  return {
    x: f.marginsMm.inner,
    y: f.marginsMm.top,
    w: f.widthMm - f.marginsMm.inner - f.marginsMm.outer,
    h: f.heightMm - f.marginsMm.top - f.marginsMm.bottom,
  };
}

/** Cuts `r` at `ratio`, with the gutter centred on the cut line. */
function cut(r: MmRect, dir: SplitDir, ratio: number, f: PageFormat): { a: MmRect; b: MmRect; gutter: MmRect } {
  if (dir === 'h') {
    const g = f.gutterRowMm;
    const at = r.y + r.h * ratio;
    return {
      a: { x: r.x, y: r.y, w: r.w, h: Math.max(0, r.h * ratio - g / 2) },
      b: { x: r.x, y: at + g / 2, w: r.w, h: Math.max(0, r.h * (1 - ratio) - g / 2) },
      gutter: { x: r.x, y: at - g / 2, w: r.w, h: g },
    };
  }
  const g = f.gutterColMm;
  const at = r.x + r.w * ratio;
  return {
    a: { x: r.x, y: r.y, w: Math.max(0, r.w * ratio - g / 2), h: r.h },
    b: { x: at + g / 2, y: r.y, w: Math.max(0, r.w * (1 - ratio) - g / 2), h: r.h },
    gutter: { x: at - g / 2, y: r.y, w: g, h: r.h },
  };
}

function normalize(r: MmRect, f: PageFormat): Rect {
  return { x: r.x / f.widthMm, y: r.y / f.heightMm, w: r.w / f.widthMm, h: r.h / f.heightMm };
}

/** One rect per panel, in panelIds order, after margins, gutters and ratios. */
export function computeRects(tree: LayoutNode, format: PageFormat): Array<{ panelId: string; rect: Rect }> {
  const out: Array<{ panelId: string; rect: Rect }> = [];
  const walk = (node: LayoutNode, area: MmRect): void => {
    if (node.type === 'panel') {
      out.push({ panelId: node.id, rect: normalize(area, format) });
      return;
    }
    const parts = cut(area, node.dir, node.ratio, format);
    walk(node.a, parts.a);
    walk(node.b, parts.b);
  };
  walk(tree, contentArea(format));
  return out;
}

/** One entry per split (pre-order): where it is, its parent area and its gutter, for drag handles. */
export function splitHandles(
  tree: LayoutNode,
  format: PageFormat,
): Array<{ path: SplitPath; dir: SplitDir; ratio: number; parent: Rect; gutter: Rect }> {
  const out: Array<{ path: SplitPath; dir: SplitDir; ratio: number; parent: Rect; gutter: Rect }> = [];
  const walk = (node: LayoutNode, area: MmRect, path: SplitPath): void => {
    if (node.type === 'panel') return;
    const parts = cut(area, node.dir, node.ratio, format);
    out.push({ path, dir: node.dir, ratio: node.ratio, parent: normalize(area, format), gutter: normalize(parts.gutter, format) });
    walk(node.a, parts.a, [...path, 'a']);
    walk(node.b, parts.b, [...path, 'b']);
  };
  walk(tree, contentArea(format), []);
  return out;
}
```

Replace `packages/shared/src/layout/index.ts` with:

```ts
export * from './tree.js';
export * from './rects.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/layout-rects.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): compute panel rects and split handles with margins and centred gutters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Layout presets

**Files:**
- Create: `packages/shared/src/layout/presets.ts`
- Modify: `packages/shared/src/layout/index.ts`
- Test: `packages/shared/test/layout-presets.test.ts`

**Interfaces:**
- Consumes: `LayoutError`, `mirrorLayout`, `LayoutNode`, `ReadingDirection`.
- Produces:
  - `PRESET_NAMES: readonly string[]`: the 16 names, in spec order.
  - `presetPanelCount(name): number`.
  - `buildPreset(name, dir, newId: () => string): LayoutNode`. Ids are assigned depth-first in template order, then the tree is mirrored when `dir === 'rtl'`.
  - Unknown names throw `LayoutError('unknown-preset')`.
- The preset trees, authored LTR. `_` is a panel; `h(r, a, b)` puts `a` on top; `v(r, a, b)` puts `a` on the left.

  | Name | Tree | Panels |
  |---|---|---|
  | `splash` | `_` | 1 |
  | `2-rows` | `h(1/2, _, _)` | 2 |
  | `3-rows` | `h(1/3, _, h(1/2, _, _))` | 3 |
  | `4-rows` | `h(1/2, h(1/2, _, _), h(1/2, _, _))` | 4 |
  | `2x2` | `h(1/2, v(1/2, _, _), v(1/2, _, _))` | 4 |
  | `2x3` | `h(1/3, v(1/2,_,_), h(1/2, v(1/2,_,_), v(1/2,_,_)))` (2 columns × 3 rows) | 6 |
  | `big-top-2` | `h(0.6, _, v(1/2, _, _))` | 3 |
  | `big-top-3` | `h(0.55, _, v(1/3, _, v(1/2, _, _)))` | 4 |
  | `big-bottom-2` | `h(0.4, v(1/2, _, _), _)` | 3 |
  | `2-big-bottom` | `h(0.4, h(1/2, _, _), _)` (two strips over a big panel) | 3 |
  | `left-tall-2` | `v(1/2, _, h(1/2, _, _))` | 3 |
  | `right-tall-2` | `v(1/2, h(1/2, _, _), _)` | 3 |
  | `3-rows-mid-split` | `h(1/3, _, h(1/2, v(1/2, _, _), _))` | 4 |
  | `row-2-1-2` | `h(1/3, v(1/2,_,_), h(1/2, _, v(1/2,_,_)))` | 5 |
  | `cinematic-3` | `h(0.25, _, h(2/3, _, _))` (25% / 50% / 25% strips) | 3 |
  | `5-stagger` | `h(1/3, v(0.62,_,_), h(1/2, v(0.38,_,_), _))` | 5 |

- [ ] **Step 1: Write the failing test**

`packages/shared/test/layout-presets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPreset,
  computeRects,
  DEFAULT_PAGE_FORMAT,
  LayoutError,
  LayoutNodeSchema,
  panelIds,
  presetPanelCount,
  PRESET_NAMES,
  readingOrder,
} from '@manga/shared';

const EXPECTED_COUNTS: Record<string, number> = {
  'splash': 1, '2-rows': 2, '3-rows': 3, '4-rows': 4, '2x2': 4, '2x3': 6,
  'big-top-2': 3, 'big-top-3': 4, 'big-bottom-2': 3, '2-big-bottom': 3,
  'left-tall-2': 3, 'right-tall-2': 3, '3-rows-mid-split': 4, 'row-2-1-2': 5, 'cinematic-3': 3, '5-stagger': 5,
};

function counter(): () => string {
  let n = 0;
  return () => `pn_${String(++n).padStart(2, '0')}`;
}

describe('presets', () => {
  it('has exactly the 16 names from the spec, in spec order', () => {
    expect([...PRESET_NAMES]).toEqual(Object.keys(EXPECTED_COUNTS));
  });

  it.each(Object.entries(EXPECTED_COUNTS))('%s has %i panels and a valid tree in both directions', (name, count) => {
    expect(presetPanelCount(name)).toBe(count);
    for (const dir of ['ltr', 'rtl'] as const) {
      const tree = buildPreset(name, dir, counter());
      expect(LayoutNodeSchema.safeParse(tree).success).toBe(true);
      expect(new Set(panelIds(tree)).size).toBe(count);
    }
  });

  it.each(Object.keys(EXPECTED_COUNTS))('%s reads its panels in the same story order in LTR and RTL', (name) => {
    const ids = Array.from({ length: presetPanelCount(name) }, (_, i) => `pn_${String(i + 1).padStart(2, '0')}`);
    expect(readingOrder(buildPreset(name, 'ltr', counter()), 'ltr')).toEqual(ids);
    expect(readingOrder(buildPreset(name, 'rtl', counter()), 'rtl')).toEqual(ids);
  });

  it('puts the first panel on the right in RTL and on the left in LTR', () => {
    for (const dir of ['rtl', 'ltr'] as const) {
      const tree = buildPreset('2x2', dir, counter());
      const rects = new Map(computeRects(tree, DEFAULT_PAGE_FORMAT).map((r) => [r.panelId, r.rect]));
      const first = rects.get(readingOrder(tree, dir)[0] ?? '');
      expect(first).toBeDefined();
      if (dir === 'rtl') expect(first?.x).toBeGreaterThan(0.5);
      else expect(first?.x).toBeLessThan(0.5);
    }
  });

  it('gives every panel of every preset a usable area (more than 5% of the page each way)', () => {
    for (const name of PRESET_NAMES) {
      for (const { rect } of computeRects(buildPreset(name, 'ltr', counter()), DEFAULT_PAGE_FORMAT)) {
        expect(rect.w).toBeGreaterThan(0.05);
        expect(rect.h).toBeGreaterThan(0.05);
      }
    }
  });

  it('rejects unknown names, including Object prototype keys', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__']) {
      expect(() => presetPanelCount(name)).toThrow(LayoutError);
      expect(() => buildPreset(name, 'ltr', counter())).toThrow(/unknown layout preset/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/layout-presets.test.ts`
Expected: FAIL. `PRESET_NAMES` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/layout/presets.ts`:

```ts
import type { LayoutNode, ReadingDirection, SplitDir } from '../schemas.js';
import { LayoutError, mirrorLayout } from './tree.js';

/** A preset template: '_' is a panel; a tuple is a split [dir, ratio, a, b]. Authored LTR. */
type Template = '_' | readonly [SplitDir, number, Template, Template];

const _ = '_' as const;
const h = (ratio: number, a: Template, b: Template): Template => ['h', ratio, a, b];
const v = (ratio: number, a: Template, b: Template): Template => ['v', ratio, a, b];
const pair = (): Template => v(1 / 2, _, _);

/** The 16 presets from spec §5, in spec order. Defined once; RTL variants come from mirrorLayout. */
const TEMPLATES: Record<string, Template> = {
  'splash': _,
  '2-rows': h(1 / 2, _, _),
  '3-rows': h(1 / 3, _, h(1 / 2, _, _)),
  '4-rows': h(1 / 2, h(1 / 2, _, _), h(1 / 2, _, _)),
  '2x2': h(1 / 2, pair(), pair()),
  '2x3': h(1 / 3, pair(), h(1 / 2, pair(), pair())),
  'big-top-2': h(0.6, _, pair()),
  'big-top-3': h(0.55, _, v(1 / 3, _, v(1 / 2, _, _))),
  'big-bottom-2': h(0.4, pair(), _),
  '2-big-bottom': h(0.4, h(1 / 2, _, _), _),
  'left-tall-2': v(1 / 2, _, h(1 / 2, _, _)),
  'right-tall-2': v(1 / 2, h(1 / 2, _, _), _),
  '3-rows-mid-split': h(1 / 3, _, h(1 / 2, pair(), _)),
  'row-2-1-2': h(1 / 3, pair(), h(1 / 2, _, pair())),
  'cinematic-3': h(0.25, _, h(2 / 3, _, _)),
  '5-stagger': h(1 / 3, v(0.62, _, _), h(1 / 2, v(0.38, _, _), _)),
};

export const PRESET_NAMES: readonly string[] = Object.freeze(Object.keys(TEMPLATES));

function template(name: string): Template {
  const found = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : undefined;
  if (found === undefined) throw new LayoutError('unknown-preset', `unknown layout preset "${name}"`);
  return found;
}

function countPanels(t: Template): number {
  return t === '_' ? 1 : countPanels(t[2]) + countPanels(t[3]);
}

function instantiate(t: Template, newId: () => string): LayoutNode {
  if (t === '_') return { type: 'panel', id: newId() };
  const [dir, ratio, a, b] = t;
  const first = instantiate(a, newId);
  const second = instantiate(b, newId);
  return { type: 'split', dir, ratio, a: first, b: second };
}

export function presetPanelCount(name: string): number {
  return countPanels(template(name));
}

/** Builds the LTR-authored preset with fresh ids (depth-first), mirrored when dir === 'rtl'. */
export function buildPreset(name: string, dir: ReadingDirection, newId: () => string): LayoutNode {
  const tree = instantiate(template(name), newId);
  return dir === 'rtl' ? mirrorLayout(tree) : tree;
}
```

Replace `packages/shared/src/layout/index.ts` with:

```ts
export * from './tree.js';
export * from './rects.js';
export * from './presets.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/layout-presets.test.ts`
Expected: PASS (36 tests: 1 + 16 + 16 + 3).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add the 16 layout presets with RTL mirroring" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Prompt assembly, sizes, style presets and fonts

**Files:**
- Create: `packages/shared/src/prompt.ts`, `packages/shared/src/sizes.ts`, `packages/shared/src/styles.ts`, `packages/shared/src/fonts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/prompt.test.ts`, `packages/shared/test/sizes-styles.test.ts`

**Interfaces:**
- Consumes: `StyleGuide`, `ColorMode`, `FrameKind`.
- Produces (contract A.6):
  - `BW_TOKENS`, `BASE_NEGATIVE`.
  - `assemblePrompt({ styleGuide, colorMode, characterTags, scene, extraNegative? }): { prompt; negative }`. Parts are joined with `', '` and empty parts are skipped. "manga"/"comic"/"comics" are stripped as whole words (case-insensitive) from the scene only; the style prompt and character tags are inserted verbatim.
  - `SDXL_SIZES`, `pickSize(aspect, sizes)`, which compares log ratios.
  - `StylePreset`, and `STYLE_PRESETS` with the ids `manga-bw`, `manga-hatching`, `anime-color` and `anima-bw`.
  - `FONT_FOR_KIND`, `DEFAULT_FONT_SIZE`, `MIN_READABLE_PT`, `BUNDLED_FONTS`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assemblePrompt, BASE_NEGATIVE, BW_TOKENS, type StyleGuide } from '@manga/shared';

const style: StyleGuide = { recipe: 'anime', stylePrompt: 'masterpiece, best quality', negativePrompt: 'lowres, bad hands', loras: [] };

describe('assemblePrompt', () => {
  it('joins style, B&W tokens, character tags and scene in that order', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'bw', characterTags: ['1girl, red hair, (green eyes:1.2)'], scene: 'standing in the rain' });
    expect(r.prompt).toBe(`masterpiece, best quality, ${BW_TOKENS}, 1girl, red hair, (green eyes:1.2), standing in the rain`);
    expect(BW_TOKENS).toBe('monochrome, greyscale, screentone, lineart');
  });

  it('adds the B&W tokens only for bw mangas', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'color', characterTags: [], scene: 'city at night' });
    expect(r.prompt).toBe('masterpiece, best quality, city at night');
    expect(r.prompt).not.toContain('monochrome');
  });

  it('strips the whole words manga, comic and comics from the scene, in any case', () => {
    const r = assemblePrompt({
      styleGuide: style, colorMode: 'color', characterTags: [],
      scene: 'MANGA panel, a Comic shop, stacks of comics, manga-style shading, mangaka at desk',
    });
    expect(r.prompt).toBe('masterpiece, best quality, panel, a shop, stacks of, style shading, mangaka at desk');
  });

  it('keeps character tags and the style prompt verbatim even when they contain those words', () => {
    const r = assemblePrompt({
      styleGuide: { ...style, stylePrompt: 'manga lineart  style' }, colorMode: 'color',
      characterTags: ['comic-book hero costume'], scene: 'manga',
    });
    expect(r.prompt).toBe('manga lineart  style, comic-book hero costume');
  });

  it('builds the negative from the style negative, the base negative and the extra negative', () => {
    const r = assemblePrompt({ styleGuide: style, colorMode: 'bw', characterTags: [], scene: 'x', extraNegative: 'extra fingers' });
    expect(r.negative).toBe(`lowres, bad hands, ${BASE_NEGATIVE}, extra fingers`);
    expect(BASE_NEGATIVE).toBe('text, speech bubble, sound effects, signature, watermark, logo');
  });

  it('skips empty parts instead of leaving double commas', () => {
    const r = assemblePrompt({ styleGuide: { ...style, stylePrompt: '', negativePrompt: '' }, colorMode: 'color', characterTags: ['', '  '], scene: '' });
    expect(r).toEqual({ prompt: '', negative: BASE_NEGATIVE });
  });
});
```

`packages/shared/test/sizes-styles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPreset,
  BUNDLED_FONTS,
  computeRects,
  DEFAULT_FONT_SIZE,
  DEFAULT_PAGE_FORMAT,
  FONT_FOR_KIND,
  FrameKindSchema,
  MIN_READABLE_PT,
  pickSize,
  SDXL_SIZES,
  STYLE_PRESETS,
  StyleGuideSchema,
} from '@manga/shared';

describe('pickSize', () => {
  it('lists the nine SDXL buckets', () => {
    expect(SDXL_SIZES).toEqual([[1024, 1024], [896, 1152], [832, 1216], [768, 1344], [640, 1536], [1152, 896], [1216, 832], [1344, 768], [1536, 640]]);
  });

  it.each([
    [1, [1024, 1024]],
    [0.7, [832, 1216]],
    [0.75, [896, 1152]],
    [0.5, [768, 1344]],
    [0.3, [640, 1536]],
    [1.5, [1216, 832]],
    [2.5, [1536, 640]],
  ] as const)('aspect %f → %j', (aspect, size) => {
    expect(pickSize(aspect, SDXL_SIZES)).toEqual(size);
  });

  it('picks 832×1216 for a 2x2 panel on the default page', () => {
    let n = 0;
    const rect = computeRects(buildPreset('2x2', 'ltr', () => `pn_${++n}`), DEFAULT_PAGE_FORMAT)[0]?.rect;
    expect(rect).toBeDefined();
    const aspect = ((rect?.w ?? 0) * DEFAULT_PAGE_FORMAT.widthMm) / ((rect?.h ?? 1) * DEFAULT_PAGE_FORMAT.heightMm);
    expect(pickSize(aspect, SDXL_SIZES)).toEqual([832, 1216]);
  });

  it('rejects a non-positive aspect and an empty size list', () => {
    expect(() => pickSize(0, SDXL_SIZES)).toThrow(RangeError);
    expect(() => pickSize(Number.NaN, SDXL_SIZES)).toThrow(RangeError);
    expect(() => pickSize(1, [])).toThrow(RangeError);
  });
});

describe('STYLE_PRESETS', () => {
  it('ships the four presets from the contract', () => {
    expect(Object.keys(STYLE_PRESETS)).toEqual(['manga-bw', 'manga-hatching', 'anime-color', 'anima-bw']);
    for (const preset of Object.values(STYLE_PRESETS)) {
      expect(STYLE_PRESETS[preset.id]).toBe(preset);
      expect(StyleGuideSchema.safeParse(preset.styleGuide).success).toBe(true);
      expect(preset.styleGuide.negativePrompt).toBe('lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality');
    }
    expect(STYLE_PRESETS['manga-bw']?.styleGuide).toMatchObject({
      recipe: 'anime', stylePrompt: 'masterpiece, best quality, clean lineart, detailed background',
      loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }],
    });
    expect(STYLE_PRESETS['manga-hatching']?.styleGuide.loras).toEqual([{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }]);
    expect(STYLE_PRESETS['anime-color']).toMatchObject({ colorMode: 'color', styleGuide: { loras: [], stylePrompt: 'masterpiece, best quality, vibrant colors, detailed background' } });
    expect(STYLE_PRESETS['anima-bw']?.styleGuide).toMatchObject({ recipe: 'anima', stylePrompt: 'masterpiece, best quality, clean lineart', loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] });
  });
});

describe('fonts', () => {
  it('has a bundled font and a readable default size for every frame kind', () => {
    for (const kind of FrameKindSchema.options) {
      expect(BUNDLED_FONTS).toContain(FONT_FOR_KIND[kind]);
      expect(DEFAULT_FONT_SIZE[kind]).toBeGreaterThanOrEqual(MIN_READABLE_PT);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/test/prompt.test.ts packages/shared/test/sizes-styles.test.ts`
Expected: FAIL. `assemblePrompt` / `pickSize` are not exported.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/prompt.ts`:

```ts
import type { ColorMode, StyleGuide } from './schemas.js';

export const BW_TOKENS = 'monochrome, greyscale, screentone, lineart';
export const BASE_NEGATIVE = 'text, speech bubble, sound effects, signature, watermark, logo';

/** "manga", "comic", "comics" as whole words (an attached hyphen goes too: "manga-style" → "style"). */
const BANNED_WORDS = /-?\b(?:manga|comics?)\b-?/gi;

/** Removes the banned words from AI-written scene text and tidies the comma list it leaves behind. */
function stripBannedWords(text: string): string {
  return text
    .replace(BANNED_WORDS, ' ')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Joins non-empty parts with ', '; removes the whole words "manga" and "comic(s)" (case-insensitive) from the
 * positive prompt; tags/style are inserted verbatim.
 *
 * The stripping applies to the scene only: style prompt and character tags are the user's own canonical text
 * and must reach the model unchanged, or characters drift.
 */
export function assemblePrompt(input: {
  styleGuide: StyleGuide; colorMode: ColorMode; characterTags: string[]; scene: string; extraNegative?: string;
}): { prompt: string; negative: string } {
  return {
    prompt: joinParts([
      input.styleGuide.stylePrompt,
      input.colorMode === 'bw' ? BW_TOKENS : '',
      ...input.characterTags,
      stripBannedWords(input.scene),
    ]),
    negative: joinParts([input.styleGuide.negativePrompt, BASE_NEGATIVE, input.extraNegative]),
  };
}
```

`packages/shared/src/sizes.ts`:

```ts
export const SDXL_SIZES: Array<[number, number]> = [
  [1024, 1024], [896, 1152], [832, 1216], [768, 1344], [640, 1536], [1152, 896], [1216, 832], [1344, 768], [1536, 640],
];

/** Picks the size whose w/h is closest to `aspect` (compares log ratios). */
export function pickSize(aspect: number, sizes: Array<[number, number]>): [number, number] {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError(`aspect must be a positive number, got ${aspect}`);
  const [first, ...rest] = sizes;
  if (first === undefined) throw new RangeError('sizes must not be empty');
  const target = Math.log(aspect);
  let best = first;
  let bestDistance = Math.abs(Math.log(first[0] / first[1]) - target);
  for (const size of rest) {
    const distance = Math.abs(Math.log(size[0] / size[1]) - target);
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}
```

`packages/shared/src/styles.ts`:

```ts
import type { ColorMode, StyleGuide } from './schemas.js';

export interface StylePreset { id: string; label: string; colorMode: ColorMode; styleGuide: StyleGuide }

const NEGATIVE = 'lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality';
const MANGA_STYLE = 'masterpiece, best quality, clean lineart, detailed background';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  'manga-bw': {
    id: 'manga-bw', label: 'Manga (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anime', stylePrompt: MANGA_STYLE, negativePrompt: NEGATIVE, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }] },
  },
  'manga-hatching': {
    id: 'manga-hatching', label: 'Manga hatching (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anime', stylePrompt: MANGA_STYLE, negativePrompt: NEGATIVE, loras: [{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }] },
  },
  'anime-color': {
    id: 'anime-color', label: 'Anime (colour)', colorMode: 'color',
    styleGuide: { recipe: 'anime', stylePrompt: 'masterpiece, best quality, vibrant colors, detailed background', negativePrompt: NEGATIVE, loras: [] },
  },
  'anima-bw': {
    id: 'anima-bw', label: 'Anima (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anima', stylePrompt: 'masterpiece, best quality, clean lineart', negativePrompt: NEGATIVE, loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] },
  },
};
```

`packages/shared/src/fonts.ts`:

```ts
import type { FrameKind } from './schemas.js';

export const FONT_FOR_KIND: Record<FrameKind, string> = {
  speech: 'Shantell Sans', thought: 'Shantell Sans', shout: 'Dela Gothic One',
  sfx: 'Dela Gothic One', narration: 'Sofia Sans Condensed', title: 'Unbounded',
};
export const DEFAULT_FONT_SIZE: Record<FrameKind, number> = { speech: 9, thought: 9, shout: 11, sfx: 20, narration: 8, title: 28 }; // pt
export const MIN_READABLE_PT = 7;
export const BUNDLED_FONTS: readonly string[] = ['Shantell Sans', 'Comic Relief', 'Dela Gothic One', 'Sofia Sans Condensed', 'Unbounded'];
```

Replace `packages/shared/src/index.ts` with its final M1 content:

```ts
export * from './ids.js';
export * from './schemas.js';
export * from './api.js';
export * from './events.js';
export * from './layout/index.js';
export * from './prompt.js';
export * from './sizes.js';
export * from './styles.js';
export * from './fonts.js';
export * from './jobs.js';
```

- [ ] **Step 4: Run the shared suite**

Run: `npx vitest run packages/shared`
Expected: PASS. All shared test files pass (ids, schemas, layout-tree, layout-rects, layout-presets, prompt, sizes-styles).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add prompt assembly, SDXL size picking, style presets and font constants" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Server package — config, `server.json`, errors, image header parser

**Files:**
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/config.ts`, `packages/server/src/server-info.ts`, `packages/server/src/version.ts`, `packages/server/src/errors.ts`, `packages/server/src/util/defined.ts`, `packages/server/src/files/image-meta.ts`
- Create: `packages/server/test/helpers/tmp.ts`, `packages/server/test/helpers/png.ts`
- Modify: `tsconfig.json` (add the server reference)
- Test: `packages/server/test/config.test.ts`, `packages/server/test/image-meta.test.ts`

**Interfaces:**
- Consumes: `AppConfigSchema`, `AppConfig`, `ApiErrorBody` from `@manga/shared`.
- Produces:
  - `loadConfig(overrides?: Partial<AppConfig>, opts?: { env?: NodeJS.ProcessEnv; file?: string }): AppConfig`. Precedence: defaults < `config.json` < `MANGA_LIBRARY`/`MANGA_PORT` < `overrides`.
  - `configPath(): string`, `defaultLibraryPath(): string`.
  - `interface ServerInfo { pid; port; startedAt }`, `serverInfoPath(lib)`, `writeServerInfo(lib, info)`, `readServerInfo(lib): ServerInfo | null`, `removeServerInfo(lib, pid)`. `config.ts` re-exports all of these, so `@manga/server/config` has them.
  - `VERSION: string`.
  - `class HttpError extends Error { status; code: ApiErrorCode; details? }`, `NotFoundError(entity, id)` (404 `not_found`), `ValidationError(message, details?)` (400), `ConflictError(message, details?)` (409 `conflict`), `StoreCorruptError(entity, id, detail)` (500 `internal`), `type ApiErrorCode`.
  - `defined<T>(value: T): Defined<T>`, which drops keys whose value is `undefined`.
  - `readImageMeta(bytes: Uint8Array): { format: 'png' | 'jpeg'; width; height } | null`, `sniffImageMime(bytes): 'image/png' | 'image/jpeg' | 'application/octet-stream'`.
  - Test helpers `tempDir(prefix?)`, `makePng(w, h)`, `makeJpegHeader(w, h, sof?)`.

- [ ] **Step 1: Create the server tsconfig, the project reference and the test helpers**

`packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }]
}
```

Replace `tsconfig.json` (repo root) with:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/server" }
  ]
}
```

`packages/server/test/helpers/tmp.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir { path: string; cleanup(): void }

/** A fresh directory under the OS temp folder. Close SQLite before cleanup on Windows. */
export function tempDir(prefix = 'manga-test-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
```

`packages/server/test/helpers/png.ts`:

```ts
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** A valid, black, 8-bit RGB PNG of the given size. */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc((width * 3 + 1) * Math.max(height, 0));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG header (SOI, APP0/JFIF, SOFn, EOI): enough for dimension parsing, not a decodable image. */
export function makeJpegHeader(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sofSegment = [
    0xff, sof, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sofSegment, 0xff, 0xd9]);
}
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/config.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, readServerInfo, removeServerInfo, writeServerInfo } from '../src/config.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});
function dir(): string {
  const d = tempDir();
  dirs.push(d);
  return d.path;
}

describe('loadConfig', () => {
  it('defaults to ~/MangaBuilder, port 4317 and the claude-image-gen ComfyUI', () => {
    const c = loadConfig({}, { env: {}, file: join(dir(), 'missing.json') });
    expect(c.libraryPath).toMatch(/MangaBuilder$/);
    expect(c).toMatchObject({
      port: 4317,
      comfyRoot: 'C:/Users/roman/Dev/Exalink/claude-image-gen',
      comfyUrl: 'http://127.0.0.1:8188',
      ollamaUrl: 'http://127.0.0.1:11434',
      claudeBin: 'claude',
    });
  });

  it('reads config.json, then lets MANGA_LIBRARY / MANGA_PORT and explicit overrides win', () => {
    const file = join(dir(), 'config.json');
    writeFileSync(file, JSON.stringify({ libraryPath: 'D:/Manga', port: 5000, comfyUrl: 'http://127.0.0.1:9000' }));
    expect(loadConfig({}, { env: {}, file })).toMatchObject({ libraryPath: 'D:/Manga', port: 5000, comfyUrl: 'http://127.0.0.1:9000' });
    expect(loadConfig({}, { env: { MANGA_LIBRARY: 'E:/Lib', MANGA_PORT: '6000' }, file })).toMatchObject({ libraryPath: 'E:/Lib', port: 6000 });
    expect(loadConfig({ port: 0 }, { env: { MANGA_PORT: '6000' }, file }).port).toBe(0);
  });

  it('names the file when config.json is broken', () => {
    const file = join(dir(), 'config.json');
    writeFileSync(file, '{ not json');
    expect(() => loadConfig({}, { env: {}, file })).toThrow(/invalid config file .*config\.json/);
  });

  it('rejects a non-numeric MANGA_PORT', () => {
    expect(() => loadConfig({}, { env: { MANGA_PORT: 'abc' }, file: join(dir(), 'missing.json') })).toThrow(/port/);
  });
});

describe('server.json', () => {
  it('round-trips and is only removed by the process that wrote it', () => {
    const lib = dir();
    expect(readServerInfo(lib)).toBeNull();
    writeServerInfo(lib, { pid: 123, port: 4317, startedAt: '2026-09-27T00:00:00.000Z' });
    expect(readServerInfo(lib)).toEqual({ pid: 123, port: 4317, startedAt: '2026-09-27T00:00:00.000Z' });
    removeServerInfo(lib, 999);
    expect(readServerInfo(lib)).not.toBeNull();
    removeServerInfo(lib, 123);
    expect(readServerInfo(lib)).toBeNull();
  });

  it('treats a corrupt server.json as absent', () => {
    const lib = dir();
    writeFileSync(join(lib, 'server.json'), '{"pid":"x"}');
    expect(readServerInfo(lib)).toBeNull();
  });
});
```

`packages/server/test/image-meta.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readImageMeta, sniffImageMime } from '../src/files/image-meta.js';
import { makeJpegHeader, makePng } from './helpers/png.js';

describe('readImageMeta', () => {
  it('reads width and height from a PNG IHDR', () => {
    expect(readImageMeta(makePng(640, 480))).toEqual({ format: 'png', width: 640, height: 480 });
  });

  it('reads width and height from a baseline JPEG after an APP0 segment', () => {
    expect(readImageMeta(makeJpegHeader(1216, 832))).toEqual({ format: 'jpeg', width: 1216, height: 832 });
  });

  it('reads a progressive JPEG (SOF2)', () => {
    expect(readImageMeta(makeJpegHeader(300, 200, 0xc2))).toEqual({ format: 'jpeg', width: 300, height: 200 });
  });

  it('returns null for text, GIF, truncated data and zero sizes', () => {
    expect(readImageMeta(Buffer.from('hello, not an image'))).toBeNull();
    expect(readImageMeta(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1'))).toBeNull();
    expect(readImageMeta(makePng(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageMeta(makeJpegHeader(10, 10).subarray(0, 12))).toBeNull();
    expect(readImageMeta(makePng(0, 10))).toBeNull();
    expect(readImageMeta(new Uint8Array(0))).toBeNull();
  });

  it('sniffs the content type from the bytes', () => {
    expect(sniffImageMime(makePng(1, 1))).toBe('image/png');
    expect(sniffImageMime(makeJpegHeader(1, 1))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('x'))).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/config.test.ts packages/server/test/image-meta.test.ts`
Expected: FAIL. `../src/config.js` and `../src/files/image-meta.js` cannot be found.

- [ ] **Step 4: Write the implementation**

`packages/server/src/server-info.ts`:

```ts
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `<library>/server.json`: how the CLI finds a running server. */
export interface ServerInfo { pid: number; port: number; startedAt: string }

export function serverInfoPath(libraryPath: string): string {
  return join(libraryPath, 'server.json');
}

export function writeServerInfo(libraryPath: string, info: ServerInfo): void {
  writeFileSync(serverInfoPath(libraryPath), `${JSON.stringify(info, null, 2)}\n`);
}

/** The recorded server, or null when the file is missing or unreadable. It may be stale: always probe health. */
export function readServerInfo(libraryPath: string): ServerInfo | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(serverInfoPath(libraryPath), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const { pid, port, startedAt } = raw as Record<string, unknown>;
    if (typeof pid === 'number' && typeof port === 'number' && typeof startedAt === 'string') return { pid, port, startedAt };
    return null;
  } catch {
    return null;
  }
}

/** Removes server.json only if it still describes `pid`; a newer server may have replaced it. */
export function removeServerInfo(libraryPath: string, pid: number): void {
  if (readServerInfo(libraryPath)?.pid === pid) rmSync(serverInfoPath(libraryPath), { force: true });
}
```

`packages/server/src/config.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema, type AppConfig } from '@manga/shared';

export * from './server-info.js';

export function configPath(): string {
  return join(homedir(), '.manga-builder', 'config.json');
}

/** Not under Documents: OneDrive syncs Documents and would corrupt SQLite. */
export function defaultLibraryPath(): string {
  return join(homedir(), 'MangaBuilder');
}

export interface LoadConfigOptions { env?: NodeJS.ProcessEnv; file?: string }

function readConfigFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid config file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** defaults < config.json < MANGA_LIBRARY / MANGA_PORT < explicit overrides. */
export function loadConfig(overrides: Partial<AppConfig> = {}, opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const merged: Record<string, unknown> = { libraryPath: defaultLibraryPath(), ...readConfigFile(opts.file ?? configPath()) };
  const library = env['MANGA_LIBRARY'];
  if (library) merged['libraryPath'] = library;
  const port = env['MANGA_PORT'];
  if (port) merged['port'] = Number(port);
  const result = AppConfigSchema.safeParse({ ...merged, ...overrides });
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  return result.data;
}
```

`packages/server/src/version.ts`:

```ts
import { readFileSync } from 'node:fs';

/** The server package version (src/ and dist/ both sit one level below package.json). */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
```

`packages/server/src/errors.ts`:

```ts
import type { ApiErrorBody } from '@manga/shared';

export type ApiErrorCode = ApiErrorBody['error']['code'];

/** An error that already knows its HTTP status and ApiErrorBody code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(entity: string, id: string) {
    super(404, 'not_found', `${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation', message, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details);
    this.name = 'ConflictError';
  }
}

/** A row whose stored JSON no longer matches its schema. Never shown to clients in detail. */
export class StoreCorruptError extends HttpError {
  constructor(entity: string, id: string, detail: string) {
    super(500, 'internal', `${entity} ${id} has invalid stored data: ${detail}`);
    this.name = 'StoreCorruptError';
  }
}
```

`packages/server/src/util/defined.ts`:

```ts
/** T with `undefined` removed from every optional property (what exactOptionalPropertyTypes expects). */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops keys whose value is undefined. zod's partial() types allow `undefined`; repo patches do not. */
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}
```

`packages/server/src/files/image-meta.ts`:

```ts
export interface ImageMeta { format: 'png' | 'jpeg'; width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
/** Start-of-frame markers that carry dimensions (C4 DHT, C8 JPG and CC DAC are not frames). */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const at = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16 = (b: Uint8Array, i: number): number => (at(b, i) << 8) | at(b, i + 1);
const u32 = (b: Uint8Array, i: number): number => ((at(b, i) << 24) >>> 0) + (at(b, i + 1) << 16) + (at(b, i + 2) << 8) + at(b, i + 3);

function readPng(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return null;
  if (!IHDR.every((byte, i) => b[12 + i] === byte)) return null;
  const width = u32(b, 16);
  const height = u32(b, 20);
  return width > 0 && height > 0 ? { format: 'png', width, height } : null;
}

function readJpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = at(b, i + 1);
    while (marker === 0xff && i + 2 < b.length) {
      i += 1; // fill byte
      marker = at(b, i + 1);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan data before any frame header
    const length = u16(b, i + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (i + 8 >= b.length) return null;
      const height = u16(b, i + 5);
      const width = u16(b, i + 7);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** Dimensions from a PNG IHDR or JPEG SOF header, without decoding. Null for anything else. */
export function readImageMeta(bytes: Uint8Array): ImageMeta | null {
  return readPng(bytes) ?? readJpeg(bytes);
}

export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'application/octet-stream' {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return 'application/octet-stream';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/config.test.ts packages/server/test/image-meta.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: exits 0. `packages/server/dist/config.js` exists.

- [ ] **Step 7: Commit**

```bash
git add tsconfig.json packages/server
git commit -m "feat(server): add config loading, server.json, HTTP errors and a PNG/JPEG header parser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Store — database, migrations, entity repositories, library files

**Files:**
- Create: `packages/server/src/store/types.ts`, `packages/server/src/store/db.ts`, `packages/server/src/store/migrations.ts`, `packages/server/src/store/table.ts`, `packages/server/src/store/entities.ts`, `packages/server/src/store/files.ts`
- Test: `packages/server/test/store.test.ts`

**Interfaces:**
- Consumes: entity schemas and types from `@manga/shared`; `NotFoundError` and `StoreCorruptError` from `../errors.js`.
- Produces:
  - `store/types.ts` holds the contract C.1 types, with the additive changes from the Contract notes. It contains `Repo<T, C, U>`, `Store`, `JobRepo`, `SettingsRepo` and `LibraryFiles`. It also contains the `New*` types `NewManga`, `NewCharacter`, `NewChapter`, `NewPage`, `NewPanel`, `NewFrame`, `NewImage`, `NewEpisodeRun` (`Omit<T,'id'|'createdAt'|'updatedAt'> & { id?: string }`), the `*Patch` types `MangaPatch`, `CharacterPatch`, `ChapterPatch`, `PagePatch`, `PanelPatch`, `FramePatch`, `ImagePatch` (`review | ownerId`), `EpisodePatch`, `JobPatch`, and `JobInsert`.
  - `openDatabase(file): Db` (WAL, `foreign_keys = ON`, `busy_timeout = 5000`, migrated), `migrate(db)`, `schemaVersion(db): number`, `type Db`.
  - `TableRepo<T, C, U>` implements `Repo`:
    - `get`, `require`, `create` (assigns id and timestamps, validates with zod), `update` (drops undefined keys, bumps `updatedAt`, validates), `delete` (throws `NotFoundError` when missing).
    - protected `listWhere`, `firstWhere` and `decode`.
    - Every read is validated with zod and throws `StoreCorruptError`.
  - `createEntityRepos(db, now): EntityRepos`, with the repo classes:
    - `MangaRepo.list`
    - `CharacterRepo.listByManga`
    - `ChapterRepo.listByManga`
    - `PageRepo.listByChapter` / `listByManga`
    - `PanelRepo.listByPage`
    - `FrameRepo.listByPage`
    - `ImageRepo.listByOwner` / `listByManga`
    - `EpisodeRepo.latestByChapter`
  - `createLibraryFiles(root): LibraryFiles`: `abs()` refuses paths outside the library.
- Foreign keys in migration 1 carry the cascades:
  - The manga is the root, and deleting it cascades to everything.
  - `chapter → pages, episode_runs` cascade.
  - `page → panels, text_frames` cascade.
  - These set NULL instead: `panels.active_image_id`, `text_frames.panel_id`, `text_frames.speaker_id`, `mangas/chapters.cover_page_id`, `images.parent_image_id`, `jobs.episode_run_id`.
  - Images are polymorphic (owner type + id), so the domain layer deletes a panel's or character's images explicitly.

- [ ] **Step 1: Write the failing test**

`packages/server/test/store.test.ts`:

```ts
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, STYLE_PRESETS, type Manga } from '@manga/shared';
import { NotFoundError, StoreCorruptError } from '../src/errors.js';
import { openDatabase, schemaVersion, type Db } from '../src/store/db.js';
import { createEntityRepos, type EntityRepos } from '../src/store/entities.js';
import { createLibraryFiles } from '../src/store/files.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

let dir: TempDir;
let db: Db;
let repos: EntityRepos;

beforeEach(() => {
  dir = tempDir();
  db = openDatabase(join(dir.path, 'library.sqlite'));
  repos = createEntityRepos(db, () => new Date().toISOString());
});
afterEach(() => {
  db.close();
  dir.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function seedManga(title = 'Oni'): Manga {
  return repos.mangas.create({
    title, synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']!.styleGuide, coverPageId: null,
  });
}

function seedPage(mangaId: string, chapterId: string | null, panelId = 'pn_aaaaaaaaaa') {
  const page = repos.pages.create({ mangaId, chapterId, kind: 'page', order: 0, layout: { type: 'panel', id: panelId } });
  const panel = repos.panels.create({
    id: panelId, pageId: page.id, script: EMPTY_SCRIPT, prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: 7, refCharacterIds: [], activeImageId: null, imageTransform: { x: 0, y: 0, scale: 1 },
  });
  return { page, panel };
}

function seedCharacter(mangaId: string) {
  return repos.characters.create({ mangaId, name: 'Aiko', role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl', seed: 1, recipe: null, refs: {} });
}

function seedImage(mangaId: string, ownerId: string) {
  return repos.images.create({
    mangaId, ownerType: 'panel', ownerId, role: null, path: `mangas/${mangaId}/images/x.png`,
    width: 10, height: 10, source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}

describe('database', () => {
  it('runs in WAL mode with foreign keys on, at the latest schema version', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(schemaVersion(db)).toBe(1);
  });

  it('migrates idempotently when reopened', () => {
    db.close();
    db = openDatabase(join(dir.path, 'library.sqlite'));
    expect(schemaVersion(db)).toBe(1);
  });
});

describe('entity repos', () => {
  it('assigns prefixed ids and timestamps and round-trips JSON columns', () => {
    const m = seedManga();
    expect(m.id).toMatch(/^mg_[a-z2-7]{10}$/);
    expect(m.createdAt).toBe(m.updatedAt);
    expect(repos.mangas.get(m.id)).toEqual(m);
    expect(repos.mangas.list()).toEqual([m]);
  });

  it('uses a caller-supplied id (panels are keyed by their layout leaf)', () => {
    const m = seedManga();
    expect(seedPage(m.id, null, 'pn_leafleaf1').panel.id).toBe('pn_leafleaf1');
  });

  it('updates only the given fields and bumps updatedAt', async () => {
    const m = seedManga();
    await sleep(5);
    const u = repos.mangas.update(m.id, { title: 'Renamed' });
    expect(u).toMatchObject({ title: 'Renamed', synopsis: m.synopsis, createdAt: m.createdAt });
    expect(u.updatedAt > m.updatedAt).toBe(true);
    expect(repos.mangas.require(m.id)).toEqual(u);
  });

  it('validates on write', () => {
    const m = seedManga();
    expect(() => repos.mangas.update(m.id, { title: '' })).toThrow();
    expect(repos.mangas.require(m.id).title).toBe('Oni');
  });

  it('throws NotFoundError from require, update and delete of a missing id', () => {
    expect(repos.mangas.get('mg_missing000')).toBeNull();
    expect(() => repos.mangas.require('mg_missing000')).toThrow(NotFoundError);
    expect(() => repos.mangas.update('mg_missing000', { title: 'x' })).toThrow(NotFoundError);
    expect(() => repos.mangas.delete('mg_missing000')).toThrow(NotFoundError);
  });

  it('validates JSON columns with zod on read', () => {
    const m = seedManga();
    const { page } = seedPage(m.id, null);
    const raw = new Database(join(dir.path, 'library.sqlite'));
    raw.prepare('UPDATE pages SET layout = ? WHERE id = ?').run('{"type":"bogus"}', page.id);
    raw.prepare('UPDATE mangas SET style_guide = ? WHERE id = ?').run('not json', m.id);
    raw.close();
    expect(() => repos.pages.get(page.id)).toThrow(StoreCorruptError);
    expect(() => repos.mangas.get(m.id)).toThrow(StoreCorruptError);
  });

  it('lists children in order', () => {
    const m = seedManga();
    const two = repos.chapters.create({ mangaId: m.id, number: 2, title: 'Two', synopsis: '', coverPageId: null, status: 'draft', order: 1 });
    const one = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    expect(repos.chapters.listByManga(m.id).map((c) => c.id)).toEqual([one.id, two.id]);
  });

  it('stores booleans and nullable JSON', () => {
    const m = seedManga();
    const { page, panel } = seedPage(m.id, null);
    expect(repos.panels.update(panel.id, { seedLock: true }).seedLock).toBe(true);
    expect(repos.panels.require(panel.id).seedLock).toBe(true);
    const f = repos.frames.create({
      pageId: page.id, panelId: panel.id, kind: 'speech', text: 'hi', speakerId: null,
      box: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 }, tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
    });
    expect(repos.frames.get(f.id)).toEqual(f);
    expect(repos.frames.update(f.id, { tail: { x: 0.5, y: 0.6 } }).tail).toEqual({ x: 0.5, y: 0.6 });
  });

  it('finds images by owner and by manga, and the latest episode run of a chapter', () => {
    const m = seedManga();
    const { panel } = seedPage(m.id, null);
    const image = seedImage(m.id, panel.id);
    expect(repos.images.listByOwner('panel', panel.id)).toEqual([image]);
    expect(repos.images.listByManga(m.id)).toEqual([image]);
    expect(repos.images.update(image.id, { ownerId: 'pn_other00000' }).ownerId).toBe('pn_other00000');
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    const input = { prompt: 'a heist', characterIds: [], pages: 8, tone: '' };
    repos.episodes.create({ chapterId: ch.id, input, mode: 'review', steps: [], currentStep: 0, status: 'running' });
    const second = repos.episodes.create({ chapterId: ch.id, input, mode: 'autopilot', steps: [], currentStep: 0, status: 'running' });
    expect(repos.episodes.latestByChapter(ch.id)?.id).toBe(second.id);
    expect(repos.pages.listByManga(m.id)).toHaveLength(1);
  });
});

describe('foreign keys', () => {
  it('cascade a manga delete to everything under it', () => {
    const m = seedManga();
    const ch = repos.chapters.create({ mangaId: m.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
    const { page, panel } = seedPage(m.id, ch.id);
    const cr = seedCharacter(m.id);
    const image = seedImage(m.id, panel.id);
    repos.mangas.delete(m.id);
    expect([
      repos.chapters.get(ch.id), repos.pages.get(page.id), repos.panels.get(panel.id), repos.characters.get(cr.id), repos.images.get(image.id),
    ]).toEqual([null, null, null, null, null]);
  });

  it('clear pointers instead of failing: active image, speaker, frame anchor, cover page', () => {
    const m = seedManga();
    const { page, panel } = seedPage(m.id, null);
    const cr = seedCharacter(m.id);
    const image = seedImage(m.id, panel.id);
    repos.panels.update(panel.id, { activeImageId: image.id });
    repos.mangas.update(m.id, { coverPageId: page.id });
    const f = repos.frames.create({
      pageId: page.id, panelId: panel.id, kind: 'speech', text: 'hi', speakerId: cr.id,
      box: { x: 0, y: 0, w: 0.3, h: 0.1 }, tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
    });
    repos.images.delete(image.id);
    expect(repos.panels.require(panel.id).activeImageId).toBeNull();
    repos.characters.delete(cr.id);
    expect(repos.frames.require(f.id).speakerId).toBeNull();
    repos.panels.delete(panel.id);
    expect(repos.frames.require(f.id).panelId).toBeNull();
    repos.pages.delete(page.id);
    expect(repos.mangas.require(m.id).coverPageId).toBeNull();
    expect(repos.frames.get(f.id)).toBeNull();
  });
});

describe('library files', () => {
  it('writes images under mangas/<mangaId>/images and removes them', () => {
    const files = createLibraryFiles(dir.path);
    const rel = files.writeImage('mg_a', 'im_b', new Uint8Array([1, 2, 3]));
    expect(rel).toBe('mangas/mg_a/images/im_b.png');
    expect(files.imageRel('mg_a', 'im_b')).toBe(rel);
    expect(readFileSync(files.abs(rel))).toEqual(Buffer.from([1, 2, 3]));
    files.remove(rel);
    files.remove(rel); // missing is fine
    expect(existsSync(files.abs(rel))).toBe(false);
    files.writeImage('mg_a', 'im_c', new Uint8Array([1]));
    files.removeMangaDir('mg_a');
    expect(existsSync(join(dir.path, 'mangas', 'mg_a'))).toBe(false);
  });

  it('creates tmp, .claude-cwd and exports on demand and refuses paths outside the library', () => {
    const files = createLibraryFiles(dir.path);
    expect(existsSync(files.tmpDir())).toBe(true);
    expect(files.claudeCwd()).toBe(join(dir.path, '.claude-cwd'));
    expect(existsSync(files.claudeCwd())).toBe(true);
    expect(existsSync(files.exportsDir())).toBe(true);
    expect(() => files.abs('../outside.png')).toThrow(/outside the library/);
    expect(() => files.abs('')).toThrow(/outside the library/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/store.test.ts`
Expected: FAIL. `../src/store/db.js` cannot be found.

- [ ] **Step 3: Write the store types**

`packages/server/src/store/types.ts`:

```ts
import type {
  Chapter, Character, EpisodeRun, Image, Job, JobStatus, Lane, Manga, Page, Panel, Settings, SettingsPatch, TextFrame,
} from '@manga/shared';

/** The entity minus id/timestamps. The repo assigns a fresh id unless one is supplied (panel ids come from layout leaves; image ids name their file). */
type NewEntity<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export type NewManga = NewEntity<Manga>;
export type NewCharacter = NewEntity<Character>;
export type NewChapter = NewEntity<Chapter>;
export type NewPage = NewEntity<Page>;
export type NewPanel = NewEntity<Panel>;
export type NewFrame = NewEntity<TextFrame>;
export type NewImage = NewEntity<Image>;
export type NewEpisodeRun = NewEntity<EpisodeRun>;

export type MangaPatch = Partial<Omit<Manga, 'id' | 'createdAt'>>;
export type CharacterPatch = Partial<Omit<Character, 'id' | 'mangaId' | 'createdAt'>>;
export type ChapterPatch = Partial<Omit<Chapter, 'id' | 'mangaId' | 'createdAt'>>;
export type PagePatch = Partial<Omit<Page, 'id' | 'mangaId' | 'createdAt'>>;
export type PanelPatch = Partial<Omit<Panel, 'id' | 'pageId' | 'createdAt'>>;
export type FramePatch = Partial<Omit<TextFrame, 'id' | 'pageId' | 'createdAt'>>;
/** `ownerId` is patchable so a merge can move variants to the kept panel. */
export type ImagePatch = Partial<Pick<Image, 'review' | 'ownerId'>>;
export type EpisodePatch = Partial<Omit<EpisodeRun, 'id' | 'chapterId' | 'createdAt'>>;
export type JobInsert = Omit<Job, 'id' | 'createdAt' | 'startedAt' | 'finishedAt' | 'result' | 'error' | 'attempts' | 'progress' | 'status'>;
export type JobPatch = Partial<Omit<Job, 'id' | 'createdAt'>>;

export interface Repo<T, C, U> { get(id: string): T | null; require(id: string): T /* throws NotFoundError */; create(input: C): T; update(id: string, patch: U): T; delete(id: string): void }

export interface JobRepo {
  get(id: string): Job | null; require(id: string): Job;
  insert(input: JobInsert): Job;
  update(id: string, patch: JobPatch): Job;
  list(filter: { status?: JobStatus; limit: number }): Job[];
  /** Atomically marks the highest-priority, oldest due queued job in `lane` as running (attempts + 1); null if none. */
  claimNext(lane: Lane, nowIso: string): Job | null;
  /** On boot: running → queued. Returns count. */
  resetRunning(): number;
  counts(): { queued: number; running: number };
}

export interface SettingsRepo { get(): Settings; patch(p: SettingsPatch): Settings }

export interface LibraryFiles {
  root: string;
  imageRel(mangaId: string, imageId: string): string;   // 'mangas/<mangaId>/images/<imageId>.png'
  abs(rel: string): string;
  writeImage(mangaId: string, imageId: string, data: Uint8Array): string; // returns rel
  remove(rel: string): void;                            // ignores missing
  removeMangaDir(mangaId: string): void;
  tmpDir(): string; claudeCwd(): string; exportsDir(): string;
}

export interface Store {
  mangas: Repo<Manga, NewManga, MangaPatch> & { list(): Manga[] };
  characters: Repo<Character, NewCharacter, CharacterPatch> & { listByManga(mangaId: string): Character[] };
  chapters: Repo<Chapter, NewChapter, ChapterPatch> & { listByManga(mangaId: string): Chapter[] };
  pages: Repo<Page, NewPage, PagePatch> & { listByChapter(chapterId: string): Page[]; listByManga(mangaId: string): Page[] };
  panels: Repo<Panel, NewPanel, PanelPatch> & { listByPage(pageId: string): Panel[] };
  frames: Repo<TextFrame, NewFrame, FramePatch> & { listByPage(pageId: string): TextFrame[] };
  images: Repo<Image, NewImage, ImagePatch> & { listByOwner(ownerType: Image['ownerType'], ownerId: string): Image[]; listByManga(mangaId: string): Image[] };
  jobs: JobRepo;
  episodes: Repo<EpisodeRun, NewEpisodeRun, EpisodePatch> & { latestByChapter(chapterId: string): EpisodeRun | null };
  settings: SettingsRepo;
  files: LibraryFiles;
  tx<T>(fn: () => T): T;
  close(): void;
}
```

- [ ] **Step 4: Write the database, migrations and the generic table repository**

`packages/server/src/store/migrations.ts`:

```ts
export interface Migration { version: number; sql: string }

/** Append-only. Never edit a shipped migration; add the next number. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE mangas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  language TEXT NOT NULL,
  color_mode TEXT NOT NULL,
  reading_direction TEXT NOT NULL,
  page_format TEXT NOT NULL,
  style_guide TEXT NOT NULL,
  cover_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  personality TEXT NOT NULL,
  speech_style TEXT NOT NULL,
  appearance_tags TEXT NOT NULL,
  seed INTEGER NOT NULL,
  recipe TEXT,
  refs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_characters_manga ON characters(manga_id);
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  cover_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chapters_manga ON chapters(manga_id);
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ord INTEGER NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pages_chapter ON pages(chapter_id);
CREATE INDEX idx_pages_manga ON pages(manga_id);
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  role TEXT,
  path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source TEXT NOT NULL,
  parent_image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  gen TEXT,
  review TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_images_owner ON images(owner_type, owner_id);
CREATE INDEX idx_images_manga ON images(manga_id);
CREATE TABLE panels (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  script TEXT NOT NULL,
  prompt TEXT NOT NULL,
  recipe TEXT,
  seed_lock INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  ref_character_ids TEXT NOT NULL,
  active_image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  image_transform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_panels_page ON panels(page_id);
CREATE TABLE text_frames (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  panel_id TEXT REFERENCES panels(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  box TEXT NOT NULL,
  tail TEXT,
  rotation REAL NOT NULL,
  font TEXT NOT NULL,
  font_size REAL NOT NULL,
  auto_fit INTEGER NOT NULL,
  align TEXT NOT NULL,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_frames_page ON text_frames(page_id);
CREATE TABLE episode_runs (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  mode TEXT NOT NULL,
  steps TEXT NOT NULL,
  current_step INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_episodes_chapter ON episode_runs(chapter_id);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  payload TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  progress TEXT,
  episode_run_id TEXT REFERENCES episode_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_claim ON jobs(lane, status, next_run_at);
CREATE INDEX idx_jobs_created ON jobs(created_at);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
```

`packages/server/src/store/db.ts`:

```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/** Opens (creating if needed) the library database in WAL mode with foreign keys enforced, then migrates it. */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** One transaction per migration: a half-applied schema is worse than none. */
export function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
```

`packages/server/src/store/table.ts`:

```ts
import type { z } from 'zod';
import { newId, type IdPrefix } from '@manga/shared';
import { NotFoundError, StoreCorruptError } from '../errors.js';
import type { Db } from './db.js';
import type { Repo } from './types.js';

export type Codec = 'value' | 'bool' | 'json';

export interface TableSpec<T> {
  table: string;
  /** Name used in error messages, e.g. 'manga'. */
  entity: string;
  prefix: IdPrefix;
  schema: z.ZodType<T>;
  /** Entity field → column name, or [column, codec]. Plain names use the 'value' codec. */
  columns: Record<string, string | readonly [string, Codec]>;
  hasUpdatedAt: boolean;
  orderBy: string;
}

type Row = Record<string, unknown>;
interface Column { field: string; column: string; codec: Codec }

/** Maps one table to one entity; every row read back is validated with the entity's zod schema. */
export class TableRepo<T extends { id: string }, C, U> implements Repo<T, C, U> {
  private readonly columns: Column[];
  private readonly insertSql: string;
  private readonly updateSql: string;

  constructor(
    protected readonly db: Db,
    protected readonly spec: TableSpec<T>,
    protected readonly now: () => string,
  ) {
    this.columns = Object.entries(spec.columns).map(([field, def]): Column =>
      typeof def === 'string' ? { field, column: def, codec: 'value' } : { field, column: def[0], codec: def[1] },
    );
    const names = this.columns.map((c) => c.column);
    this.insertSql = `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`;
    this.updateSql = `UPDATE ${spec.table} SET ${names.filter((n) => n !== 'id').map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`;
  }

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : this.decode(row);
  }

  require(id: string): T {
    const found = this.get(id);
    if (found === null) throw new NotFoundError(this.spec.entity, id);
    return found;
  }

  create(input: C): T {
    const { id, ...rest } = input as unknown as Row & { id?: string };
    const at = this.now();
    const entity = this.spec.schema.parse({
      ...rest,
      id: id ?? newId(this.spec.prefix),
      createdAt: at,
      ...(this.spec.hasUpdatedAt ? { updatedAt: at } : {}),
    });
    this.db.prepare(this.insertSql).run(this.encode(entity));
    return entity;
  }

  update(id: string, patch: U): T {
    const current = this.require(id);
    const changes = Object.fromEntries(Object.entries(patch as unknown as Row).filter(([, v]) => v !== undefined));
    const next = this.spec.schema.parse({
      ...current,
      ...changes,
      id: current.id,
      ...(this.spec.hasUpdatedAt ? { updatedAt: this.now() } : {}),
    });
    this.db.prepare(this.updateSql).run(this.encode(next));
    return next;
  }

  delete(id: string): void {
    const result = this.db.prepare(`DELETE FROM ${this.spec.table} WHERE id = ?`).run(id);
    if (result.changes === 0) throw new NotFoundError(this.spec.entity, id);
  }

  protected listWhere(where: string, ...params: unknown[]): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE ${where} ORDER BY ${this.spec.orderBy}`).all(...params) as Row[];
    return rows.map((row) => this.decode(row));
  }

  protected firstWhere(where: string, orderBy: string, ...params: unknown[]): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE ${where} ORDER BY ${orderBy} LIMIT 1`).get(...params) as Row | undefined;
    return row === undefined ? null : this.decode(row);
  }

  protected decode(row: Row): T {
    const id = String(row['id']);
    const obj: Row = {};
    for (const c of this.columns) {
      const value = row[c.column];
      if (value === null || value === undefined) {
        obj[c.field] = null;
      } else if (c.codec === 'json') {
        try {
          obj[c.field] = JSON.parse(String(value));
        } catch {
          throw new StoreCorruptError(this.spec.entity, id, `column ${c.column} is not valid JSON`);
        }
      } else {
        obj[c.field] = c.codec === 'bool' ? value === 1 : value;
      }
    }
    const parsed = this.spec.schema.safeParse(obj);
    if (!parsed.success) {
      throw new StoreCorruptError(this.spec.entity, id, parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '));
    }
    return parsed.data;
  }

  private encode(entity: T): Row {
    const source = entity as unknown as Row;
    const out: Row = {};
    for (const c of this.columns) {
      const value = source[c.field];
      if (value === null || value === undefined) out[c.column] = null;
      else if (c.codec === 'json') out[c.column] = JSON.stringify(value);
      else if (c.codec === 'bool') out[c.column] = value ? 1 : 0;
      else out[c.column] = value;
    }
    return out;
  }
}
```

- [ ] **Step 5: Write the entity repositories and library files**

`packages/server/src/store/entities.ts`:

```ts
import {
  ChapterSchema, CharacterSchema, EpisodeRunSchema, ImageSchema, MangaSchema, PageSchema, PanelSchema, TextFrameSchema,
  type Chapter, type Character, type EpisodeRun, type Image, type Manga, type Page, type Panel, type TextFrame,
} from '@manga/shared';
import type { Db } from './db.js';
import { TableRepo } from './table.js';
import type {
  ChapterPatch, CharacterPatch, EpisodePatch, FramePatch, ImagePatch, MangaPatch, NewChapter, NewCharacter,
  NewEpisodeRun, NewFrame, NewImage, NewManga, NewPage, NewPanel, PagePatch, PanelPatch,
} from './types.js';

const TIMESTAMPS = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;

export class MangaRepo extends TableRepo<Manga, NewManga, MangaPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'mangas', entity: 'manga', prefix: 'mg', schema: MangaSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', title: 'title', synopsis: 'synopsis', language: 'language', colorMode: 'color_mode',
        readingDirection: 'reading_direction', pageFormat: ['page_format', 'json'], styleGuide: ['style_guide', 'json'],
        coverPageId: 'cover_page_id', ...TIMESTAMPS,
      },
    }, now);
  }

  list(): Manga[] {
    return this.listWhere('1 = 1');
  }
}

export class CharacterRepo extends TableRepo<Character, NewCharacter, CharacterPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'characters', entity: 'character', prefix: 'cr', schema: CharacterSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', name: 'name', role: 'role', personality: 'personality', speechStyle: 'speech_style',
        appearanceTags: 'appearance_tags', seed: 'seed', recipe: 'recipe', refs: ['refs', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  listByManga(mangaId: string): Character[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class ChapterRepo extends TableRepo<Chapter, NewChapter, ChapterPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'chapters', entity: 'chapter', prefix: 'ch', schema: ChapterSchema, hasUpdatedAt: true, orderBy: 'ord, number, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', number: 'number', title: 'title', synopsis: 'synopsis',
        coverPageId: 'cover_page_id', status: 'status', order: 'ord', ...TIMESTAMPS,
      },
    }, now);
  }

  listByManga(mangaId: string): Chapter[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class PageRepo extends TableRepo<Page, NewPage, PagePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'pages', entity: 'page', prefix: 'pg', schema: PageSchema, hasUpdatedAt: true, orderBy: 'ord, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', chapterId: 'chapter_id', kind: 'kind', order: 'ord', layout: ['layout', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  /** Every page of the chapter, including its cover, by order. */
  listByChapter(chapterId: string): Page[] {
    return this.listWhere('chapter_id = ?', chapterId);
  }

  listByManga(mangaId: string): Page[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class PanelRepo extends TableRepo<Panel, NewPanel, PanelPatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'panels', entity: 'panel', prefix: 'pn', schema: PanelSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', pageId: 'page_id', script: ['script', 'json'], prompt: ['prompt', 'json'], recipe: 'recipe',
        seedLock: ['seed_lock', 'bool'], seed: 'seed', refCharacterIds: ['ref_character_ids', 'json'],
        activeImageId: 'active_image_id', imageTransform: ['image_transform', 'json'], ...TIMESTAMPS,
      },
    }, now);
  }

  listByPage(pageId: string): Panel[] {
    return this.listWhere('page_id = ?', pageId);
  }
}

export class FrameRepo extends TableRepo<TextFrame, NewFrame, FramePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'text_frames', entity: 'text frame', prefix: 'tf', schema: TextFrameSchema, hasUpdatedAt: true, orderBy: 'ord, rowid',
      columns: {
        id: 'id', pageId: 'page_id', panelId: 'panel_id', kind: 'kind', text: 'text', speakerId: 'speaker_id',
        box: ['box', 'json'], tail: ['tail', 'json'], rotation: 'rotation', font: 'font', fontSize: 'font_size',
        autoFit: ['auto_fit', 'bool'], align: 'align', order: 'ord', ...TIMESTAMPS,
      },
    }, now);
  }

  listByPage(pageId: string): TextFrame[] {
    return this.listWhere('page_id = ?', pageId);
  }
}

export class ImageRepo extends TableRepo<Image, NewImage, ImagePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'images', entity: 'image', prefix: 'im', schema: ImageSchema, hasUpdatedAt: false, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', mangaId: 'manga_id', ownerType: 'owner_type', ownerId: 'owner_id', role: 'role', path: 'path',
        width: 'width', height: 'height', source: 'source', parentImageId: 'parent_image_id',
        gen: ['gen', 'json'], review: ['review', 'json'], createdAt: 'created_at',
      },
    }, now);
  }

  listByOwner(ownerType: Image['ownerType'], ownerId: string): Image[] {
    return this.listWhere('owner_type = ? AND owner_id = ?', ownerType, ownerId);
  }

  listByManga(mangaId: string): Image[] {
    return this.listWhere('manga_id = ?', mangaId);
  }
}

export class EpisodeRepo extends TableRepo<EpisodeRun, NewEpisodeRun, EpisodePatch> {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'episode_runs', entity: 'episode run', prefix: 'er', schema: EpisodeRunSchema, hasUpdatedAt: true, orderBy: 'created_at, rowid',
      columns: {
        id: 'id', chapterId: 'chapter_id', input: ['input', 'json'], mode: 'mode', steps: ['steps', 'json'],
        currentStep: 'current_step', status: 'status', ...TIMESTAMPS,
      },
    }, now);
  }

  latestByChapter(chapterId: string): EpisodeRun | null {
    return this.firstWhere('chapter_id = ?', 'created_at DESC, rowid DESC', chapterId);
  }
}

export interface EntityRepos {
  mangas: MangaRepo;
  characters: CharacterRepo;
  chapters: ChapterRepo;
  pages: PageRepo;
  panels: PanelRepo;
  frames: FrameRepo;
  images: ImageRepo;
  episodes: EpisodeRepo;
}

export function createEntityRepos(db: Db, now: () => string): EntityRepos {
  return {
    mangas: new MangaRepo(db, now),
    characters: new CharacterRepo(db, now),
    chapters: new ChapterRepo(db, now),
    pages: new PageRepo(db, now),
    panels: new PanelRepo(db, now),
    frames: new FrameRepo(db, now),
    images: new ImageRepo(db, now),
    episodes: new EpisodeRepo(db, now),
  };
}
```

`packages/server/src/store/files.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { LibraryFiles } from './types.js';

/** Files under the library folder. Relative paths always use '/' so they are portable in the database. */
export function createLibraryFiles(root: string): LibraryFiles {
  const base = resolve(root);
  const ensureDir = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const abs = (rel: string): string => {
    const full = resolve(base, ...rel.split('/'));
    const back = relative(base, full);
    if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error(`path "${rel}" is outside the library`);
    return full;
  };
  const imageRel = (mangaId: string, imageId: string): string => `mangas/${mangaId}/images/${imageId}.png`;

  return {
    root: base,
    imageRel,
    abs,
    writeImage(mangaId, imageId, data) {
      const rel = imageRel(mangaId, imageId);
      const file = abs(rel);
      ensureDir(dirname(file));
      writeFileSync(file, data);
      return rel;
    },
    remove(rel) {
      rmSync(abs(rel), { force: true });
    },
    removeMangaDir(mangaId) {
      rmSync(abs(`mangas/${mangaId}`), { recursive: true, force: true });
    },
    tmpDir: () => ensureDir(join(base, 'tmp')),
    claudeCwd: () => ensureDir(join(base, '.claude-cwd')),
    exportsDir: () => ensureDir(join(base, 'exports')),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/store.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/server
git commit -m "feat(server): add SQLite store with migrations, zod-validated entity repos and library files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Store — job and settings repositories, `openStore`

**Files:**
- Create: `packages/server/src/store/jobs.ts`, `packages/server/src/store/settings.ts`, `packages/server/src/store/index.ts`
- Create: `packages/server/test/helpers/store.ts`
- Test: `packages/server/test/store-jobs-settings.test.ts`

**Interfaces:**
- Consumes: `TableRepo`, `createEntityRepos`, `createLibraryFiles`, `openDatabase` from Task 8.
- Produces:
  - `openStore(libraryPath): Store` (contract C.1). It creates the folder and `library.sqlite`, and `tx` runs in one SQLite transaction.
  - `store/index.ts` re-exports `NotFoundError` and every type in `store/types.ts` (`export type *`).
  - `SqliteJobRepo`:
    - `insert`: status `queued`, attempts 0.
    - `claimNext(lane, nowIso)`: priority DESC, then created_at, then rowid; only rows with `next_run_at <= nowIso`; sets `running`, `startedAt` and `attempts + 1`.
    - `resetRunning`, `counts`.
    - `list({ status?, limit })`: newest first.
  - `SqliteSettingsRepo`: stores the whole settings object under key `app`; `get()` merges the stored data over `DEFAULT_SETTINGS`.
  - `mergeSettings(base, patch): Settings`: section by section, `engine.tasks` replaced whole, validated.
  - Test helpers `makeStore()`, `seedManga(store, over?)`, `seedChapter(store, mangaId)`, `addPanelImage(store, mangaId, panelId)`.

- [ ] **Step 1: Write the test helper and the failing test**

`packages/server/test/helpers/store.ts`:

```ts
import { DEFAULT_PAGE_FORMAT, newId, STYLE_PRESETS, type Chapter, type Image, type Manga } from '@manga/shared';
import { openStore, type NewManga, type Store } from '../../src/store/index.js';
import { makePng } from './png.js';
import { tempDir } from './tmp.js';

export interface TestStore { store: Store; path: string; close(): void }

export function makeStore(): TestStore {
  const dir = tempDir('manga-store-');
  const store = openStore(dir.path);
  return {
    store,
    path: dir.path,
    close: () => {
      store.close();
      dir.cleanup();
    },
  };
}

export function seedManga(store: Store, over: Partial<NewManga> = {}): Manga {
  return store.mangas.create({
    title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr',
    pageFormat: structuredClone(DEFAULT_PAGE_FORMAT), styleGuide: structuredClone(STYLE_PRESETS['manga-bw']!.styleGuide),
    coverPageId: null, ...over,
  });
}

export function seedChapter(store: Store, mangaId: string, number = 1): Chapter {
  return store.chapters.create({ mangaId, number, title: `Chapter ${number}`, synopsis: '', coverPageId: null, status: 'draft', order: number - 1 });
}

/** A real 4×4 PNG written to the library and registered as a variant of the panel. */
export function addPanelImage(store: Store, mangaId: string, panelId: string): Image {
  const id = newId('im');
  const path = store.files.writeImage(mangaId, id, makePng(4, 4));
  return store.images.create({
    id, mangaId, ownerType: 'panel', ownerId: panelId, role: null, path, width: 4, height: 4,
    source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}
```

`packages/server/test/store-jobs-settings.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@manga/shared';
import { openStore, type JobInsert, type Store } from '../src/store/index.js';
import { seedManga } from './helpers/store.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

let dir: TempDir;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = openStore(dir.path);
});
afterEach(() => {
  store.close();
  dir.cleanup();
});

const insert = (over: Partial<JobInsert> = {}) =>
  store.jobs.insert({
    kind: 'image.generate', lane: 'gpu', priority: 0, payload: { n: 1 }, maxAttempts: 3,
    nextRunAt: '2026-01-01T00:00:00.000Z', episodeRunId: null, ...over,
  });

describe('openStore', () => {
  it('creates library.sqlite inside the library folder', () => {
    expect(existsSync(join(dir.path, 'library.sqlite'))).toBe(true);
    expect(store.files.root).toBe(dir.path);
  });

  it('rolls back a transaction that throws', () => {
    expect(() => store.tx(() => {
      seedManga(store);
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.mangas.list()).toEqual([]);
  });
});

describe('job repo', () => {
  it('inserts queued jobs with zero attempts and a JSON payload', () => {
    const job = insert();
    expect(job.id).toMatch(/^jb_/);
    expect(job).toMatchObject({ status: 'queued', attempts: 0, result: null, error: null, progress: null, startedAt: null, finishedAt: null, payload: { n: 1 } });
    expect(store.jobs.require(job.id)).toEqual(job);
  });

  it('claims the highest priority, then oldest, due job of the lane', () => {
    const low = insert({ priority: 0 });
    const high = insert({ priority: 5 });
    const notDue = insert({ priority: 9, nextRunAt: '2099-01-01T00:00:00.000Z' });
    insert({ lane: 'cpu', priority: 99 });
    const now = '2026-06-01T00:00:00.000Z';
    expect(store.jobs.claimNext('gpu', now)).toMatchObject({ id: high.id, status: 'running', attempts: 1, startedAt: now });
    expect(store.jobs.claimNext('gpu', now)?.id).toBe(low.id);
    expect(store.jobs.claimNext('gpu', now)).toBeNull();
    expect(store.jobs.require(notDue.id).status).toBe('queued');
  });

  it('resets running jobs to queued and counts by status', () => {
    insert();
    insert();
    store.jobs.claimNext('gpu', '2026-06-01T00:00:00.000Z');
    expect(store.jobs.counts()).toEqual({ queued: 1, running: 1 });
    expect(store.jobs.resetRunning()).toBe(1);
    expect(store.jobs.counts()).toEqual({ queued: 2, running: 0 });
  });

  it('lists newest first with an optional status filter and a limit', () => {
    const a = insert();
    const b = insert();
    const c = insert();
    store.jobs.update(b.id, { status: 'failed', error: 'x' });
    expect(store.jobs.list({ limit: 10 }).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect(store.jobs.list({ status: 'failed', limit: 10 }).map((j) => j.id)).toEqual([b.id]);
    expect(store.jobs.list({ limit: 2 })).toHaveLength(2);
  });
});

describe('settings repo', () => {
  it('returns the defaults until patched', () => {
    expect(store.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges patches section by section and replaces engine.tasks whole', () => {
    store.settings.patch({ engine: { tasks: { story: 'local', review: 'local' } } });
    store.settings.patch({ engine: { mode: 'local' }, claude: { models: { story: 'sonnet' } }, review: { rounds: 1 } });
    const s = store.settings.get();
    expect(s.engine).toEqual({ mode: 'local', tasks: { story: 'local', review: 'local' } });
    expect(s.claude.models).toEqual({ ...DEFAULT_SETTINGS.claude.models, story: 'sonnet' });
    expect(s.review).toEqual({ autoInEpisode: true, rounds: 1 });
    expect(store.settings.patch({ engine: { tasks: {} } }).engine.tasks).toEqual({});
    expect(store.settings.patch({ routing: { bwRefine: null } }).routing.bwRefine).toBeNull();
  });

  it('persists across reopen and rejects invalid values', () => {
    store.settings.patch({ ollama: { textModel: 'qwen3:32b' } });
    store.close();
    store = openStore(dir.path);
    expect(store.settings.get().ollama.textModel).toBe('qwen3:32b');
    expect(() => store.settings.patch({ review: { rounds: 9 } })).toThrow();
    expect(store.settings.get().review.rounds).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/store-jobs-settings.test.ts`
Expected: FAIL. `../src/store/index.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`packages/server/src/store/jobs.ts`:

```ts
import { JobSchema, type Job, type JobStatus, type Lane } from '@manga/shared';
import type { Db } from './db.js';
import { TableRepo } from './table.js';
import type { JobInsert, JobPatch, JobRepo } from './types.js';

type NewJobRow = Omit<Job, 'id' | 'createdAt'> & { id?: string };

export class SqliteJobRepo extends TableRepo<Job, NewJobRow, JobPatch> implements JobRepo {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'jobs', entity: 'job', prefix: 'jb', schema: JobSchema, hasUpdatedAt: false, orderBy: 'created_at DESC, rowid DESC',
      columns: {
        id: 'id', kind: 'kind', lane: 'lane', status: 'status', priority: 'priority', payload: ['payload', 'json'],
        result: ['result', 'json'], error: 'error', attempts: 'attempts', maxAttempts: 'max_attempts', nextRunAt: 'next_run_at',
        progress: ['progress', 'json'], episodeRunId: 'episode_run_id', createdAt: 'created_at', startedAt: 'started_at',
        finishedAt: 'finished_at',
      },
    }, now);
  }

  insert(input: JobInsert): Job {
    return this.create({
      ...input, status: 'queued', attempts: 0, result: null, error: null, progress: null, startedAt: null, finishedAt: null,
    });
  }

  list(filter: { status?: JobStatus; limit: number }): Job[] {
    const where = filter.status === undefined ? '1 = 1' : 'status = ?';
    const params = filter.status === undefined ? [] : [filter.status];
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, filter.limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decode(row));
  }

  claimNext(lane: Lane, nowIso: string): Job | null {
    return this.db.transaction((): Job | null => {
      const row = this.db
        .prepare(`SELECT id FROM jobs WHERE lane = ? AND status = 'queued' AND next_run_at <= ?
                  ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1`)
        .get(lane, nowIso) as { id: string } | undefined;
      if (row === undefined) return null;
      this.db
        .prepare(`UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL, attempts = attempts + 1 WHERE id = ?`)
        .run(nowIso, row.id);
      return this.require(row.id);
    })();
  }

  resetRunning(): number {
    return this.db.prepare(`UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`).run().changes;
  }

  counts(): { queued: number; running: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const count = (status: string): number => rows.find((r) => r.status === status)?.n ?? 0;
    return { queued: count('queued'), running: count('running') };
  }
}
```

`packages/server/src/store/settings.ts`:

```ts
import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from '@manga/shared';
import { StoreCorruptError } from '../errors.js';
import type { Db } from './db.js';
import type { SettingsRepo } from './types.js';

/** Section by section; `engine.tasks` is replaced whole; the result is validated. */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    engine: { mode: patch.engine?.mode ?? base.engine.mode, tasks: patch.engine?.tasks ?? base.engine.tasks },
    claude: { models: { ...base.claude.models, ...patch.claude?.models } },
    ollama: { ...base.ollama, ...patch.ollama },
    review: { ...base.review, ...patch.review },
    routing: { ...base.routing, ...patch.routing },
  });
}

/** The whole settings object lives under key 'app', read back leniently over the defaults so new sections get defaults. */
export class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly db: Db) {}

  get(): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
    if (row === undefined) return structuredClone(DEFAULT_SETTINGS);
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      throw new StoreCorruptError('settings', 'app', 'not valid JSON');
    }
    const stored = SettingsPatchSchema.safeParse(raw);
    if (!stored.success) throw new StoreCorruptError('settings', 'app', stored.error.message);
    return mergeSettings(DEFAULT_SETTINGS, stored.data);
  }

  patch(p: SettingsPatch): Settings {
    const next = mergeSettings(this.get(), p);
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }
}
```

`packages/server/src/store/index.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { createEntityRepos } from './entities.js';
import { createLibraryFiles } from './files.js';
import { SqliteJobRepo } from './jobs.js';
import { SqliteSettingsRepo } from './settings.js';
import type { Store } from './types.js';

export { NotFoundError } from '../errors.js';
export type * from './types.js';

/** Opens the library: `<libraryPath>/library.sqlite` plus the image files beside it. */
export function openStore(libraryPath: string): Store {
  mkdirSync(libraryPath, { recursive: true });
  const db = openDatabase(join(libraryPath, 'library.sqlite'));
  const now = (): string => new Date().toISOString();
  return {
    ...createEntityRepos(db, now),
    jobs: new SqliteJobRepo(db, now),
    settings: new SqliteSettingsRepo(db),
    files: createLibraryFiles(libraryPath),
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
    close: () => {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/store-jobs-settings.test.ts packages/server/test/store.test.ts`
Expected: PASS (24 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add job and settings repositories and openStore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Event bus, job errors and GPU arbiter

**Files:**
- Create: `packages/server/src/events/bus.ts`, `packages/server/src/jobs/errors.ts`, `packages/server/src/jobs/gpu.ts`
- Test: `packages/server/test/bus-gpu.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` from `@manga/shared`.
- Produces:
  - `class EventBus { emit(e: ServerEvent): void; on(fn): () => void }` (C.3). A throwing listener is logged and does not stop the others.
  - `class TransientError extends Error`, `class PermanentError extends Error` (C.4). Both constructors are `(message: string, options?: ErrorOptions)`.
  - `type GpuOwner = 'comfy' | 'ollama'`.
  - `class GpuArbiter { setReleaser(owner, fn); acquire(owner): Promise<void>; get current(): GpuOwner | null }`. Acquisitions are serialised. Switching owners first awaits the previous owner's releaser. If that releaser fails, the acquire rejects and the old owner is kept.

- [ ] **Step 1: Write the failing test**

`packages/server/test/bus-gpu.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { PermanentError, TransientError } from '../src/jobs/errors.js';
import { GpuArbiter } from '../src/jobs/gpu.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('EventBus', () => {
  it('delivers to every listener, survives a throwing one, and unsubscribes', () => {
    const bus = new EventBus();
    const seen: ServerEvent['type'][] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on(() => {
      throw new Error('bad listener');
    });
    const off = bus.on((e) => seen.push(e.type));
    bus.emit({ type: 'hello', serverTime: 'now' });
    off();
    bus.emit({ type: 'hello', serverTime: 'later' });
    expect(seen).toEqual(['hello']);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe('job errors', () => {
  it('are distinguishable and keep their message', () => {
    const t = new TransientError('comfy restarting');
    const p = new PermanentError('graph rejected');
    expect(t).toBeInstanceOf(Error);
    expect(t).not.toBeInstanceOf(PermanentError);
    expect([t.name, t.message, p.name, p.message]).toEqual(['TransientError', 'comfy restarting', 'PermanentError', 'graph rejected']);
  });
});

describe('GpuArbiter', () => {
  it('starts empty and does not release when the same owner re-acquires', async () => {
    const gpu = new GpuArbiter();
    const released: string[] = [];
    gpu.setReleaser('comfy', async () => {
      released.push('comfy');
    });
    expect(gpu.current).toBeNull();
    await gpu.acquire('comfy');
    await gpu.acquire('comfy');
    expect(gpu.current).toBe('comfy');
    expect(released).toEqual([]);
  });

  it('releases the other owner before switching', async () => {
    const gpu = new GpuArbiter();
    const released: string[] = [];
    gpu.setReleaser('comfy', async () => {
      released.push('comfy');
    });
    gpu.setReleaser('ollama', async () => {
      released.push('ollama');
    });
    await gpu.acquire('comfy');
    await gpu.acquire('ollama');
    expect([gpu.current, ...released]).toEqual(['ollama', 'comfy']);
    await gpu.acquire('comfy');
    expect([gpu.current, ...released]).toEqual(['comfy', 'comfy', 'ollama']);
  });

  it('serialises concurrent acquisitions', async () => {
    const gpu = new GpuArbiter();
    const log: string[] = [];
    gpu.setReleaser('comfy', async () => {
      log.push('release comfy start');
      await sleep(20);
      log.push('release comfy end');
    });
    gpu.setReleaser('ollama', async () => {
      log.push(`release ollama (current=${gpu.current})`);
    });
    await gpu.acquire('comfy');
    await Promise.all([gpu.acquire('ollama'), gpu.acquire('comfy')]);
    expect(log).toEqual(['release comfy start', 'release comfy end', 'release ollama (current=ollama)']);
    expect(gpu.current).toBe('comfy');
  });

  it('keeps the old owner when its releaser fails, and recovers for the next caller', async () => {
    const gpu = new GpuArbiter();
    gpu.setReleaser('comfy', async () => {
      throw new Error('free failed');
    });
    await gpu.acquire('comfy');
    await expect(gpu.acquire('ollama')).rejects.toThrow('free failed');
    expect(gpu.current).toBe('comfy');
    await gpu.acquire('comfy');
    expect(gpu.current).toBe('comfy');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/bus-gpu.test.ts`
Expected: FAIL. `../src/events/bus.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`packages/server/src/events/bus.ts`:

```ts
import type { ServerEvent } from '@manga/shared';

export type BusListener = (event: ServerEvent) => void;

/** In-process pub/sub. One listener throwing must not stop the others, or break the emitter. */
export class EventBus {
  private readonly listeners = new Set<BusListener>();

  emit(event: ServerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[manga] event listener failed:', err);
      }
    }
  }

  on(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
```

`packages/server/src/jobs/errors.ts`:

```ts
/** Retried with backoff: network hiccups, ComfyUI restarting, 5xx responses. */
export class TransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/** Failed immediately with the details attached. Any other thrown error is treated the same way. */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}
```

`packages/server/src/jobs/gpu.ts`:

```ts
export type GpuOwner = 'comfy' | 'ollama';

/** Tracks who holds the GPU and frees the other side before a switch (ComfyUI /free, ollama keep_alive: 0). */
export class GpuArbiter {
  private owner: GpuOwner | null = null;
  private readonly releasers = new Map<GpuOwner, () => Promise<void>>();
  private chain: Promise<void> = Promise.resolve();

  setReleaser(owner: GpuOwner, fn: () => Promise<void>): void {
    this.releasers.set(owner, fn);
  }

  /** If another owner holds the GPU, awaits its releaser first. Serialised. */
  acquire(owner: GpuOwner): Promise<void> {
    const run = async (): Promise<void> => {
      const previous = this.owner;
      if (previous !== null && previous !== owner) {
        const release = this.releasers.get(previous);
        if (release) await release();
      }
      this.owner = owner;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  get current(): GpuOwner | null {
    return this.owner;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/bus-gpu.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add event bus, transient/permanent job errors and GPU arbiter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Job queue

**Files:**
- Create: `packages/server/src/jobs/queue.ts`, `packages/server/src/jobs/index.ts` (barrel)
- Test: `packages/server/test/queue.test.ts`

**Interfaces:**
- Consumes: `Store` (jobs repo), `EventBus`, `GpuArbiter`, `TransientError`, `PermanentError`.
- Produces (contract C.4):
  - `interface JobContext { job; signal; store; bus; gpu; queue; progress(label, value?, max?) }`. `progress` persists the value and emits `{type:'job'}`.
  - `type JobHandler = (ctx) => Promise<unknown>`.
  - `interface EnqueueInput { kind; lane; payload; priority?; maxAttempts?; episodeRunId? }`.
  - `interface JobQueueOptions { store; bus; gpu; limits?; pollMs?; backoffMs?; now? }`.
  - `DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000]`, `DEFAULT_LANE_LIMITS = { gpu: 1, claude: 2, cpu: 1 }`, `isTerminal(status)`.
  - `class JobQueue { register; enqueue; cancel; pauseLane; resumeLane; pausedLanes; waitFor; start; stop }`.
- Behaviour:
  - Each lane runs up to its limit. Within a lane, higher `priority` goes first, then older jobs.
  - Every state change is published as `{ type: 'job', job }`.
  - `TransientError` re-queues the job with `nextRunAt = now + backoff[attempts - 1]` until `attempts === maxAttempts` (default 3 attempts in total). Any other error fails the job at once.
  - `cancel`: a queued job becomes `cancelled` immediately. A running job is marked `cancelled`, its `AbortSignal` is aborted, and its late outcome is ignored.
  - `start()` runs `resetRunning()` first.
  - `stop()` aborts running handlers and waits for them. A job that fails because of the abort goes back to `queued` without spending the attempt, and a job that still finishes is recorded normally.
  - A missing handler fails the job with "no handler registered for job kind …".
- `packages/server/src/jobs/index.ts` re-exports every C.4 name (`TransientError`, `PermanentError`, `GpuOwner`, `GpuArbiter`, `JobContext`, `JobHandler`, `EnqueueInput`, `JobQueue`, …). M2 imports from `../jobs/index.js`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/queue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { PermanentError, TransientError } from '../src/jobs/errors.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { DEFAULT_BACKOFF_MS, JobQueue, type JobContext, type JobQueueOptions } from '../src/jobs/queue.js';
import { makeStore, type TestStore } from './helpers/store.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let t: TestStore;
let bus: EventBus;
let queue: JobQueue | undefined;

function makeQueue(opts: Partial<JobQueueOptions> = {}): JobQueue {
  queue = new JobQueue({ store: t.store, bus, gpu: new GpuArbiter(), pollMs: 5, backoffMs: [10, 10, 10], ...opts });
  return queue;
}

const gpuJob = (q: JobQueue, payload: unknown = null, priority?: number): Job =>
  q.enqueue({ kind: 'image.generate', lane: 'gpu', payload, ...(priority === undefined ? {} : { priority }) });

beforeEach(() => {
  t = makeStore();
  bus = new EventBus();
});
afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  t.close();
});

describe('JobQueue', () => {
  it('runs a job and resolves waitFor with the stored result', async () => {
    const q = makeQueue();
    q.register('image.generate', async (ctx) => ({ got: ctx.job.payload }));
    q.start();
    const job = gpuJob(q, { panelId: 'pn_x' });
    expect(job.status).toBe('queued');
    const done = await q.waitFor(job.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1, result: { got: { panelId: 'pn_x' } }, error: null });
    expect(done.finishedAt).not.toBeNull();
  });

  it('runs higher priority first within a lane', async () => {
    const q = makeQueue();
    const order: string[] = [];
    q.register('image.generate', async (ctx) => {
      order.push((ctx.job.payload as { name: string }).name);
    });
    const low = gpuJob(q, { name: 'low' });
    const high = gpuJob(q, { name: 'high' }, 10);
    q.start();
    await Promise.all([q.waitFor(low.id), q.waitFor(high.id)]);
    expect(order).toEqual(['high', 'low']);
  });

  it('respects the default lane limits (gpu 1, claude 2) and runs lanes independently', async () => {
    const q = makeQueue();
    const gate = deferred();
    const active = { gpu: 0, claude: 0 };
    const peak = { gpu: 0, claude: 0 };
    const handler = async (ctx: JobContext): Promise<void> => {
      const lane = ctx.job.lane as 'gpu' | 'claude';
      active[lane] += 1;
      peak[lane] = Math.max(peak[lane], active[lane]);
      await gate.promise;
      active[lane] -= 1;
    };
    q.register('image.generate', handler);
    q.register('llm.step', handler);
    const jobs = [
      gpuJob(q), gpuJob(q), gpuJob(q),
      ...[1, 2, 3].map(() => q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null })),
    ];
    q.start();
    await vi.waitFor(() => expect(t.store.jobs.counts().running).toBe(3));
    await sleep(30);
    expect(t.store.jobs.counts()).toEqual({ queued: 3, running: 3 });
    gate.resolve();
    await Promise.all(jobs.map((j) => q.waitFor(j.id)));
    expect(peak).toEqual({ gpu: 1, claude: 2 });
  });

  it('retries a TransientError with backoff and then succeeds', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls += 1;
      if (calls < 3) throw new TransientError('comfy restarting');
      return 'ok';
    });
    q.start();
    const done = await q.waitFor(gpuJob(q).id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 3, result: 'ok' });
  });

  it('fails after maxAttempts transient errors, keeping the last message', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls += 1;
      throw new TransientError(`attempt ${calls}`);
    });
    q.start();
    const done = await q.waitFor(gpuJob(q).id);
    expect(done).toMatchObject({ status: 'failed', attempts: 3, error: 'attempt 3' });
  });

  it('schedules a retry after the backoff for that attempt (defaults 5 s, 30 s, 120 s)', async () => {
    expect(DEFAULT_BACKOFF_MS).toEqual([5_000, 30_000, 120_000]);
    const q = makeQueue({ backoffMs: [60_000, 60_000, 60_000] });
    q.register('image.generate', async () => {
      throw new TransientError('503 from comfy');
    });
    q.start();
    const before = Date.now();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).error).toBe('503 from comfy'));
    const retry = t.store.jobs.require(job.id);
    expect(retry).toMatchObject({ status: 'queued', attempts: 1, startedAt: null });
    const delay = Date.parse(retry.nextRunAt) - before;
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThan(62_000);
  });

  it('fails immediately on PermanentError and on any other error', async () => {
    const q = makeQueue();
    q.register('image.generate', async () => {
      throw new PermanentError('graph rejected');
    });
    q.register('llm.step', async () => {
      throw new Error('bad json');
    });
    q.start();
    const a = await q.waitFor(gpuJob(q).id);
    const b = await q.waitFor(q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null }).id);
    expect([a.status, a.attempts, a.error]).toEqual(['failed', 1, 'graph rejected']);
    expect([b.status, b.attempts, b.error]).toEqual(['failed', 1, 'bad json']);
  });

  it('fails a job whose kind has no handler', async () => {
    const q = makeQueue();
    q.start();
    const done = await q.waitFor(q.enqueue({ kind: 'export.render', lane: 'cpu', payload: null }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/no handler registered for job kind export\.render/);
  });

  it('cancels a queued job immediately without running it', async () => {
    const q = makeQueue();
    const ran = vi.fn();
    q.register('image.generate', async () => {
      ran();
    });
    const job = gpuJob(q);
    expect(q.cancel(job.id).status).toBe('cancelled');
    q.start();
    await sleep(30);
    expect(ran).not.toHaveBeenCalled();
    expect((await q.waitFor(job.id)).status).toBe('cancelled');
  });

  it('cancels a running job through its AbortSignal and ignores its late outcome', async () => {
    const q = makeQueue();
    let aborted = false;
    q.register('image.generate', (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
        setTimeout(() => resolve('late result'), 10);
      });
    }));
    q.start();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('running'));
    const waiting = q.waitFor(job.id);
    expect(q.cancel(job.id).status).toBe('cancelled');
    expect((await waiting).status).toBe('cancelled');
    await sleep(30);
    expect(aborted).toBe(true);
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'cancelled', result: null });
    expect(q.cancel(job.id).status).toBe('cancelled');
  });

  it('pauses and resumes a lane; a timed pause lifts itself', async () => {
    const q = makeQueue();
    q.register('llm.step', async () => 'done');
    q.pauseLane('claude', null, 'quota exhausted');
    q.start();
    const first = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    await sleep(40);
    expect(t.store.jobs.require(first.id).status).toBe('queued');
    expect(q.pausedLanes()).toEqual([{ lane: 'claude', until: null, reason: 'quota exhausted' }]);
    q.resumeLane('claude');
    expect((await q.waitFor(first.id)).status).toBe('succeeded');

    const until = new Date(Date.now() + 50);
    q.pauseLane('claude', until, 'quota');
    expect(q.pausedLanes()).toEqual([{ lane: 'claude', until: until.toISOString(), reason: 'quota' }]);
    const second = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    expect((await q.waitFor(second.id)).status).toBe('succeeded');
    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    expect(q.pausedLanes()).toEqual([]);
  });

  it('re-queues jobs left running by a crash when it starts', async () => {
    const stale = t.store.jobs.insert({
      kind: 'image.generate', lane: 'gpu', priority: 0, payload: null, maxAttempts: 3, nextRunAt: new Date().toISOString(), episodeRunId: null,
    });
    t.store.jobs.claimNext('gpu', new Date().toISOString());
    expect(t.store.jobs.require(stale.id).status).toBe('running');
    const q = makeQueue();
    q.register('image.generate', async () => 'recovered');
    q.start();
    expect(await q.waitFor(stale.id)).toMatchObject({ status: 'succeeded', result: 'recovered' });
  });

  it('puts an aborted running job back in the queue on stop without spending the attempt', async () => {
    const q = makeQueue();
    q.register('image.generate', (ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    q.start();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('running'));
    await q.stop();
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0, startedAt: null });
  });

  it('persists progress and publishes every change as a job event', async () => {
    const q = makeQueue();
    const events: Job[] = [];
    bus.on((e) => {
      if (e.type === 'job') events.push(e.job);
    });
    q.register('image.generate', async (ctx) => {
      ctx.progress('Loading model');
      ctx.progress('Sampling', 3, 8);
      return null;
    });
    q.start();
    const job = gpuJob(q);
    await q.waitFor(job.id);
    expect(events.map((j) => [j.status, j.progress?.label ?? null])).toEqual([
      ['queued', null],
      ['running', null],
      ['running', 'Loading model'],
      ['running', 'Sampling'],
      ['succeeded', 'Sampling'],
    ]);
    expect(events[2]?.progress).toEqual({ label: 'Loading model' });
    expect(t.store.jobs.require(job.id).progress).toEqual({ label: 'Sampling', value: 3, max: 8 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/queue.test.ts`
Expected: FAIL. `../src/jobs/queue.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`packages/server/src/jobs/queue.ts`:

```ts
import type { Job, JobKind, JobProgress, JobStatus, Lane, ServiceStatus } from '@manga/shared';
import type { EventBus } from '../events/bus.js';
import type { Store } from '../store/index.js';
import { PermanentError, TransientError } from './errors.js';
import type { GpuArbiter } from './gpu.js';

export interface JobContext {
  job: Job; signal: AbortSignal; store: Store; bus: EventBus; gpu: GpuArbiter; queue: JobQueue;
  progress(label: string, value?: number, max?: number): void;   // persists + emits {type:'job'}
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;
export interface EnqueueInput { kind: JobKind; lane: Lane; payload: unknown; priority?: number; maxAttempts?: number; episodeRunId?: string | null }
export interface JobQueueOptions {
  store: Store; bus: EventBus; gpu: GpuArbiter;
  limits?: Partial<Record<Lane, number>>; pollMs?: number; backoffMs?: number[]; now?: () => Date;
}

export const DEFAULT_LANE_LIMITS: Readonly<Record<Lane, number>> = { gpu: 1, claude: 2, cpu: 1 };
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];
const LANES: readonly Lane[] = ['gpu', 'claude', 'cpu'];
const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

interface Running { lane: Lane; controller: AbortController; cancelled: boolean; done: Promise<void> }
type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Durable queue: every job is a row first. One worker loop, three lanes with their own concurrency. */
export class JobQueue {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly gpu: GpuArbiter;
  private readonly limits: Record<Lane, number>;
  private readonly pollMs: number;
  private readonly backoffMs: readonly number[];
  private readonly now: () => Date;
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly running = new Map<string, Running>();
  private readonly paused = new Map<Lane, { until: Date | null; reason: string }>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping = false;

  constructor(opts: JobQueueOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.gpu = opts.gpu;
    this.limits = { ...DEFAULT_LANE_LIMITS, ...opts.limits };
    this.pollMs = opts.pollMs ?? 250;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = opts.now ?? (() => new Date());
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Default lane limits: gpu 1, claude 2, cpu 1; maxAttempts default 3. */
  enqueue(input: EnqueueInput): Job {
    const job = this.store.jobs.insert({
      kind: input.kind,
      lane: input.lane,
      priority: input.priority ?? 0,
      payload: input.payload ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      nextRunAt: this.now().toISOString(),
      episodeRunId: input.episodeRunId ?? null,
    });
    this.publish(job);
    this.kick();
    return job;
  }

  /** queued → cancelled; running → abort signal, status cancelled. Terminal jobs are returned unchanged. */
  cancel(id: string): Job {
    const job = this.store.jobs.require(id);
    if (isTerminal(job.status)) return job;
    const run = this.running.get(id);
    if (run) run.cancelled = true;
    const cancelled = this.store.jobs.update(id, { status: 'cancelled', finishedAt: this.now().toISOString() });
    run?.controller.abort(new Error('cancelled'));
    this.publish(cancelled);
    this.settle(cancelled);
    return cancelled;
  }

  /** until null = until resumeLane. */
  pauseLane(lane: Lane, until: Date | null, reason: string): void {
    this.paused.set(lane, { until, reason });
  }

  resumeLane(lane: Lane): void {
    this.paused.delete(lane);
    this.kick();
  }

  pausedLanes(): ServiceStatus['queue']['pausedLanes'] {
    this.expirePauses();
    return [...this.paused.entries()].map(([lane, p]) => ({ lane, until: p.until ? p.until.toISOString() : null, reason: p.reason }));
  }

  /** Resolves at succeeded/failed/cancelled. */
  waitFor(id: string): Promise<Job> {
    const job = this.store.jobs.require(id);
    if (isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** resetRunning() then poll loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.store.jobs.resetRunning();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
    this.tick();
  }

  /** Aborts running handlers and waits for them to settle. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const runs = [...this.running.values()];
    for (const run of runs) run.controller.abort(new Error('server stopping'));
    await Promise.allSettled(runs.map((run) => run.done));
    this.started = false;
  }

  private kick(): void {
    if (this.started && !this.stopping) setImmediate(() => this.tick());
  }

  private expirePauses(): void {
    const now = this.now().getTime();
    for (const [lane, pause] of this.paused) {
      if (pause.until !== null && pause.until.getTime() <= now) this.paused.delete(lane);
    }
  }

  private runningIn(lane: Lane): number {
    let count = 0;
    for (const run of this.running.values()) if (run.lane === lane) count += 1;
    return count;
  }

  private tick(): void {
    if (!this.started || this.stopping) return;
    this.expirePauses();
    for (const lane of LANES) {
      if (this.paused.has(lane)) continue;
      while (this.runningIn(lane) < this.limits[lane]) {
        const job = this.store.jobs.claimNext(lane, this.now().toISOString());
        if (job === null) break;
        this.launch(job);
      }
    }
  }

  private launch(job: Job): void {
    this.publish(job);
    const run: Running = { lane: job.lane, controller: new AbortController(), cancelled: false, done: Promise.resolve() };
    this.running.set(job.id, run);
    run.done = this.execute(job, run).finally(() => {
      this.running.delete(job.id);
      this.kick();
    });
  }

  private async execute(job: Job, run: Running): Promise<void> {
    const handler = this.handlers.get(job.kind);
    let outcome: Outcome;
    if (handler === undefined) {
      outcome = { ok: false, error: new PermanentError(`no handler registered for job kind ${job.kind}`) };
    } else {
      try {
        outcome = { ok: true, result: (await handler(this.context(job, run))) ?? null };
      } catch (error) {
        outcome = { ok: false, error };
      }
    }
    this.finish(job.id, run, outcome);
  }

  private finish(id: string, run: Running, outcome: Outcome): void {
    if (run.cancelled) return; // cancel() already recorded, published and settled it
    const current = this.store.jobs.get(id);
    if (current === null || current.status !== 'running') return;
    const nowIso = this.now().toISOString();

    if (outcome.ok) {
      this.complete(this.store.jobs.update(id, { status: 'succeeded', result: outcome.result, error: null, finishedAt: nowIso }));
      return;
    }
    if (this.stopping && run.controller.signal.aborted) {
      // Interrupted by shutdown, not by its own fault: back in line, attempt not spent.
      this.publish(this.store.jobs.update(id, { status: 'queued', startedAt: null, attempts: Math.max(0, current.attempts - 1) }));
      return;
    }
    const message = messageOf(outcome.error);
    if (outcome.error instanceof TransientError && current.attempts < current.maxAttempts) {
      const delay = this.backoffMs[Math.min(current.attempts - 1, this.backoffMs.length - 1)] ?? 0;
      this.publish(this.store.jobs.update(id, {
        status: 'queued', error: message, startedAt: null, nextRunAt: new Date(this.now().getTime() + delay).toISOString(),
      }));
      return;
    }
    this.complete(this.store.jobs.update(id, { status: 'failed', error: message, finishedAt: nowIso }));
  }

  private complete(job: Job): void {
    this.publish(job);
    this.settle(job);
  }

  private context(job: Job, run: Running): JobContext {
    return {
      job,
      signal: run.controller.signal,
      store: this.store,
      bus: this.bus,
      gpu: this.gpu,
      queue: this,
      progress: (label, value, max) => {
        if (run.controller.signal.aborted) return;
        const current = this.store.jobs.get(job.id);
        if (current === null || current.status !== 'running') return;
        const progress: JobProgress = { label, ...(value === undefined ? {} : { value }), ...(max === undefined ? {} : { max }) };
        this.publish(this.store.jobs.update(job.id, { progress }));
      },
    };
  }

  private publish(job: Job): void {
    this.bus.emit({ type: 'job', job });
  }

  private settle(job: Job): void {
    const list = this.waiters.get(job.id);
    if (list === undefined) return;
    this.waiters.delete(job.id);
    for (const resolve of list) resolve(job);
  }
}
```

`packages/server/src/jobs/index.ts`:

```ts
export * from './errors.js';
export * from './gpu.js';
export * from './queue.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/queue.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add durable job queue with lanes, priority, backoff, cancel and pause" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Domain — pages and layout operations

**Files:**
- Create: `packages/server/src/domain/seed.ts`, `packages/server/src/domain/order.ts`, `packages/server/src/domain/panels.ts`, `packages/server/src/domain/delete.ts`, `packages/server/src/domain/pages.ts`
- Test: `packages/server/test/domain-pages.test.ts`

**Interfaces:**
- Consumes: `Store`; `buildPreset`, `splitPanel`, `mergePanels`, `resizeSplit`, `readingOrder`, `panelIds`, `newId`, `EMPTY_SCRIPT` and `DEFAULT_TRANSFORM` from `@manga/shared`; `HttpError` and `ValidationError`.
- Produces (contract C.2 plus helpers):
  - `randomSeed(): number` in `[0, 2^32)`.
  - `chapterPages(store, chapterId): Page[]`: the story pages without the cover, in order.
  - `renumberPages(store, pages)`.
  - `newPanelInput(pageId, id): NewPanel`: `EMPTY_SCRIPT`, a random seed, `DEFAULT_TRANSFORM`.
  - `removeFiles(store, rels)`.
  - `deletePanelRows(store, panelId): string[]`: deletes the panel's image rows and the panel, and returns the files to remove after commit.
  - `deletePage(store, pageId): Page`.
  - `pageDetail(store, pageId): PageDetail`: panels in `panelIds` order, and `images` holds the active images.
  - `createPage(store, chapterId, preset, index?)`.
  - `createCoverPage(store, mangaId, chapterId | null)`: idempotent, returns the existing cover.
  - `applyPreset(store, pageId, preset, confirm)`: throws `NeedsConfirmError`.
  - `splitPagePanel`, `mergePagePanels`, `resizePageSplit`.
  - `class NeedsConfirmError extends HttpError { removedPanelIds: string[] }` (409 `needs_confirm`, details `{ removedPanelIds }`).
- Rules:
  - `applyPreset` maps old panels onto the new slots in reading order and keeps the old Panel ids and rows. It creates Panel rows for extra slots.
  - The panels it drops are deleted together with their images and files. Frames anchored to them become unanchored (FK `SET NULL`).
  - A merge keeps A: B's variants move to A, and so do frames anchored to B.

- [ ] **Step 1: Write the failing test**

`packages/server/test/domain-pages.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRects, DEFAULT_TRANSFORM, EMPTY_SCRIPT, LayoutError, panelIds, readingOrder, type Chapter, type Manga } from '@manga/shared';
import { NotFoundError } from '../src/errors.js';
import { deletePage } from '../src/domain/delete.js';
import {
  applyPreset, createCoverPage, createPage, mergePagePanels, NeedsConfirmError, pageDetail, resizePageSplit, splitPagePanel,
} from '../src/domain/pages.js';
import { addPanelImage, makeStore, seedChapter, seedManga, type TestStore } from './helpers/store.js';

let t: TestStore;
let manga: Manga;
let chapter: Chapter;

beforeEach(() => {
  t = makeStore();
  manga = seedManga(t.store, { readingDirection: 'ltr' });
  chapter = seedChapter(t.store, manga.id);
});
afterEach(() => t.close());

function addFrame(pageId: string, panelId: string | null) {
  return t.store.frames.create({
    pageId, panelId, kind: 'speech', text: 'Hi', speakerId: null, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 },
    tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
  });
}

describe('createPage', () => {
  it('creates the preset layout with one Panel row per leaf, in chapter order', () => {
    const d1 = createPage(t.store, chapter.id, '2x2');
    expect(d1.page).toMatchObject({ kind: 'page', order: 0, chapterId: chapter.id, mangaId: manga.id });
    expect(d1.panels.map((p) => p.id)).toEqual(panelIds(d1.page.layout));
    expect(d1.panels).toHaveLength(4);
    expect(d1.panels[0]).toMatchObject({ script: EMPTY_SCRIPT, seedLock: false, activeImageId: null, refCharacterIds: [], imageTransform: DEFAULT_TRANSFORM, recipe: null });
    expect(d1.frames).toEqual([]);
    expect(d1.images).toEqual({});
    const d0 = createPage(t.store, chapter.id, 'splash', 0);
    const d2 = createPage(t.store, chapter.id, '3-rows', 99);
    expect(t.store.pages.listByChapter(chapter.id).map((p) => [p.id, p.order])).toEqual([[d0.page.id, 0], [d1.page.id, 1], [d2.page.id, 2]]);
  });

  it('mirrors the preset for RTL mangas so the tall panel of left-tall-2 is on the right and read first', () => {
    const rtl = seedManga(t.store, { readingDirection: 'rtl' });
    const ch = seedChapter(t.store, rtl.id);
    const d = createPage(t.store, ch.id, 'left-tall-2');
    const rects = new Map(computeRects(d.page.layout, rtl.pageFormat).map((r) => [r.panelId, r.rect]));
    const first = rects.get(readingOrder(d.page.layout, 'rtl')[0] ?? '');
    expect(first?.x).toBeGreaterThan(0.5);
    expect(first?.h).toBeGreaterThan(0.8);
  });

  it('rejects an unknown preset or chapter without writing anything', () => {
    expect(() => createPage(t.store, chapter.id, 'nope')).toThrow(LayoutError);
    expect(() => createPage(t.store, 'ch_missing000', '2x2')).toThrow(NotFoundError);
    expect(t.store.pages.listByChapter(chapter.id)).toEqual([]);
  });
});

describe('createCoverPage', () => {
  it('creates one splash cover per manga or chapter and returns it again next time', () => {
    const mc = createCoverPage(t.store, manga.id, null);
    expect(mc.page).toMatchObject({ kind: 'cover', chapterId: null, order: 0 });
    expect(mc.panels).toHaveLength(1);
    expect(t.store.mangas.require(manga.id).coverPageId).toBe(mc.page.id);
    expect(createCoverPage(t.store, manga.id, null).page.id).toBe(mc.page.id);
    const cc = createCoverPage(t.store, manga.id, chapter.id);
    expect(cc.page.id).not.toBe(mc.page.id);
    expect(t.store.chapters.require(chapter.id).coverPageId).toBe(cc.page.id);
    expect(createCoverPage(t.store, manga.id, chapter.id).page.id).toBe(cc.page.id);
  });
});

describe('applyPreset', () => {
  it('maps existing panels to the new slots in reading order and adds new panels', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const [p1, p2] = readingOrder(d.page.layout, 'ltr');
    t.store.panels.update(p1 ?? '', { script: { ...EMPTY_SCRIPT, action: 'first' } });
    const next = applyPreset(t.store, d.page.id, '2x2', false);
    expect(readingOrder(next.page.layout, 'ltr').slice(0, 2)).toEqual([p1, p2]);
    expect(next.panels).toHaveLength(4);
    expect(t.store.panels.require(p1 ?? '').script.action).toBe('first');
  });

  it('refuses to drop panels without confirm, lists them, and changes nothing', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const order = readingOrder(d.page.layout, 'ltr');
    try {
      applyPreset(t.store, d.page.id, '2-rows', false);
      expect.unreachable('applyPreset should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsConfirmError);
      expect((err as NeedsConfirmError).removedPanelIds).toEqual(order.slice(2));
      expect((err as NeedsConfirmError).status).toBe(409);
    }
    expect(t.store.pages.require(d.page.id).layout).toEqual(d.page.layout);
    expect(t.store.panels.listByPage(d.page.id)).toHaveLength(4);
  });

  it('with confirm keeps the art of surviving panels and deletes removed panels with their images and files', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const order = readingOrder(d.page.layout, 'ltr');
    const kept = addPanelImage(t.store, manga.id, order[0] ?? '');
    t.store.panels.update(order[0] ?? '', { activeImageId: kept.id });
    const doomed = addPanelImage(t.store, manga.id, order[3] ?? '');
    const frame = addFrame(d.page.id, order[3] ?? null);
    const next = applyPreset(t.store, d.page.id, '2-rows', true);
    expect(readingOrder(next.page.layout, 'ltr')).toEqual(order.slice(0, 2));
    expect(next.images[kept.id]).toEqual(kept);
    expect(existsSync(t.store.files.abs(kept.path))).toBe(true);
    expect(t.store.panels.get(order[3] ?? '')).toBeNull();
    expect(t.store.images.get(doomed.id)).toBeNull();
    expect(existsSync(t.store.files.abs(doomed.path))).toBe(false);
    expect(t.store.frames.require(frame.id).panelId).toBeNull();
  });
});

describe('split, merge and resize', () => {
  it('splits a panel, creating a fresh Panel row for the new half', () => {
    const d = createPage(t.store, chapter.id, 'splash');
    const only = d.panels[0]?.id ?? '';
    const next = splitPagePanel(t.store, d.page.id, only, 'h');
    const ids = panelIds(next.page.layout);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(only);
    expect(t.store.panels.require(ids[1] ?? '').script).toEqual(EMPTY_SCRIPT);
    expect(next.panels.map((p) => p.id)).toEqual(ids);
  });

  it('merges siblings into A, moving B variants and anchored frames to A', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const [a, b] = panelIds(d.page.layout) as [string, string];
    const aImage = addPanelImage(t.store, manga.id, a);
    t.store.panels.update(a, { activeImageId: aImage.id });
    const bImage = addPanelImage(t.store, manga.id, b);
    const frame = addFrame(d.page.id, b);
    const next = mergePagePanels(t.store, d.page.id, a, b);
    expect(panelIds(next.page.layout)).toEqual([a]);
    expect(t.store.panels.get(b)).toBeNull();
    expect(t.store.panels.require(a).activeImageId).toBe(aImage.id);
    expect(t.store.images.listByOwner('panel', a).map((i) => i.id).sort()).toEqual([aImage.id, bImage.id].sort());
    expect(existsSync(t.store.files.abs(bImage.path))).toBe(true);
    expect(t.store.frames.require(frame.id).panelId).toBe(a);
  });

  it('refuses to merge non-siblings and leaves the page alone', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const [p1, , p3] = panelIds(d.page.layout);
    expect(() => mergePagePanels(t.store, d.page.id, p1 ?? '', p3 ?? '')).toThrow(LayoutError);
    expect(t.store.pages.require(d.page.id).layout).toEqual(d.page.layout);
  });

  it('resizes a split, clamped to 8–92 %', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const next = resizePageSplit(t.store, d.page.id, [], 0.99);
    expect(next.page.layout).toMatchObject({ type: 'split', ratio: 0.92 });
  });
});

describe('pageDetail and deletePage', () => {
  it('404s for an unknown page', () => {
    expect(() => pageDetail(t.store, 'pg_missing000')).toThrow(NotFoundError);
  });

  it('removes panels, frames, images and files, and renumbers the chapter', () => {
    const a = createPage(t.store, chapter.id, 'splash');
    const b = createPage(t.store, chapter.id, '2-rows');
    const c = createPage(t.store, chapter.id, 'splash');
    const image = addPanelImage(t.store, manga.id, b.panels[0]?.id ?? '');
    const frame = addFrame(b.page.id, null);
    deletePage(t.store, b.page.id);
    expect(t.store.pages.get(b.page.id)).toBeNull();
    expect(t.store.panels.get(b.panels[0]?.id ?? '')).toBeNull();
    expect(t.store.frames.get(frame.id)).toBeNull();
    expect(t.store.images.get(image.id)).toBeNull();
    expect(existsSync(t.store.files.abs(image.path))).toBe(false);
    expect(t.store.pages.listByChapter(chapter.id).map((p) => [p.id, p.order])).toEqual([[a.page.id, 0], [c.page.id, 1]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/domain-pages.test.ts`
Expected: FAIL. `../src/domain/delete.js` cannot be found.

- [ ] **Step 3: Write the helpers**

`packages/server/src/domain/seed.ts`:

```ts
import { randomInt } from 'node:crypto';

/** A generation seed in [0, 2^32), valid for every ComfyUI sampler. */
export function randomSeed(): number {
  return randomInt(0, 2 ** 32);
}
```

`packages/server/src/domain/order.ts`:

```ts
import type { Page } from '@manga/shared';
import type { Store } from '../store/index.js';

/** The chapter's story pages (not its cover), in order. */
export function chapterPages(store: Store, chapterId: string): Page[] {
  return store.pages.listByChapter(chapterId).filter((page) => page.kind === 'page');
}

/** Rewrites `order` to 0..n-1 following the given sequence. */
export function renumberPages(store: Store, pages: readonly Page[]): void {
  pages.forEach((page, index) => {
    if (page.order !== index) store.pages.update(page.id, { order: index });
  });
}
```

`packages/server/src/domain/panels.ts` (Task 13 extends it):

```ts
import { DEFAULT_TRANSFORM, EMPTY_SCRIPT } from '@manga/shared';
import type { NewPanel } from '../store/index.js';
import { randomSeed } from './seed.js';

/** A blank panel row for a layout leaf. */
export function newPanelInput(pageId: string, id: string): NewPanel {
  return {
    id, pageId, script: structuredClone(EMPTY_SCRIPT), prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: randomSeed(), refCharacterIds: [], activeImageId: null, imageTransform: { ...DEFAULT_TRANSFORM },
  };
}
```

`packages/server/src/domain/delete.ts` (Task 13 replaces it with the full version):

```ts
import type { Page } from '@manga/shared';
import type { Store } from '../store/index.js';
import { chapterPages, renumberPages } from './order.js';

/** Removes image files after the transaction that deleted their rows has committed. Missing files are ignored. */
export function removeFiles(store: Store, rels: readonly string[]): void {
  for (const rel of rels) store.files.remove(rel);
}

/** Deletes a panel and its image rows (frames anchored to it are un-anchored by the FK). Returns files to remove after commit. */
export function deletePanelRows(store: Store, panelId: string): string[] {
  const images = store.images.listByOwner('panel', panelId);
  for (const image of images) store.images.delete(image.id);
  store.panels.delete(panelId);
  return images.map((image) => image.path);
}

export function deletePage(store: Store, pageId: string): Page {
  const page = store.pages.require(pageId);
  const files: string[] = [];
  store.tx(() => {
    for (const panel of store.panels.listByPage(pageId)) files.push(...deletePanelRows(store, panel.id));
    store.pages.delete(pageId);
    if (page.kind === 'page' && page.chapterId !== null) renumberPages(store, chapterPages(store, page.chapterId));
  });
  removeFiles(store, files);
  return page;
}
```

- [ ] **Step 4: Write the page service**

`packages/server/src/domain/pages.ts`:

```ts
import {
  buildPreset, mergePanels, newId, panelIds, readingOrder, resizeSplit, splitPanel,
  type Image, type LayoutNode, type PageDetail, type Panel, type SplitDir,
} from '@manga/shared';
import { HttpError, ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { deletePanelRows, removeFiles } from './delete.js';
import { chapterPages, renumberPages } from './order.js';
import { newPanelInput } from './panels.js';

export class NeedsConfirmError extends HttpError {
  constructor(public removedPanelIds: string[]) {
    super(409, 'needs_confirm', `this layout has fewer panels and would remove ${removedPanelIds.join(', ')}; resend with confirm=true`, { removedPanelIds });
    this.name = 'NeedsConfirmError';
  }
}

export function pageDetail(store: Store, pageId: string): PageDetail {
  const page = store.pages.require(pageId);
  const byId = new Map(store.panels.listByPage(pageId).map((panel) => [panel.id, panel]));
  const panels = panelIds(page.layout).map((id) => byId.get(id)).filter((p): p is Panel => p !== undefined);
  const images: Record<string, Image> = {};
  for (const panel of panels) {
    if (panel.activeImageId === null) continue;
    const image = store.images.get(panel.activeImageId);
    if (image) images[image.id] = image;
  }
  return { page, panels, frames: store.frames.listByPage(pageId), images };
}

function addPanels(store: Store, pageId: string, ids: readonly string[]): void {
  for (const id of ids) store.panels.create(newPanelInput(pageId, id));
}

export function createPage(store: Store, chapterId: string, preset: string, index?: number): PageDetail {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const layout = buildPreset(preset, manga.readingDirection, () => newId('pn'));
  const pageId = store.tx(() => {
    const siblings = chapterPages(store, chapterId);
    const at = index === undefined ? siblings.length : Math.min(Math.max(0, index), siblings.length);
    const page = store.pages.create({ mangaId: manga.id, chapterId, kind: 'page', order: at, layout });
    addPanels(store, page.id, panelIds(layout));
    const ordered = [...siblings];
    ordered.splice(at, 0, page);
    renumberPages(store, ordered);
    return page.id;
  });
  return pageDetail(store, pageId);
}

/** The manga cover (chapterId null) or a chapter cover: a single-panel page. Returns the existing one if present. */
export function createCoverPage(store: Store, mangaId: string, chapterId: string | null): PageDetail {
  const manga = store.mangas.require(mangaId);
  const chapter = chapterId === null ? null : store.chapters.require(chapterId);
  if (chapter !== null && chapter.mangaId !== mangaId) throw new ValidationError(`chapter ${chapter.id} does not belong to manga ${mangaId}`);
  const existing = chapter === null ? manga.coverPageId : chapter.coverPageId;
  if (existing !== null && store.pages.get(existing) !== null) return pageDetail(store, existing);
  const layout = buildPreset('splash', manga.readingDirection, () => newId('pn'));
  const pageId = store.tx(() => {
    const page = store.pages.create({ mangaId, chapterId, kind: 'cover', order: 0, layout });
    addPanels(store, page.id, panelIds(layout));
    if (chapter === null) store.mangas.update(mangaId, { coverPageId: page.id });
    else store.chapters.update(chapter.id, { coverPageId: page.id });
    return page.id;
  });
  return pageDetail(store, pageId);
}

function renameLeaves(tree: LayoutNode, names: ReadonlyMap<string, string>): LayoutNode {
  if (tree.type === 'panel') return { type: 'panel', id: names.get(tree.id) ?? tree.id };
  return { ...tree, a: renameLeaves(tree.a, names), b: renameLeaves(tree.b, names) };
}

/** Replaces the layout with a preset, mapping existing panels onto the new slots in reading order. */
export function applyPreset(store: Store, pageId: string, preset: string, confirm: boolean): PageDetail {
  const page = store.pages.require(pageId);
  const manga = store.mangas.require(page.mangaId);
  const dir = manga.readingDirection;
  const fresh = buildPreset(preset, dir, () => newId('pn'));
  const current = readingOrder(page.layout, dir);
  const slots = readingOrder(fresh, dir);
  const removed = current.slice(slots.length);
  if (removed.length > 0 && !confirm) throw new NeedsConfirmError(removed);

  const names = new Map<string, string>();
  slots.forEach((slot, i) => {
    const existing = current[i];
    if (existing !== undefined) names.set(slot, existing);
  });
  const layout = renameLeaves(fresh, names);
  const files: string[] = [];
  store.tx(() => {
    for (const id of removed) files.push(...deletePanelRows(store, id));
    addPanels(store, pageId, slots.slice(current.length));
    store.pages.update(pageId, { layout });
  });
  removeFiles(store, files);
  return pageDetail(store, pageId);
}

/** New Panel row: EMPTY_SCRIPT, random seed. */
export function splitPagePanel(store: Store, pageId: string, panelId: string, dir: SplitDir): PageDetail {
  const page = store.pages.require(pageId);
  const added = newId('pn');
  const layout = splitPanel(page.layout, panelId, dir, added);
  store.tx(() => {
    store.panels.create(newPanelInput(pageId, added));
    store.pages.update(pageId, { layout });
  });
  return pageDetail(store, pageId);
}

/** Deletes the removed panel; its images and frames are re-anchored to the kept panel. */
export function mergePagePanels(store: Store, pageId: string, a: string, b: string): PageDetail {
  const page = store.pages.require(pageId);
  const { tree, keptId, removedId } = mergePanels(page.layout, a, b);
  store.tx(() => {
    for (const image of store.images.listByOwner('panel', removedId)) store.images.update(image.id, { ownerId: keptId });
    for (const frame of store.frames.listByPage(pageId)) {
      if (frame.panelId === removedId) store.frames.update(frame.id, { panelId: keptId });
    }
    store.panels.delete(removedId);
    store.pages.update(pageId, { layout: tree });
  });
  return pageDetail(store, pageId);
}

export function resizePageSplit(store: Store, pageId: string, path: Array<'a' | 'b'>, ratio: number): PageDetail {
  const page = store.pages.require(pageId);
  store.pages.update(pageId, { layout: resizeSplit(page.layout, path, ratio) });
  return pageDetail(store, pageId);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/domain-pages.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add page domain services (presets, cover, split, merge, resize, delete)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Domain — mangas, characters, chapters, panels, frames, uploads, cascade deletes

**Files:**
- Create: `packages/server/src/domain/mangas.ts`, `packages/server/src/domain/characters.ts`, `packages/server/src/domain/chapters.ts`, `packages/server/src/domain/frames.ts`, `packages/server/src/domain/uploads.ts`, `packages/server/src/domain/index.ts`
- Modify: `packages/server/src/domain/panels.ts` (add `updatePanel`), `packages/server/src/domain/delete.ts` (full version)
- Test: `packages/server/test/domain-entities.test.ts`

**Interfaces:**
- Consumes: Task 12 domain helpers; `defined`; `ValidationError`; `readImageMeta`.
- Produces:
  - Mangas:
    - `stylePreset(id): StylePreset` (throws `ValidationError`).
    - `createManga(store, input: CreateMangaInput): Manga`.
    - `updateManga(store, id, patch: UpdateMangaInput): Manga`. When `readingDirection` changes, it mirrors every page layout and frame (box x, tail x, rotation) of the manga.
  - Characters:
    - `createCharacter(store, mangaId, input: CreateCharacterInput): Character`: the seed is random if omitted.
    - `setCharacterRef(store, characterId, slot, imageId): Character`: the image must belong to that character.
  - Chapters:
    - `createChapter(store, mangaId, input: CreateChapterInput): Chapter`: number = max + 1, order = max + 1.
    - `reorderPages(store, chapterId, ids): Page[]`: `ids` must list exactly the chapter's story pages.
  - Panels: `updatePanel(store, panelId, patch: UpdatePanelInput): Panel`. It checks that:
    - `activeImageId` is a variant of this panel;
    - `refCharacterIds`, `script.characters` and `script.dialogue` speakers belong to this manga.
  - Frames:
    - `createFrame(store, pageId, input: CreateFrameInput): TextFrame` (C.2).
      - The default box is centred in the anchor panel (or on the page) at 30% × 12% of the page, clamped inside the page.
      - The font comes from `FONT_FOR_KIND` and the size from `DEFAULT_FONT_SIZE`; `order` is max + 1.
      - The anchor must be on the page, the speaker must belong to the manga, and `title` frames are allowed on cover pages only.
    - `updateFrame(store, frameId, patch: UpdateFrameInput): TextFrame`.
    - `defaultFrameBox(layout, format, panelId): Box`.
  - Uploads: `ACCEPTED_IMAGE_TYPES`, `saveUploadedImage(store, { mangaId, owner: {type, id}, role, bytes, mimetype }): Image`. Only `image/png` and `image/jpeg` are accepted, and the header must parse. The original bytes are kept.
  - Deletes (C.1):
    - `deleteManga(store, id): Manga` also removes the manga's image folder.
    - `deleteChapter(store, id): Chapter`.
    - `deletePage` (from Task 12).
    - `deleteCharacter(store, id): Character` strips the character from panels' `refCharacterIds` and `script.characters`, and sets dialogue speakers to null.
    - `deleteImage(store, id): Image` also removes derived images (`parentImageId`), clears character refs, and removes the files. Panel active pointers are cleared by the FK.
  - `domain/index.ts` re-exports every domain module.

- [ ] **Step 1: Write the failing test**

`packages/server/test/domain-entities.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeRects, DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, newId, readingOrder, STYLE_PRESETS, type Manga,
} from '@manga/shared';
import { NotFoundError, ValidationError } from '../src/errors.js';
import {
  createChapter, createCharacter, createFrame, createManga, createPage, createCoverPage, deleteChapter, deleteCharacter,
  deleteImage, deleteManga, reorderPages, saveUploadedImage, setCharacterRef, updateFrame, updateManga, updatePanel,
} from '../src/domain/index.js';
import { makeJpegHeader, makePng } from './helpers/png.js';
import { addPanelImage, makeStore, type TestStore } from './helpers/store.js';

let t: TestStore;
let manga: Manga;

beforeEach(() => {
  t = makeStore();
  manga = createManga(t.store, { title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
});
afterEach(() => t.close());

const frameInput = { text: 'Hi', panelId: null, speakerId: null, rotation: 0, autoFit: true, align: 'center' as const };

function character(name = 'Aiko', mangaId = manga.id) {
  return createCharacter(t.store, mangaId, { name, role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl', recipe: null });
}

function characterImage(characterId: string, role: 'portrait' | null = 'portrait') {
  return saveUploadedImage(t.store, { mangaId: manga.id, owner: { type: 'character', id: characterId }, role, bytes: makePng(8, 8), mimetype: 'image/png' });
}

describe('mangas', () => {
  it('applies the style preset and the default page format', () => {
    expect(manga).toMatchObject({ title: 'Oni', pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']?.styleGuide, coverPageId: null });
  });

  it('rejects an unknown style preset, including prototype keys', () => {
    for (const stylePreset of ['nope', 'constructor']) {
      expect(() => createManga(t.store, { title: 'X', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset })).toThrow(ValidationError);
    }
  });

  it('mirrors page layouts and frames when the reading direction changes, so story order is kept', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'left-tall-2');
    const before = readingOrder(d.page.layout, 'ltr');
    const f = createFrame(t.store, d.page.id, { ...frameInput, kind: 'sfx', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, tail: { x: 0.2, y: 0.5 }, rotation: -10 });
    updateManga(t.store, manga.id, { readingDirection: 'rtl' });
    const page = t.store.pages.require(d.page.id);
    expect(readingOrder(page.layout, 'rtl')).toEqual(before);
    const rects = new Map(computeRects(page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
    expect(rects.get(before[0] ?? '')?.x).toBeGreaterThan(0.5);
    const moved = t.store.frames.require(f.id);
    expect(moved.box.x).toBeCloseTo(0.6);
    expect(moved.tail).toEqual({ x: 0.8, y: 0.5 });
    expect(moved.rotation).toBe(10);
    updateManga(t.store, manga.id, { readingDirection: 'rtl', title: 'Oni II' });
    expect(t.store.pages.require(d.page.id).layout).toEqual(page.layout);
  });
});

describe('characters', () => {
  it('gets a random seed unless one is given', () => {
    const a = character();
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.refs).toEqual({});
    const b = createCharacter(t.store, manga.id, { name: 'Ren', role: 'supporting', personality: '', speechStyle: '', appearanceTags: '', recipe: null, seed: 42 });
    expect(b.seed).toBe(42);
    expect(() => character('Ghost', 'mg_missing000')).toThrow(NotFoundError);
  });

  it('sets a ref slot only to an image of that character', () => {
    const a = character();
    const b = character('Ren');
    const img = characterImage(a.id);
    expect(setCharacterRef(t.store, a.id, 'fullbody', img.id).refs).toEqual({ fullbody: img.id });
    expect(() => setCharacterRef(t.store, b.id, 'portrait', img.id)).toThrow(ValidationError);
  });
});

describe('chapters', () => {
  it('numbers chapters max + 1 and reorders pages only with the complete list', () => {
    const c1 = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const c2 = createChapter(t.store, manga.id, { title: 'Two', synopsis: '' });
    expect([c1.number, c2.number, c1.order, c2.order]).toEqual([1, 2, 0, 1]);
    deleteChapter(t.store, c1.id);
    expect(createChapter(t.store, manga.id, { title: 'Three', synopsis: '' }).number).toBe(3);
    const p1 = createPage(t.store, c2.id, 'splash').page;
    const p2 = createPage(t.store, c2.id, 'splash').page;
    createCoverPage(t.store, manga.id, c2.id);
    expect(reorderPages(t.store, c2.id, [p2.id, p1.id]).map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect(() => reorderPages(t.store, c2.id, [p2.id])).toThrow(ValidationError);
    expect(() => reorderPages(t.store, c2.id, [p2.id, p2.id])).toThrow(ValidationError);
  });
});

describe('panels', () => {
  it('accepts only its own variants as the active image and characters of its manga', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, '2-rows');
    const [a, b] = [d.panels[0]?.id ?? '', d.panels[1]?.id ?? ''];
    const own = addPanelImage(t.store, manga.id, a);
    const other = addPanelImage(t.store, manga.id, b);
    expect(updatePanel(t.store, a, { activeImageId: own.id }).activeImageId).toBe(own.id);
    expect(() => updatePanel(t.store, a, { activeImageId: other.id })).toThrow(ValidationError);
    const aiko = character();
    const stranger = createManga(t.store, { title: 'Other', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
    const foreign = character('Foreign', stranger.id);
    expect(updatePanel(t.store, a, { refCharacterIds: [aiko.id] }).refCharacterIds).toEqual([aiko.id]);
    expect(() => updatePanel(t.store, a, { refCharacterIds: [foreign.id] })).toThrow(ValidationError);
    expect(() => updatePanel(t.store, a, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: foreign.id, kind: 'speech', text: 'hey' }] } })).toThrow(ValidationError);
  });
});

describe('frames', () => {
  it('centres the default box in the anchor panel, or on the page, with the kind font and size', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, '2x2');
    const anchor = d.panels[0]?.id ?? '';
    const f1 = createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', panelId: anchor });
    const rect = computeRects(d.page.layout, manga.pageFormat).find((r) => r.panelId === anchor)?.rect;
    expect(f1.box.x).toBeCloseTo((rect?.x ?? 0) + (rect?.w ?? 0) / 2 - 0.15);
    expect(f1.box.y).toBeCloseTo((rect?.y ?? 0) + (rect?.h ?? 0) / 2 - 0.06);
    expect([f1.box.w, f1.box.h, f1.font, f1.fontSize, f1.order]).toEqual([0.3, 0.12, 'Shantell Sans', 9, 0]);
    const f2 = createFrame(t.store, d.page.id, { ...frameInput, kind: 'narration' });
    expect(f2.box).toEqual({ x: 0.35, y: 0.44, w: 0.3, h: 0.12 });
    expect([f2.font, f2.fontSize, f2.order]).toEqual(['Sofia Sans Condensed', 8, 1]);
  });

  it('validates the anchor, the speaker and title frames, on create and on update', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const other = createPage(t.store, ch.id, 'splash');
    const stranger = createManga(t.store, { title: 'Other', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
    const foreign = character('Foreign', stranger.id);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', panelId: other.panels[0]?.id ?? '' })).toThrow(ValidationError);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', speakerId: foreign.id })).toThrow(ValidationError);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'title' })).toThrow(ValidationError);
    const cover = createCoverPage(t.store, manga.id, null);
    expect(createFrame(t.store, cover.page.id, { ...frameInput, kind: 'title', text: 'ONI' }).font).toBe('Unbounded');
    const f = createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech' });
    expect(updateFrame(t.store, f.id, { text: 'Hello', box: { x: 0, y: 0, w: 0.5, h: 0.2 } })).toMatchObject({ text: 'Hello', box: { x: 0, y: 0, w: 0.5, h: 0.2 } });
    expect(() => updateFrame(t.store, f.id, { kind: 'title' })).toThrow(ValidationError);
    expect(() => updateFrame(t.store, f.id, { speakerId: foreign.id })).toThrow(ValidationError);
  });
});

describe('uploads', () => {
  it('stores PNG and JPEG bytes as-is with their dimensions', () => {
    const a = character();
    const png = characterImage(a.id);
    expect(png).toMatchObject({ width: 8, height: 8, source: 'uploaded', role: 'portrait', path: `mangas/${manga.id}/images/${png.id}.png` });
    const jpg = saveUploadedImage(t.store, { mangaId: manga.id, owner: { type: 'character', id: a.id }, role: null, bytes: makeJpegHeader(300, 200), mimetype: 'image/jpeg' });
    expect([jpg.width, jpg.height]).toEqual([300, 200]);
  });

  it('rejects other types and unreadable files without writing anything', () => {
    const a = character();
    const owner = { type: 'character' as const, id: a.id };
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner, role: null, bytes: makePng(2, 2), mimetype: 'image/gif' })).toThrow(ValidationError);
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner, role: null, bytes: Buffer.from('not a png'), mimetype: 'image/png' })).toThrow(ValidationError);
    expect(existsSync(join(t.path, 'mangas'))).toBe(false);
    expect(t.store.images.listByManga(manga.id)).toEqual([]);
  });
});

describe('cascade deletes', () => {
  it('deleteImage removes the file and derived images and clears character refs and the active pointer', () => {
    const a = character();
    const img = characterImage(a.id);
    setCharacterRef(t.store, a.id, 'portrait', img.id);
    const upscaled = t.store.images.create({ ...img, id: newId('im'), path: t.store.files.writeImage(manga.id, 'im_derived00', makePng(16, 16)), source: 'upscaled', parentImageId: img.id });
    deleteImage(t.store, img.id);
    expect(t.store.characters.require(a.id).refs).toEqual({});
    expect(t.store.images.get(upscaled.id)).toBeNull();
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    expect(existsSync(t.store.files.abs(upscaled.path))).toBe(false);
  });

  it('deleteCharacter removes its images and strips it from panel scripts and refs', () => {
    const a = character();
    const img = characterImage(a.id);
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const panelId = d.panels[0]?.id ?? '';
    updatePanel(t.store, panelId, {
      refCharacterIds: [a.id],
      script: { ...EMPTY_SCRIPT, characters: [{ characterId: a.id, pose: '', expression: '', position: 'center' }], dialogue: [{ speakerId: a.id, kind: 'speech', text: 'Hi' }] },
    });
    deleteCharacter(t.store, a.id);
    const panel = t.store.panels.require(panelId);
    expect(panel.refCharacterIds).toEqual([]);
    expect(panel.script.characters).toEqual([]);
    expect(panel.script.dialogue).toEqual([{ speakerId: null, kind: 'speech', text: 'Hi' }]);
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    expect(t.store.characters.get(a.id)).toBeNull();
  });

  it('deleteChapter removes its pages and their image files; deleteManga removes the manga folder', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const img = addPanelImage(t.store, manga.id, d.panels[0]?.id ?? '');
    deleteChapter(t.store, ch.id);
    expect(t.store.pages.get(d.page.id)).toBeNull();
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    const a = character();
    characterImage(a.id);
    deleteManga(t.store, manga.id);
    expect(t.store.mangas.get(manga.id)).toBeNull();
    expect(t.store.characters.get(a.id)).toBeNull();
    expect(existsSync(join(t.path, 'mangas', manga.id))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/domain-entities.test.ts`
Expected: FAIL. `../src/domain/index.js` cannot be found.

- [ ] **Step 3: Write the entity services**

`packages/server/src/domain/mangas.ts`:

```ts
import type { z } from 'zod';
import {
  DEFAULT_PAGE_FORMAT, mirrorLayout, STYLE_PRESETS, type CreateMangaSchema, type Manga, type StylePreset, type UpdateMangaSchema,
} from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { defined } from '../util/defined.js';

export type CreateMangaInput = z.infer<typeof CreateMangaSchema>;
export type UpdateMangaInput = z.infer<typeof UpdateMangaSchema>;

export function stylePreset(id: string): StylePreset {
  const preset = Object.hasOwn(STYLE_PRESETS, id) ? STYLE_PRESETS[id] : undefined;
  if (preset === undefined) throw new ValidationError(`unknown style preset "${id}"`, { known: Object.keys(STYLE_PRESETS) });
  return preset;
}

export function createManga(store: Store, input: CreateMangaInput): Manga {
  const preset = stylePreset(input.stylePreset);
  return store.mangas.create({
    title: input.title,
    synopsis: input.synopsis,
    language: input.language,
    colorMode: input.colorMode,
    readingDirection: input.readingDirection,
    pageFormat: structuredClone(DEFAULT_PAGE_FORMAT),
    styleGuide: structuredClone(preset.styleGuide),
    coverPageId: null,
  });
}

/** Mirrors every layout and frame of the manga left↔right, so a direction change keeps the story order. */
function mirrorPages(store: Store, mangaId: string): void {
  for (const page of store.pages.listByManga(mangaId)) {
    store.pages.update(page.id, { layout: mirrorLayout(page.layout) });
    for (const frame of store.frames.listByPage(page.id)) {
      store.frames.update(frame.id, {
        box: { ...frame.box, x: 1 - frame.box.x - frame.box.w },
        tail: frame.tail === null ? null : { x: 1 - frame.tail.x, y: frame.tail.y },
        rotation: frame.rotation === 0 ? 0 : -frame.rotation,
      });
    }
  }
}

export function updateManga(store: Store, mangaId: string, patch: UpdateMangaInput): Manga {
  const before = store.mangas.require(mangaId);
  return store.tx(() => {
    const after = store.mangas.update(mangaId, defined(patch));
    if (after.readingDirection !== before.readingDirection) mirrorPages(store, mangaId);
    return after;
  });
}
```

`packages/server/src/domain/characters.ts`:

```ts
import type { z } from 'zod';
import type { Character, CreateCharacterSchema, RefSlot } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { randomSeed } from './seed.js';

export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>;

/** Seed random if omitted. */
export function createCharacter(store: Store, mangaId: string, input: CreateCharacterInput): Character {
  store.mangas.require(mangaId);
  return store.characters.create({
    mangaId,
    name: input.name,
    role: input.role,
    personality: input.personality,
    speechStyle: input.speechStyle,
    appearanceTags: input.appearanceTags,
    seed: input.seed ?? randomSeed(),
    recipe: input.recipe,
    refs: {},
  });
}

/** Points a ref slot at one of the character's own images. */
export function setCharacterRef(store: Store, characterId: string, slot: RefSlot, imageId: string): Character {
  const character = store.characters.require(characterId);
  const image = store.images.require(imageId);
  if (image.ownerType !== 'character' || image.ownerId !== characterId) {
    throw new ValidationError(`image ${imageId} does not belong to character ${characterId}`);
  }
  const refs = { ...character.refs };
  refs[slot] = imageId;
  return store.characters.update(characterId, { refs });
}
```

`packages/server/src/domain/chapters.ts`:

```ts
import type { z } from 'zod';
import type { Chapter, CreateChapterSchema, Page } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { chapterPages } from './order.js';

export type CreateChapterInput = z.infer<typeof CreateChapterSchema>;

/** number = max + 1 (numbers are never reused), order = after the last chapter. */
export function createChapter(store: Store, mangaId: string, input: CreateChapterInput): Chapter {
  store.mangas.require(mangaId);
  const existing = store.chapters.listByManga(mangaId);
  const number = existing.reduce((max, c) => Math.max(max, c.number), 0) + 1;
  const order = existing.reduce((max, c) => Math.max(max, c.order + 1), 0);
  return store.chapters.create({ mangaId, number, title: input.title, synopsis: input.synopsis, coverPageId: null, status: 'draft', order });
}

/** `ids` must list every story page of the chapter exactly once. */
export function reorderPages(store: Store, chapterId: string, ids: readonly string[]): Page[] {
  store.chapters.require(chapterId);
  const pages = chapterPages(store, chapterId);
  const known = new Set(pages.map((p) => p.id));
  const complete = ids.length === pages.length && new Set(ids).size === ids.length && ids.every((id) => known.has(id));
  if (!complete) throw new ValidationError('ids must list every page of the chapter exactly once', { expected: pages.map((p) => p.id) });
  store.tx(() => {
    ids.forEach((id, order) => store.pages.update(id, { order }));
  });
  return chapterPages(store, chapterId);
}
```

Replace `packages/server/src/domain/panels.ts` with:

```ts
import type { z } from 'zod';
import { DEFAULT_TRANSFORM, EMPTY_SCRIPT, type Panel, type UpdatePanelSchema } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { NewPanel, Store } from '../store/index.js';
import { defined } from '../util/defined.js';
import { randomSeed } from './seed.js';

export type UpdatePanelInput = z.infer<typeof UpdatePanelSchema>;

/** A blank panel row for a layout leaf. */
export function newPanelInput(pageId: string, id: string): NewPanel {
  return {
    id, pageId, script: structuredClone(EMPTY_SCRIPT), prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: randomSeed(), refCharacterIds: [], activeImageId: null, imageTransform: { ...DEFAULT_TRANSFORM },
  };
}

function requireCharacterOf(store: Store, mangaId: string, characterId: string): void {
  const character = store.characters.require(characterId);
  if (character.mangaId !== mangaId) throw new ValidationError(`character ${characterId} belongs to another manga`);
}

export function updatePanel(store: Store, panelId: string, patch: UpdatePanelInput): Panel {
  const panel = store.panels.require(panelId);
  const { mangaId } = store.pages.require(panel.pageId);
  if (patch.activeImageId) {
    const image = store.images.require(patch.activeImageId);
    if (image.ownerType !== 'panel' || image.ownerId !== panelId) throw new ValidationError(`image ${image.id} is not a variant of panel ${panelId}`);
  }
  for (const id of patch.refCharacterIds ?? []) requireCharacterOf(store, mangaId, id);
  for (const c of patch.script?.characters ?? []) requireCharacterOf(store, mangaId, c.characterId);
  for (const line of patch.script?.dialogue ?? []) {
    if (line.speakerId !== null) requireCharacterOf(store, mangaId, line.speakerId);
  }
  return store.panels.update(panelId, defined(patch));
}
```

`packages/server/src/domain/frames.ts`:

```ts
import type { z } from 'zod';
import {
  computeRects, DEFAULT_FONT_SIZE, FONT_FOR_KIND, panelIds,
  type Box, type CreateFrameSchema, type FrameKind, type LayoutNode, type Page, type PageFormat, type TextFrame, type UpdateFrameSchema,
} from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { defined } from '../util/defined.js';

export type CreateFrameInput = z.infer<typeof CreateFrameSchema>;
export type UpdateFrameInput = z.infer<typeof UpdateFrameSchema>;

export const DEFAULT_FRAME_W = 0.3;
export const DEFAULT_FRAME_H = 0.12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 30%×12% of the page, centred in the anchor panel (or the page), kept inside the page. */
export function defaultFrameBox(layout: LayoutNode, format: PageFormat, panelId: string | null): Box {
  let cx = 0.5;
  let cy = 0.5;
  const rect = panelId === null ? undefined : computeRects(layout, format).find((r) => r.panelId === panelId)?.rect;
  if (rect) {
    cx = rect.x + rect.w / 2;
    cy = rect.y + rect.h / 2;
  }
  return {
    x: clamp(cx - DEFAULT_FRAME_W / 2, 0, 1 - DEFAULT_FRAME_W),
    y: clamp(cy - DEFAULT_FRAME_H / 2, 0, 1 - DEFAULT_FRAME_H),
    w: DEFAULT_FRAME_W,
    h: DEFAULT_FRAME_H,
  };
}

function checkAnchor(page: Page, panelId: string | null): void {
  if (panelId !== null && !panelIds(page.layout).includes(panelId)) throw new ValidationError(`panel ${panelId} is not on page ${page.id}`);
}

function checkSpeaker(store: Store, mangaId: string, speakerId: string | null): void {
  if (speakerId === null) return;
  if (store.characters.require(speakerId).mangaId !== mangaId) throw new ValidationError(`character ${speakerId} belongs to another manga`);
}

function checkKind(page: Page, kind: FrameKind): void {
  if (kind === 'title' && page.kind !== 'cover') throw new ValidationError('title frames are only allowed on cover pages');
}

export function createFrame(store: Store, pageId: string, input: CreateFrameInput): TextFrame {
  const page = store.pages.require(pageId);
  const manga = store.mangas.require(page.mangaId);
  checkKind(page, input.kind);
  checkAnchor(page, input.panelId);
  checkSpeaker(store, manga.id, input.speakerId);
  const order = store.frames.listByPage(pageId).reduce((max, f) => Math.max(max, f.order + 1), 0);
  return store.frames.create({
    pageId,
    panelId: input.panelId,
    kind: input.kind,
    text: input.text,
    speakerId: input.speakerId,
    box: input.box ?? defaultFrameBox(page.layout, manga.pageFormat, input.panelId),
    tail: input.tail ?? null,
    rotation: input.rotation,
    font: input.font ?? FONT_FOR_KIND[input.kind],
    fontSize: input.fontSize ?? DEFAULT_FONT_SIZE[input.kind],
    autoFit: input.autoFit,
    align: input.align,
    order,
  });
}

export function updateFrame(store: Store, frameId: string, patch: UpdateFrameInput): TextFrame {
  const frame = store.frames.require(frameId);
  const page = store.pages.require(frame.pageId);
  if (patch.kind !== undefined) checkKind(page, patch.kind);
  if (patch.panelId !== undefined) checkAnchor(page, patch.panelId);
  if (patch.speakerId !== undefined) checkSpeaker(store, page.mangaId, patch.speakerId);
  return store.frames.update(frameId, defined(patch));
}
```

`packages/server/src/domain/uploads.ts`:

```ts
import { newId, type Image, type RefSlot } from '@manga/shared';
import { ValidationError } from '../errors.js';
import { readImageMeta } from '../files/image-meta.js';
import type { Store } from '../store/index.js';

export const ACCEPTED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

export interface UploadRequest {
  mangaId: string;
  owner: { type: Image['ownerType']; id: string };
  role: RefSlot | null;
  bytes: Uint8Array;
  mimetype: string;
}

/** Stores the original bytes (PNG or JPEG only) and registers an `uploaded` Image. Nothing is written for a rejected file. */
export function saveUploadedImage(store: Store, req: UploadRequest): Image {
  if (!ACCEPTED_IMAGE_TYPES.has(req.mimetype)) throw new ValidationError(`unsupported file type ${req.mimetype}: upload a PNG or JPEG`);
  const meta = readImageMeta(req.bytes);
  if (meta === null) throw new ValidationError('the file is not a readable PNG or JPEG');
  const id = newId('im');
  const path = store.files.writeImage(req.mangaId, id, req.bytes);
  try {
    return store.images.create({
      id, mangaId: req.mangaId, ownerType: req.owner.type, ownerId: req.owner.id, role: req.role, path,
      width: meta.width, height: meta.height, source: 'uploaded', parentImageId: null, gen: null, review: null,
    });
  } catch (err) {
    store.files.remove(path);
    throw err;
  }
}
```

Replace `packages/server/src/domain/delete.ts` with the full version:

```ts
import { RefSlotSchema, type Chapter, type Character, type Image, type Manga, type Page } from '@manga/shared';
import type { Store } from '../store/index.js';
import { chapterPages, renumberPages } from './order.js';

/** Removes image files after the transaction that deleted their rows has committed. Missing files are ignored. */
export function removeFiles(store: Store, rels: readonly string[]): void {
  for (const rel of rels) store.files.remove(rel);
}

/** Deletes a panel and its image rows (frames anchored to it are un-anchored by the FK). Returns files to remove after commit. */
export function deletePanelRows(store: Store, panelId: string): string[] {
  const images = store.images.listByOwner('panel', panelId);
  for (const image of images) store.images.delete(image.id);
  store.panels.delete(panelId);
  return images.map((image) => image.path);
}

export function deletePage(store: Store, pageId: string): Page {
  const page = store.pages.require(pageId);
  const files: string[] = [];
  store.tx(() => {
    for (const panel of store.panels.listByPage(pageId)) files.push(...deletePanelRows(store, panel.id));
    store.pages.delete(pageId);
    if (page.kind === 'page' && page.chapterId !== null) renumberPages(store, chapterPages(store, page.chapterId));
  });
  removeFiles(store, files);
  return page;
}

export function deleteChapter(store: Store, chapterId: string): Chapter {
  const chapter = store.chapters.require(chapterId);
  const files: string[] = [];
  store.tx(() => {
    for (const page of store.pages.listByChapter(chapterId)) {
      for (const panel of store.panels.listByPage(page.id)) files.push(...deletePanelRows(store, panel.id));
    }
    store.chapters.delete(chapterId); // cascades pages, frames and episode runs
  });
  removeFiles(store, files);
  return chapter;
}

/** Everything under the manga goes by FK cascade; the image folder goes with it. */
export function deleteManga(store: Store, mangaId: string): Manga {
  const manga = store.mangas.require(mangaId);
  store.tx(() => store.mangas.delete(mangaId));
  store.files.removeMangaDir(mangaId);
  return manga;
}

/** Deletes the character's images and strips it from panel scripts and reference lists; frames lose their speaker by FK. */
export function deleteCharacter(store: Store, characterId: string): Character {
  const character = store.characters.require(characterId);
  const images = store.images.listByOwner('character', characterId);
  store.tx(() => {
    for (const page of store.pages.listByManga(character.mangaId)) {
      for (const panel of store.panels.listByPage(page.id)) {
        const refCharacterIds = panel.refCharacterIds.filter((id) => id !== characterId);
        const characters = panel.script.characters.filter((c) => c.characterId !== characterId);
        const spoke = panel.script.dialogue.some((line) => line.speakerId === characterId);
        if (refCharacterIds.length === panel.refCharacterIds.length && characters.length === panel.script.characters.length && !spoke) continue;
        const dialogue = panel.script.dialogue.map((line) => (line.speakerId === characterId ? { ...line, speakerId: null } : line));
        store.panels.update(panel.id, { refCharacterIds, script: { ...panel.script, characters, dialogue } });
      }
    }
    for (const image of images) store.images.delete(image.id);
    store.characters.delete(characterId);
  });
  removeFiles(store, images.map((image) => image.path));
  return character;
}

/** Deletes the image and images derived from it; clears character refs (panel active pointers clear by FK). */
export function deleteImage(store: Store, imageId: string): Image {
  const image = store.images.require(imageId);
  const doomed = [image, ...store.images.listByOwner(image.ownerType, image.ownerId).filter((i) => i.parentImageId === image.id)];
  const ids = new Set(doomed.map((i) => i.id));
  store.tx(() => {
    if (image.ownerType === 'character') {
      const character = store.characters.get(image.ownerId);
      if (character !== null) {
        const refs: Character['refs'] = {};
        for (const slot of RefSlotSchema.options) {
          const ref = character.refs[slot];
          if (ref !== undefined && !ids.has(ref)) refs[slot] = ref;
        }
        store.characters.update(character.id, { refs });
      }
    }
    for (const doomedImage of doomed) store.images.delete(doomedImage.id);
  });
  removeFiles(store, doomed.map((i) => i.path));
  return image;
}
```

`packages/server/src/domain/index.ts`:

```ts
export * from './chapters.js';
export * from './characters.js';
export * from './delete.js';
export * from './frames.js';
export * from './mangas.js';
export * from './order.js';
export * from './pages.js';
export * from './panels.js';
export * from './seed.js';
export * from './uploads.js';
```

- [ ] **Step 4: Run the domain tests to verify they pass**

Run: `npx vitest run packages/server/test/domain-entities.test.ts packages/server/test/domain-pages.test.ts`
Expected: PASS (27 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add manga, character, chapter, panel, frame and upload services with cascade deletes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: App composition, system routes, WebSocket events, static UI, `startServer`, `main`

**Files:**
- Create: `packages/server/src/deps.ts`, `packages/server/src/app.ts`, `packages/server/src/main.ts`, `packages/server/src/index.ts`
- Create: `packages/server/src/api/errors.ts`, `packages/server/src/api/util.ts`, `packages/server/src/api/system.ts`, `packages/server/src/api/events.ts`, `packages/server/src/api/static.ts`, `packages/server/src/api/routes.ts`
- Create: `packages/server/test/helpers/app.ts`, `packages/server/test/helpers/multipart.ts`
- Test: `packages/server/test/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7–13.
- Produces (contract C.5 and Contract B, M1 system rows):
  - `interface CoreDeps { config; store; bus; queue; gpu; statusProviders }`.
  - `interface StatusProviders { claude(); ollama(); comfy() }`: each defaults to `{ ok: false, detail: 'not configured' }`.
  - `interface AppModule { name; register(app, deps); start?(deps); stop?() }`.
  - `NOT_CONFIGURED`, `defaultStatusProviders()`.
  - `buildApp(deps, modules, options?: { uiDir?: string | null }): Promise<FastifyInstance>`. The order is: error handler, then `@fastify/websocket` and `@fastify/multipart` (50 MB, 1 file), then modules, then `await app.after()`, then the core routes, then static UI and the not-found handler. M1 never registers `GET /api/recipes` (M2 does).
  - `startServer(opts?: { config?; modules?; uiDir? }): Promise<RunningServer>` with `RunningServer { app; deps; url; stop() }`. The order is: loadConfig, openStore, buildApp, listen on `127.0.0.1`, module `start`, `queue.start()`, write `server.json`. `stop()` reverses this and removes `server.json` if it is ours.
  - `toApiError(err): { status; body: ApiErrorBody }`, `installErrorHandling(app)`:
    - `ZodError` → 400 `validation` (message `path: issue; …`).
    - `HttpError` → its own status and code.
    - `LayoutError` → `not-found` becomes 404; `not-siblings` and `unknown-preset` become 400 `validation`.
    - Any other 4xx Fastify error → 400 `validation`.
    - Anything else → 500 `internal` with the message `internal error`, and it is logged.
  - `emitEntity(bus, entity, id, op, mangaId)`, `readUpload(req)`, `interface IdParams`, `OK`.
  - `registerCoreRoutes(app, deps)`.
  - Routes: `GET /api/health`, `GET /api/status`, `GET/PATCH /api/settings`, `GET /api/layouts`, `GET /api/style-presets`, and the WebSocket `/api/events` (`hello` first, then every bus event).
  - `defaultUiDir()`, i.e. `packages/ui/dist` relative to the server package.
  - `registerStaticUi(app, uiDir | null)`: SPA fallback for extension-less GETs outside `/api` and `/files`; everything else unmatched → 404 `not_found` JSON.
  - Test helpers `makeTestApp({ modules?, uiDir? })` (queue not started) → `{ app, deps, lib, close }`, `call(app, method, url, payload?)` → `{ status, body }`, and `multipart(field, filename, contentType, data)`.

- [ ] **Step 1: Write the test helpers**

`packages/server/test/helpers/multipart.ts`:

```ts
/** A single-file multipart/form-data body for app.inject(). */
export function multipart(field: string, filename: string, contentType: string, data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----manga-test-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
```

`packages/server/test/helpers/app.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { AppConfigSchema } from '@manga/shared';
import { buildApp, defaultStatusProviders, type AppModule, type CoreDeps } from '../../src/app.js';
import { EventBus } from '../../src/events/bus.js';
import { GpuArbiter } from '../../src/jobs/gpu.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { openStore } from '../../src/store/index.js';
import { tempDir } from './tmp.js';

export interface TestApp { app: FastifyInstance; deps: CoreDeps; lib: string; close(): Promise<void> }

/** An app over a temp library, not listening (use app.inject). The job queue is NOT started. */
export async function makeTestApp(opts: { modules?: AppModule[]; uiDir?: string | null } = {}): Promise<TestApp> {
  const dir = tempDir('manga-api-');
  const store = openStore(dir.path);
  const bus = new EventBus();
  const gpu = new GpuArbiter();
  const deps: CoreDeps = {
    config: AppConfigSchema.parse({ libraryPath: dir.path, port: 0 }),
    store, bus, gpu,
    queue: new JobQueue({ store, bus, gpu, pollMs: 10 }),
    statusProviders: defaultStatusProviders(),
  };
  const app = await buildApp(deps, opts.modules ?? [], { uiDir: opts.uiDir ?? null });
  await app.ready();
  return {
    app, deps, lib: dir.path,
    async close() {
      await deps.queue.stop();
      await app.close();
      store.close();
      dir.cleanup();
    },
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** JSON request through app.inject; body is the parsed JSON response (undefined when empty). */
export async function call<T = unknown>(app: FastifyInstance, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { status: res.statusCode, body: (res.body.length > 0 ? JSON.parse(res.body) : undefined) as T };
}
```

- [ ] **Step 2: Write the failing test**

`packages/server/test/app.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, type ServerEvent, type Settings } from '@manga/shared';
import { startServer, type AppModule } from '../src/app.js';
import { readServerInfo } from '../src/config.js';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { tempDir } from './helpers/tmp.js';

type ErrorReply = { error: { code: string; message: string } };

describe('system routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('GET /api/health reports ok, pid and version', async () => {
    expect(await call(t.app, 'GET', '/api/health')).toEqual({ status: 200, body: { ok: true, pid: process.pid, version: '0.1.0' } });
  });

  it('GET /api/status reports unconfigured services and the queue', async () => {
    t.deps.queue.pauseLane('claude', null, 'quota exhausted');
    const off = { ok: false, detail: 'not configured' };
    expect((await call(t.app, 'GET', '/api/status')).body).toEqual({
      claude: off, ollama: off, comfy: off,
      queue: { queued: 0, running: 0, pausedLanes: [{ lane: 'claude', until: null, reason: 'quota exhausted' }] },
    });
  });

  it('reports a throwing status provider as down instead of failing the request', async () => {
    t.deps.statusProviders.comfy = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await call<{ comfy: unknown }>(t.app, 'GET', '/api/status')).body.comfy).toEqual({ ok: false, detail: 'ECONNREFUSED' });
  });

  it('GET/PATCH /api/settings validates, persists and emits an entity event', async () => {
    const events: ServerEvent[] = [];
    t.deps.bus.on((e) => events.push(e));
    expect((await call(t.app, 'GET', '/api/settings')).body).toEqual(DEFAULT_SETTINGS);
    expect((await call<Settings>(t.app, 'PATCH', '/api/settings', { engine: { mode: 'local' } })).body.engine.mode).toBe('local');
    expect((await call<Settings>(t.app, 'GET', '/api/settings')).body.engine.mode).toBe('local');
    expect(events).toEqual([{ type: 'entity', entity: 'settings', id: 'settings', op: 'updated', mangaId: null }]);
    const bad = await call<ErrorReply>(t.app, 'PATCH', '/api/settings', { review: { rounds: 99 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toContain('review.rounds');
  });

  it('GET /api/layouts and /api/style-presets', async () => {
    const layouts = await call<Array<{ name: string; panelCount: number }>>(t.app, 'GET', '/api/layouts');
    expect(layouts.body).toHaveLength(16);
    expect(layouts.body.find((l) => l.name === '2x3')).toEqual({ name: '2x3', panelCount: 6 });
    const styles = await call<Array<{ id: string }>>(t.app, 'GET', '/api/style-presets');
    expect(styles.body.map((s) => s.id)).toEqual(['manga-bw', 'manga-hatching', 'anime-color', 'anima-bw']);
  });

  it('does not register GET /api/recipes (M2 owns that route)', async () => {
    expect(await call(t.app, 'GET', '/api/recipes')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('answers unknown routes and malformed JSON with an ApiErrorBody', async () => {
    expect(await call(t.app, 'GET', '/api/nope')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { 'content-type': 'application/json' }, payload: '{ nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });
});

describe('modules', () => {
  it('can register GET /api/recipes without a duplicate-route error, and internal errors are hidden behind 500 internal', async () => {
    const mod: AppModule = {
      name: 'fake-imaging',
      register(app) {
        app.get('/api/recipes', async () => [{ id: 'anime' }]);
        app.get('/api/boom', async () => {
          throw new Error('SQLITE_CORRUPT at C:/secret/path');
        });
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await makeTestApp({ modules: [mod] });
    try {
      expect((await call(t.app, 'GET', '/api/recipes')).body).toEqual([{ id: 'anime' }]);
      expect(await call(t.app, 'GET', '/api/boom')).toEqual({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await t.close();
    }
  });
});

describe('UI static files', () => {
  it('serves packages/ui/dist with an SPA fallback when it exists', async () => {
    const ui = tempDir('manga-ui-');
    mkdirSync(join(ui.path, 'assets'));
    writeFileSync(join(ui.path, 'index.html'), '<!doctype html><title>Manga</title>');
    writeFileSync(join(ui.path, 'assets', 'app.js'), 'console.log(1)');
    const t = await makeTestApp({ uiDir: ui.path });
    try {
      for (const url of ['/', '/m/mg_abc/c/ch_def', '/settings']) {
        const res = await t.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.body).toContain('<title>Manga</title>');
      }
      const js = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
      expect([js.statusCode, js.body]).toEqual([200, 'console.log(1)']);
      for (const url of ['/assets/missing.js', '/api/nope', '/files/nope']) {
        const res = await t.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
      }
    } finally {
      await t.close();
      ui.cleanup();
    }
  });

  it('serves no UI when the folder does not exist', async () => {
    const t = await makeTestApp({ uiDir: join(tmpdir(), 'manga-no-ui-here') });
    try {
      expect((await t.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe('startServer', () => {
  it('listens on 127.0.0.1, writes server.json, streams events with hello first, and cleans up on stop', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(readServerInfo(dir.path)).toMatchObject({ pid: process.pid, port: Number(new URL(server.url).port) });
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
      const messages: ServerEvent[] = [];
      const ws = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/events`);
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (raw) => {
          messages.push(JSON.parse(String(raw)) as ServerEvent);
          if (messages.length === 1) {
            void fetch(`${server.url}/api/settings`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: { mode: 'local' } }),
            });
          }
          if (messages.length === 2) resolve();
        });
        ws.on('error', reject);
      });
      ws.close();
      expect(messages[0]).toMatchObject({ type: 'hello' });
      expect(messages[1]).toEqual({ type: 'entity', entity: 'settings', id: 'settings', op: 'updated', mangaId: null });
    } finally {
      await server.stop();
    }
    expect(readServerInfo(dir.path)).toBeNull();
    dir.cleanup();
  });

  it('runs module register/start/stop hooks and starts the job queue', async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const server = await startServer({
      config: { libraryPath: dir.path, port: 0 },
      uiDir: null,
      modules: (deps) => [{
        name: 'probe',
        register: () => {
          calls.push('register');
        },
        start: () => {
          calls.push('start');
          deps.queue.register('export.render', async () => ({ files: [] }));
        },
        stop: () => {
          calls.push('stop');
        },
      }],
    });
    try {
      const job = server.deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
      expect((await server.deps.queue.waitFor(job.id)).status).toBe('succeeded');
    } finally {
      await server.stop();
      dir.cleanup();
    }
    expect(calls).toEqual(['register', 'start', 'stop']);
  });

  it('fails with EADDRINUSE on a busy port without touching the running server', async () => {
    const dir = tempDir();
    const first = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      first.deps.queue.register('export.render', (ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(null));
      }));
      const job = first.deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
      await vi.waitFor(() => expect(first.deps.store.jobs.require(job.id).status).toBe('running'));
      const port = Number(new URL(first.url).port);
      await expect(startServer({ config: { libraryPath: dir.path, port }, uiDir: null })).rejects.toThrow(/EADDRINUSE/);
      expect(first.deps.store.jobs.require(job.id).status).toBe('running');
      expect(readServerInfo(dir.path)?.port).toBe(port);
    } finally {
      await first.stop();
      dir.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/app.test.ts`
Expected: FAIL. `../../src/app.js` cannot be found.

- [ ] **Step 4: Write the dependency types and API plumbing**

`packages/server/src/deps.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppConfig, ServiceState } from '@manga/shared';
import type { EventBus } from './events/bus.js';
import type { GpuArbiter } from './jobs/gpu.js';
import type { JobQueue } from './jobs/queue.js';
import type { Store } from './store/index.js';

export interface StatusProviders { claude(): Promise<ServiceState>; ollama(): Promise<ServiceState>; comfy(): Promise<ServiceState> } // M1 defaults: {ok:false, detail:'not configured'}
export interface CoreDeps { config: AppConfig; store: Store; bus: EventBus; queue: JobQueue; gpu: GpuArbiter; statusProviders: StatusProviders }
export interface AppModule { name: string; register(app: FastifyInstance, deps: CoreDeps): Promise<void> | void; start?(deps: CoreDeps): Promise<void> | void; stop?(): Promise<void> | void }

export const NOT_CONFIGURED: ServiceState = { ok: false, detail: 'not configured' };

export function defaultStatusProviders(): StatusProviders {
  const notConfigured = async (): Promise<ServiceState> => ({ ...NOT_CONFIGURED });
  return { claude: notConfigured, ollama: notConfigured, comfy: notConfigured };
}
```

`packages/server/src/api/errors.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { LayoutError, type ApiErrorBody } from '@manga/shared';
import { HttpError, type ApiErrorCode } from '../errors.js';

export interface ApiErrorReply { status: number; body: ApiErrorBody }

function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Maps anything a route throws to the contract's ApiErrorBody and HTTP status. */
export function toApiError(err: unknown): ApiErrorReply {
  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'body'}: ${issue.message}`)
      .join('; ');
    return { status: 400, body: errorBody('validation', message, err.issues) };
  }
  if (err instanceof HttpError) return { status: err.status, body: errorBody(err.code, err.message, err.details) };
  if (err instanceof LayoutError) {
    return err.code === 'not-found'
      ? { status: 404, body: errorBody('not_found', err.message, { layoutError: err.code }) }
      : { status: 400, body: errorBody('validation', err.message, { layoutError: err.code }) };
  }
  const statusCode = typeof err === 'object' && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { status: 400, body: errorBody('validation', err instanceof Error ? err.message : 'bad request') };
  }
  return { status: 500, body: errorBody('internal', 'internal error') };
}

/** SQLite text and file paths go to the log, never to the client. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const out = toApiError(err);
    if (out.status >= 500) console.error(`[manga] ${req.method} ${req.url.split('?')[0] ?? ''} failed:`, err);
    return reply.code(out.status).send(out.body);
  });
}
```

`packages/server/src/api/util.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import type { EntityName } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { EventBus } from '../events/bus.js';

export interface IdParams { Params: { id: string } }

export const OK = { ok: true } as const;

export function emitEntity(bus: EventBus, entity: EntityName, id: string, op: 'created' | 'updated' | 'deleted', mangaId: string | null): void {
  bus.emit({ type: 'entity', entity, id, op, mangaId });
}

export interface Upload { bytes: Buffer; mimetype: string; filename: string }

/** Reads the single multipart field `file` into memory (limit set in buildApp). */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw new ValidationError('expected a multipart/form-data upload with a "file" field');
  const file = await req.file();
  if (file === undefined) throw new ValidationError('the upload has no "file" field');
  if (file.fieldname !== 'file') throw new ValidationError(`expected the upload in a field named "file", got "${file.fieldname}"`);
  return { bytes: await file.toBuffer(), mimetype: file.mimetype, filename: file.filename };
}
```

`packages/server/src/api/system.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  PRESET_NAMES, presetPanelCount, SettingsPatchSchema, STYLE_PRESETS,
  type PresetInfo, type ServiceState, type ServiceStatus, type Settings, type StylePreset,
} from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { VERSION } from '../version.js';
import { emitEntity } from './util.js';

async function probe(check: () => Promise<ServiceState>): Promise<ServiceState> {
  try {
    return await check();
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function registerSystemRoutes(app: FastifyInstance, deps: CoreDeps): void {
  app.get('/api/health', async () => ({ ok: true, pid: process.pid, version: VERSION }));

  app.get('/api/status', async (): Promise<ServiceStatus> => {
    const providers = deps.statusProviders;
    const [claude, ollama, comfy] = await Promise.all([
      probe(() => providers.claude()), probe(() => providers.ollama()), probe(() => providers.comfy()),
    ]);
    return { claude, ollama, comfy, queue: { ...deps.store.jobs.counts(), pausedLanes: deps.queue.pausedLanes() } };
  });

  app.get('/api/settings', async (): Promise<Settings> => deps.store.settings.get());

  app.patch('/api/settings', async (req): Promise<Settings> => {
    const settings = deps.store.settings.patch(SettingsPatchSchema.parse(req.body ?? {}));
    emitEntity(deps.bus, 'settings', 'settings', 'updated', null);
    return settings;
  });

  app.get('/api/layouts', async (): Promise<PresetInfo[]> => PRESET_NAMES.map((name) => ({ name, panelCount: presetPanelCount(name) })));

  app.get('/api/style-presets', async (): Promise<StylePreset[]> => Object.values(STYLE_PRESETS));
}
```

`packages/server/src/api/events.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@manga/shared';
import type { CoreDeps } from '../deps.js';

const WS_OPEN = 1;

/** WebSocket stream of ServerEvent JSON; the first message is always `hello`. */
export function registerEventRoutes(app: FastifyInstance, deps: CoreDeps): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent): void => {
      if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(event));
    };
    send({ type: 'hello', serverTime: new Date().toISOString() });
    const off = deps.bus.on(send);
    socket.on('close', off);
    socket.on('error', off);
  });
}
```

`packages/server/src/api/static.ts`:

```ts
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** packages/ui/dist (both src/api and dist/api sit three levels below packages/). */
export function defaultUiDir(): string {
  return fileURLToPath(new URL('../../../ui/dist', import.meta.url));
}

/**
 * Serves the built UI when the folder exists, with an SPA fallback: a GET outside /api and /files with no file
 * extension gets index.html. Everything else that matches no route is a JSON 404.
 */
export async function registerStaticUi(app: FastifyInstance, uiDir: string | null): Promise<void> {
  const root = uiDir !== null && existsSync(uiDir) ? uiDir : null;
  if (root !== null) await app.register(fastifyStatic, { root, wildcard: false });
  const hasUi = root !== null;
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const reserved = path === '/api' || path.startsWith('/api/') || path === '/files' || path.startsWith('/files/');
    if (hasUi && !reserved && (req.method === 'GET' || req.method === 'HEAD') && extname(path) === '') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: `no route for ${req.method} ${path}` } });
  });
}
```

`packages/server/src/api/routes.ts` (Tasks 15–17 extend it):

```ts
import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerEventRoutes } from './events.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
}
```

- [ ] **Step 5: Write the app composition, the entry point and the package index**

`packages/server/src/app.ts`:

```ts
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '@manga/shared';
import { installErrorHandling } from './api/errors.js';
import { registerCoreRoutes } from './api/routes.js';
import { defaultUiDir, registerStaticUi } from './api/static.js';
import { loadConfig, removeServerInfo, writeServerInfo } from './config.js';
import { defaultStatusProviders, type AppModule, type CoreDeps } from './deps.js';
import { EventBus } from './events/bus.js';
import { GpuArbiter } from './jobs/gpu.js';
import { JobQueue } from './jobs/queue.js';
import { openStore } from './store/index.js';

export type { AppModule, CoreDeps, StatusProviders } from './deps.js';
export { defaultStatusProviders, NOT_CONFIGURED } from './deps.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface BuildOptions { uiDir?: string | null }

export async function buildApp(deps: CoreDeps, modules: AppModule[], options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  installErrorHandling(app);
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  for (const mod of modules) await mod.register(app, deps);
  await app.after();
  registerCoreRoutes(app, deps);
  await registerStaticUi(app, options.uiDir === undefined ? defaultUiDir() : options.uiDir);
  return app;
}

export interface StartOptions { config?: Partial<AppConfig>; modules?: (deps: CoreDeps) => AppModule[]; uiDir?: string | null }
export interface RunningServer { app: FastifyInstance; deps: CoreDeps; url: string; stop(): Promise<void> }

/**
 * Listen first; only then start modules and the queue and claim server.json. A second server that fails with
 * EADDRINUSE therefore never resets the running server's jobs.
 */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadConfig(opts.config ?? {});
  mkdirSync(config.libraryPath, { recursive: true });
  const store = openStore(config.libraryPath);
  const bus = new EventBus();
  const gpu = new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const deps: CoreDeps = { config, store, bus, queue, gpu, statusProviders: defaultStatusProviders() };
  const modules = opts.modules ? opts.modules(deps) : [];

  let app: FastifyInstance | null = null;
  try {
    app = await buildApp(deps, modules, opts.uiDir === undefined ? {} : { uiDir: opts.uiDir });
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    if (app) await app.close();
    store.close();
    throw err;
  }
  const running = app;
  for (const mod of modules) await mod.start?.(deps);
  queue.start();

  const port = (running.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  writeServerInfo(config.libraryPath, { pid: process.pid, port, startedAt: new Date().toISOString() });

  let stopped = false;
  return {
    app: running,
    deps,
    url,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const mod of [...modules].reverse()) await mod.stop?.();
      await queue.stop();
      await running.close();
      store.close();
      removeServerInfo(config.libraryPath, process.pid);
    },
  };
}
```

`packages/server/src/main.ts`:

```ts
#!/usr/bin/env node
import { startServer } from './app.js';

try {
  const server = await startServer({ modules: () => [] });
  console.log(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(`manga server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

`packages/server/src/index.ts`:

```ts
export * from './app.js';
export * from './config.js';
export * from './domain/index.js';
export { ConflictError, HttpError, NotFoundError, StoreCorruptError, ValidationError, type ApiErrorCode } from './errors.js';
export * from './events/bus.js';
export { readImageMeta, sniffImageMime, type ImageMeta } from './files/image-meta.js';
export * from './jobs/index.js';
export { openStore } from './store/index.js';
export type * from './store/types.js';
export { defined, type Defined } from './util/defined.js';
export { VERSION } from './version.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/app.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 7: Type-check and try the real entry point**

Run: `npm run build`
Expected: exits 0. `packages/server/dist/main.js` exists.

Run (Git Bash):

```bash
export MANGA_LIBRARY="$(cygpath -w "$(mktemp -d)")"; export MANGA_PORT=4398
node packages/server/dist/main.js &
sleep 2; curl -s http://127.0.0.1:4398/api/health; echo; cat "$MANGA_LIBRARY/server.json"
kill %1; unset MANGA_LIBRARY MANGA_PORT
```

Expected: `{"ok":true,"pid":<n>,"version":"0.1.0"}`, then the `server.json` with `"port": 4398`.

- [ ] **Step 8: Commit**

```bash
git add packages/server
git commit -m "feat(server): compose the Fastify app with system routes, WebSocket events, SPA serving and startServer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: API — mangas, characters, images and image files

**Files:**
- Create: `packages/server/src/api/mangas.ts`, `packages/server/src/api/characters.ts`, `packages/server/src/api/images.ts`
- Modify: `packages/server/src/api/routes.ts`
- Test: `packages/server/test/api-mangas.test.ts`

**Interfaces:**
- Consumes: the domain services (`createManga`, `updateManga`, `deleteManga`, `createCoverPage`, `createCharacter`, `setCharacterRef`, `deleteCharacter`, `saveUploadedImage`, `deleteImage`), `defined`, `readUpload`, `emitEntity`, `sniffImageMime`.
- Produces these Contract B routes:
  - `GET/POST /api/mangas`, `GET/PATCH/DELETE /api/mangas/:id`, `POST /api/mangas/:id/cover`.
  - `GET/POST /api/mangas/:id/characters`, `GET/PATCH/DELETE /api/characters/:id`, `GET /api/characters/:id/images`.
  - `POST /api/characters/:id/refs/:slot` (`PickImage`).
  - `POST /api/characters/:id/upload?slot=` (multipart `file`, PNG/JPEG only; also sets `refs[slot]`).
  - `GET/DELETE /api/images/:id`.
  - `GET /files/images/:id.png`: the bytes with their sniffed content type, `cache-control: immutable`.
- Every mutation emits `entity` events: `manga`, `page`, `character`, `image`, and the image's owner.

- [ ] **Step 1: Write the failing test**

`packages/server/test/api-mangas.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, STYLE_PRESETS, type Character, type Image, type Manga, type PageDetail, type ServerEvent } from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { multipart } from './helpers/multipart.js';
import { makeJpegHeader, makePng } from './helpers/png.js';

type ErrorReply = { error: { code: string; message: string; details?: unknown } };

let t: TestApp;
let events: ServerEvent[];

beforeEach(async () => {
  t = await makeTestApp();
  events = [];
  t.deps.bus.on((e) => events.push(e));
});
afterEach(async () => {
  await t.close();
});

async function newManga(title = 'Oni'): Promise<Manga> {
  return (await call<Manga>(t.app, 'POST', '/api/mangas', { title })).body;
}
async function newCharacter(mangaId: string, name = 'Aiko'): Promise<Character> {
  return (await call<Character>(t.app, 'POST', `/api/mangas/${mangaId}/characters`, { name })).body;
}
function upload(url: string, filename: string, contentType: string, data: Buffer) {
  const form = multipart('file', filename, contentType, data);
  return t.app.inject({ method: 'POST', url, payload: form.payload, headers: form.headers });
}

describe('mangas', () => {
  it('creates with defaults, lists, reads, updates, and emits entity events', async () => {
    const created = await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Oni' });
    expect(created.status).toBe(200);
    const m = created.body;
    expect(m).toMatchObject({
      title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
      pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']?.styleGuide, coverPageId: null,
    });
    expect((await call<Manga[]>(t.app, 'GET', '/api/mangas')).body).toEqual([m]);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${m.id}`)).body).toEqual(m);
    expect((await call<Manga>(t.app, 'PATCH', `/api/mangas/${m.id}`, { title: 'Oni II', language: 'uk' })).body).toMatchObject({ title: 'Oni II', language: 'uk' });
    expect(events).toEqual([
      { type: 'entity', entity: 'manga', id: m.id, op: 'created', mangaId: m.id },
      { type: 'entity', entity: 'manga', id: m.id, op: 'updated', mangaId: m.id },
    ]);
  });

  it('rejects bad input with 400 validation and unknown ids with 404 not_found', async () => {
    const noTitle = await call<ErrorReply>(t.app, 'POST', '/api/mangas', {});
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error.code).toBe('validation');
    expect(noTitle.body.error.message).toMatch(/^title: /);
    expect((await call<ErrorReply>(t.app, 'POST', '/api/mangas', { title: 'X', stylePreset: 'nope' })).body.error.code).toBe('validation');
    const m = await newManga();
    expect((await call(t.app, 'PATCH', `/api/mangas/${m.id}`, { language: 'fr' })).status).toBe(400);
    expect(await call(t.app, 'GET', '/api/mangas/mg_missing000')).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'manga mg_missing000 not found' } } });
    expect((await call(t.app, 'DELETE', '/api/mangas/mg_missing000')).status).toBe(404);
  });

  it('creates the manga cover once', async () => {
    const m = await newManga();
    const first = await call<PageDetail>(t.app, 'POST', `/api/mangas/${m.id}/cover`);
    expect(first.body.page).toMatchObject({ kind: 'cover', chapterId: null, mangaId: m.id });
    expect(first.body.panels).toHaveLength(1);
    expect((await call<PageDetail>(t.app, 'POST', `/api/mangas/${m.id}/cover`)).body.page.id).toBe(first.body.page.id);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${m.id}`)).body.coverPageId).toBe(first.body.page.id);
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'page')).toHaveLength(1);
  });

  it('deletes a manga with everything under it and its image folder', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    expect((await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(8, 8))).statusCode).toBe(200);
    expect(existsSync(join(t.lib, 'mangas', m.id))).toBe(true);
    expect(await call(t.app, 'DELETE', `/api/mangas/${m.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/mangas/${m.id}`)).status).toBe(404);
    expect((await call(t.app, 'GET', `/api/characters/${c.id}`)).status).toBe(404);
    expect(existsSync(join(t.lib, 'mangas', m.id))).toBe(false);
  });
});

describe('characters', () => {
  it('creates with a random seed unless one is given, lists, updates and deletes', async () => {
    const m = await newManga();
    const a = await newCharacter(m.id);
    expect(a).toMatchObject({ name: 'Aiko', role: 'supporting', refs: {}, recipe: null, mangaId: m.id });
    expect(Number.isInteger(a.seed)).toBe(true);
    const b = (await call<Character>(t.app, 'POST', `/api/mangas/${m.id}/characters`, { name: 'Ren', seed: 42, role: 'main' })).body;
    expect(b).toMatchObject({ seed: 42, role: 'main' });
    expect((await call<Character[]>(t.app, 'GET', `/api/mangas/${m.id}/characters`)).body.map((c) => c.name)).toEqual(['Aiko', 'Ren']);
    expect((await call<Character>(t.app, 'PATCH', `/api/characters/${a.id}`, { appearanceTags: '1girl, red hair' })).body.appearanceTags).toBe('1girl, red hair');
    expect((await call(t.app, 'PATCH', `/api/characters/${a.id}`, { role: 'hero' })).status).toBe(400);
    expect((await call(t.app, 'GET', '/api/mangas/mg_missing000/characters')).status).toBe(404);
    expect(await call(t.app, 'DELETE', `/api/characters/${b.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/characters/${b.id}`)).status).toBe(404);
  });

  it('uploads a PNG into a ref slot, lists it, sets refs, and serves it under /files', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const png = makePng(64, 96);
    const res = await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'portrait.png', 'image/png', png);
    expect(res.statusCode).toBe(200);
    const image = res.json() as Image;
    expect(image).toMatchObject({
      ownerType: 'character', ownerId: c.id, role: 'portrait', width: 64, height: 96, source: 'uploaded',
      path: `mangas/${m.id}/images/${image.id}.png`, gen: null, review: null, parentImageId: null,
    });
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({ portrait: image.id });
    expect((await call<Image[]>(t.app, 'GET', `/api/characters/${c.id}/images`)).body.map((i) => i.id)).toEqual([image.id]);
    expect((await call<Image>(t.app, 'GET', `/api/images/${image.id}`)).body).toEqual(image);
    const file = await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(png)).toBe(true);
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'created', mangaId: m.id });
  });

  it('keeps an uploaded JPEG as-is and serves it as image/jpeg', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const jpeg = makeJpegHeader(300, 200);
    const image = (await upload(`/api/characters/${c.id}/upload?slot=side`, 'side.jpg', 'image/jpeg', jpeg)).json() as Image;
    expect([image.width, image.height, image.role]).toEqual([300, 200, 'side']);
    const file = await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` });
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.rawPayload.equals(jpeg)).toBe(true);
  });

  it('rejects uploads that are not PNG/JPEG or lack a slot or a file, writing nothing', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const base = `/api/characters/${c.id}/upload`;
    const cases: Array<[string, string, string, Buffer]> = [
      [`${base}?slot=portrait`, 'notes.png', 'image/png', Buffer.from('definitely not a png')],
      [`${base}?slot=portrait`, 'anim.gif', 'image/gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
      [`${base}?slot=face`, 'p.png', 'image/png', makePng(2, 2)],
      [base, 'p.png', 'image/png', makePng(2, 2)],
    ];
    for (const [url, name, type, data] of cases) {
      const res = await upload(url, name, type, data);
      expect(res.statusCode, `${url} ${name}`).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    }
    const json = await call<ErrorReply>(t.app, 'POST', `${base}?slot=portrait`, { file: 'x' });
    expect(json.status).toBe(400);
    expect(json.body.error.message).toMatch(/multipart/);
    expect(existsSync(join(t.lib, 'mangas'))).toBe(false);
    expect((await call<Image[]>(t.app, 'GET', `/api/characters/${c.id}/images`)).body).toEqual([]);
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({});
  });

  it("picks an owned image as a ref and refuses another character's image or an unknown slot", async () => {
    const m = await newManga();
    const a = await newCharacter(m.id);
    const b = await newCharacter(m.id, 'Ren');
    const image = (await upload(`/api/characters/${a.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(4, 4))).json() as Image;
    const picked = await call<Character>(t.app, 'POST', `/api/characters/${a.id}/refs/fullbody`, { imageId: image.id });
    expect(picked.body.refs).toEqual({ portrait: image.id, fullbody: image.id });
    expect((await call<ErrorReply>(t.app, 'POST', `/api/characters/${b.id}/refs/portrait`, { imageId: image.id })).body.error.code).toBe('validation');
    expect((await call(t.app, 'POST', `/api/characters/${a.id}/refs/face`, { imageId: image.id })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/characters/${a.id}/refs/portrait`, { imageId: 'im_missing000' })).status).toBe(404);
  });

  it('deletes an image, clearing the refs and the file', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const image = (await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(4, 4))).json() as Image;
    expect(await call(t.app, 'DELETE', `/api/images/${image.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({});
    expect(existsSync(join(t.lib, image.path))).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` })).statusCode).toBe(404);
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: c.id, op: 'updated', mangaId: m.id });
  });
});

describe('/files/images', () => {
  it('404s for unknown ids, other extensions and path tricks', async () => {
    for (const url of ['/files/images/im_missing000.png', '/files/images/im_missing000', '/files/images/..%2F..%2Flibrary.sqlite', '/files/images/..%2Fx.png']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/api-mangas.test.ts`
Expected: FAIL. `POST /api/mangas` returns 404 `not_found` (the route does not exist yet).

- [ ] **Step 3: Write the routes**

`packages/server/src/api/mangas.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { CreateMangaSchema, UpdateMangaSchema, type Manga, type PageDetail } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { createCoverPage, createManga, deleteManga, updateManga } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerMangaRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get('/api/mangas', async (): Promise<Manga[]> => store.mangas.list());

  app.post('/api/mangas', async (req): Promise<Manga> => {
    const manga = createManga(store, CreateMangaSchema.parse(req.body ?? {}));
    emitEntity(bus, 'manga', manga.id, 'created', manga.id);
    return manga;
  });

  app.get<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => store.mangas.require(req.params.id));

  app.patch<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => {
    const manga = updateManga(store, req.params.id, UpdateMangaSchema.parse(req.body ?? {}));
    emitEntity(bus, 'manga', manga.id, 'updated', manga.id);
    return manga;
  });

  app.delete<IdParams>('/api/mangas/:id', async (req) => {
    const manga = deleteManga(store, req.params.id);
    emitEntity(bus, 'manga', manga.id, 'deleted', manga.id);
    return OK;
  });

  app.post<IdParams>('/api/mangas/:id/cover', async (req): Promise<PageDetail> => {
    const before = store.mangas.require(req.params.id).coverPageId;
    const detail = createCoverPage(store, req.params.id, null);
    if (detail.page.id !== before) {
      emitEntity(bus, 'page', detail.page.id, 'created', detail.page.mangaId);
      emitEntity(bus, 'manga', detail.page.mangaId, 'updated', detail.page.mangaId);
    }
    return detail;
  });
}
```

`packages/server/src/api/characters.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateCharacterSchema, PickImageSchema, RefSlotSchema, UpdateCharacterSchema, type Character, type Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { createCharacter, deleteCharacter, saveUploadedImage, setCharacterRef } from '../domain/index.js';
import { defined } from '../util/defined.js';
import { emitEntity, OK, readUpload, type IdParams } from './util.js';

const SlotParams = z.object({ slot: RefSlotSchema });
const SlotQuery = z.object({ slot: RefSlotSchema });

export function registerCharacterRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/mangas/:id/characters', async (req): Promise<Character[]> => {
    store.mangas.require(req.params.id);
    return store.characters.listByManga(req.params.id);
  });

  app.post<IdParams>('/api/mangas/:id/characters', async (req): Promise<Character> => {
    const character = createCharacter(store, req.params.id, CreateCharacterSchema.parse(req.body ?? {}));
    emitEntity(bus, 'character', character.id, 'created', character.mangaId);
    return character;
  });

  app.get<IdParams>('/api/characters/:id', async (req): Promise<Character> => store.characters.require(req.params.id));

  app.patch<IdParams>('/api/characters/:id', async (req): Promise<Character> => {
    const character = store.characters.update(req.params.id, defined(UpdateCharacterSchema.parse(req.body ?? {})));
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return character;
  });

  app.delete<IdParams>('/api/characters/:id', async (req) => {
    const character = deleteCharacter(store, req.params.id);
    emitEntity(bus, 'character', character.id, 'deleted', character.mangaId);
    return OK;
  });

  app.get<IdParams>('/api/characters/:id/images', async (req): Promise<Image[]> => {
    store.characters.require(req.params.id);
    return store.images.listByOwner('character', req.params.id);
  });

  app.post<{ Params: { id: string; slot: string } }>('/api/characters/:id/refs/:slot', async (req): Promise<Character> => {
    const { slot } = SlotParams.parse(req.params);
    const { imageId } = PickImageSchema.parse(req.body ?? {});
    const character = setCharacterRef(store, req.params.id, slot, imageId);
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return character;
  });

  app.post<{ Params: { id: string }; Querystring: { slot?: string } }>('/api/characters/:id/upload', async (req): Promise<Image> => {
    const character = store.characters.require(req.params.id);
    const { slot } = SlotQuery.parse(req.query);
    const upload = await readUpload(req);
    const image = saveUploadedImage(store, {
      mangaId: character.mangaId, owner: { type: 'character', id: character.id }, role: slot, bytes: upload.bytes, mimetype: upload.mimetype,
    });
    setCharacterRef(store, character.id, slot, image.id);
    emitEntity(bus, 'image', image.id, 'created', image.mangaId);
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return image;
  });
}
```

`packages/server/src/api/images.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { deleteImage } from '../domain/index.js';
import { NotFoundError } from '../errors.js';
import { sniffImageMime } from '../files/image-meta.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerImageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/images/:id', async (req): Promise<Image> => store.images.require(req.params.id));

  /** Also clears the active/ref pointers that referenced it. */
  app.delete<IdParams>('/api/images/:id', async (req) => {
    const image = deleteImage(store, req.params.id);
    emitEntity(bus, 'image', image.id, 'deleted', image.mangaId);
    emitEntity(bus, image.ownerType, image.ownerId, 'updated', image.mangaId);
    return OK;
  });

  /** Image bytes by id. Uploaded JPEGs keep their bytes under the .png name, so the type is sniffed. */
  app.get<{ Params: { file: string } }>('/files/images/:file', async (req, reply) => {
    const { file } = req.params;
    if (!file.endsWith('.png')) throw new NotFoundError('image file', file);
    const image = store.images.require(file.slice(0, -'.png'.length));
    let bytes: Buffer;
    try {
      bytes = readFileSync(store.files.abs(image.path));
    } catch {
      throw new NotFoundError('image file', image.path);
    }
    return reply
      .type(sniffImageMime(bytes))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(bytes);
  });
}
```

Replace `packages/server/src/api/routes.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerCharacterRoutes } from './characters.js';
import { registerEventRoutes } from './events.js';
import { registerImageRoutes } from './images.js';
import { registerMangaRoutes } from './mangas.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMangaRoutes(app, deps);
  registerCharacterRoutes(app, deps);
  registerImageRoutes(app, deps);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/api-mangas.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add manga, character, image and image-file routes with multipart uploads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: API — chapters, pages, layout, panels and frames

**Files:**
- Create: `packages/server/src/api/chapters.ts`, `packages/server/src/api/pages.ts`, `packages/server/src/api/panels.ts`, `packages/server/src/api/frames.ts`
- Modify: `packages/server/src/api/routes.ts`
- Test: `packages/server/test/api-pages.test.ts`

**Interfaces:**
- Consumes: the domain services from Tasks 12–13.
- Produces these Contract B routes, plus `GET /api/frames/:id`:
  - `GET/POST /api/mangas/:id/chapters`, `GET/PATCH/DELETE /api/chapters/:id`, `POST /api/chapters/:id/cover`.
  - `GET/POST /api/chapters/:id/pages`: GET returns story pages only, ordered.
  - `POST /api/chapters/:id/pages/reorder`.
  - `GET/DELETE /api/pages/:id`.
  - `POST /api/pages/:id/layout/{preset,split,merge,resize}`: preset may answer 409 `needs_confirm` with details `{ removedPanelIds }`; merge of non-siblings answers 400 `validation`.
  - `POST /api/pages/:id/frames`.
  - `GET/PATCH /api/panels/:id`, `GET /api/panels/:id/images`, `POST /api/panels/:id/upload` (the image becomes active).
  - `GET/PATCH/DELETE /api/frames/:id`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/api-pages.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SCRIPT, panelIds, readingOrder,
  type Chapter, type Character, type Image, type Manga, type Page, type PageDetail, type Panel, type ServerEvent, type TextFrame,
} from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { multipart } from './helpers/multipart.js';
import { makePng } from './helpers/png.js';

type ErrorReply = { error: { code: string; message: string; details?: { removedPanelIds?: string[] } } };

let t: TestApp;
let events: ServerEvent[];

beforeEach(async () => {
  t = await makeTestApp();
  events = [];
  t.deps.bus.on((e) => events.push(e));
});
afterEach(async () => {
  await t.close();
});

async function seed(readingDirection: 'ltr' | 'rtl' = 'ltr'): Promise<{ manga: Manga; chapter: Chapter }> {
  const manga = (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Oni', readingDirection })).body;
  const chapter = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  return { manga, chapter };
}

async function addPage(chapterId: string, body: Record<string, unknown> = {}): Promise<PageDetail> {
  const r = await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapterId}/pages`, body);
  expect(r.status).toBe(200);
  return r.body;
}

function uploadTo(panelId: string, data: Buffer) {
  const form = multipart('file', 'art.png', 'image/png', data);
  return t.app.inject({ method: 'POST', url: `/api/panels/${panelId}/upload`, payload: form.payload, headers: form.headers });
}

describe('chapters', () => {
  it('numbers chapters 1, 2, … and lists, patches and deletes them', async () => {
    const { manga, chapter } = await seed();
    expect(chapter).toMatchObject({ number: 1, title: 'One', status: 'draft', order: 0, coverPageId: null, synopsis: '' });
    const two = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'Two' })).body;
    expect(two.number).toBe(2);
    expect((await call<Chapter[]>(t.app, 'GET', `/api/mangas/${manga.id}/chapters`)).body.map((c) => c.id)).toEqual([chapter.id, two.id]);
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${two.id}`, { title: 'Second', status: 'ready' })).body).toMatchObject({ title: 'Second', status: 'ready' });
    expect((await call(t.app, 'PATCH', `/api/chapters/${two.id}`, { status: 'done' })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, {})).status).toBe(400);
    expect(await call(t.app, 'DELETE', `/api/chapters/${two.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/chapters/${two.id}`)).status).toBe(404);
  });

  it('creates the chapter cover once, outside the page list', async () => {
    const { chapter } = await seed();
    const cover = await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`);
    expect(cover.body.page).toMatchObject({ kind: 'cover', chapterId: chapter.id });
    expect((await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`)).body.page.id).toBe(cover.body.page.id);
    expect((await call<Chapter>(t.app, 'GET', `/api/chapters/${chapter.id}`)).body.coverPageId).toBe(cover.body.page.id);
    expect((await call<Page[]>(t.app, 'GET', `/api/chapters/${chapter.id}/pages`)).body).toEqual([]);
  });
});

describe('pages', () => {
  it('adds pages with a preset (default 2x2) at an index and lists story pages in order', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    expect(a.panels).toHaveLength(4);
    const b = await addPage(chapter.id, { layoutPreset: 'splash', index: 0 });
    expect(b.panels).toHaveLength(1);
    expect((await call<Page[]>(t.app, 'GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => [p.id, p.order])).toEqual([[b.page.id, 0], [a.page.id, 1]]);
    expect(events).toContainEqual({ type: 'entity', entity: 'page', id: a.page.id, op: 'created', mangaId: a.page.mangaId });
    expect(await call(t.app, 'POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: 'nope' })).toMatchObject({ status: 400, body: { error: { code: 'validation' } } });
    expect((await call(t.app, 'POST', '/api/chapters/ch_missing000/pages', {})).status).toBe(404);
  });

  it('reorders pages and rejects an incomplete id list', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    const b = await addPage(chapter.id);
    const r = await call<Page[]>(t.app, 'POST', `/api/chapters/${chapter.id}/pages/reorder`, { ids: [b.page.id, a.page.id] });
    expect(r.body.map((p) => p.id)).toEqual([b.page.id, a.page.id]);
    expect((await call<ErrorReply>(t.app, 'POST', `/api/chapters/${chapter.id}/pages/reorder`, { ids: [a.page.id] })).body.error.code).toBe('validation');
  });

  it('GET returns the PageDetail and DELETE removes the page', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${a.page.id}`)).body).toEqual(a);
    expect(await call(t.app, 'DELETE', `/api/pages/${a.page.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/pages/${a.page.id}`)).status).toBe(404);
  });
});

describe('layout', () => {
  it('applies a preset, asking for confirmation before it removes panels', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const order = readingOrder(d.page.layout, 'ltr');
    const refused = await call<ErrorReply>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '2-rows' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'needs_confirm', details: { removedPanelIds: order.slice(2) } });
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.panels).toHaveLength(4);
    const applied = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '2-rows', confirm: true });
    expect(applied.status).toBe(200);
    expect(readingOrder(applied.body.page.layout, 'ltr')).toEqual(order.slice(0, 2));
    expect((await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '3-rows' })).body.panels).toHaveLength(3);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: 'nope' })).status).toBe(400);
  });

  it('splits, merges siblings only, and resizes with clamping', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: '2-rows' });
    const [top, bottom] = panelIds(d.page.layout) as [string, string];
    const split = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/split`, { panelId: top, dir: 'v' });
    expect(split.body.panels).toHaveLength(3);
    const added = panelIds(split.body.page.layout).find((id) => id !== top && id !== bottom) ?? '';
    expect(await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/merge`, { panelIdA: added, panelIdB: bottom })).toMatchObject({ status: 400, body: { error: { code: 'validation' } } });
    const merged = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/merge`, { panelIdA: top, panelIdB: added });
    expect(panelIds(merged.body.page.layout)).toEqual([top, bottom]);
    expect((await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: [], ratio: 0.99 })).body.page.layout).toMatchObject({ ratio: 0.92 });
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: ['a', 'a'], ratio: 0.5 })).status).toBe(404);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: ['x'], ratio: 0.5 })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: [], ratio: 1 })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/split`, { panelId: 'pn_missing000', dir: 'h' })).status).toBe(404);
    expect((await call(t.app, 'POST', '/api/pages/pg_missing000/layout/split', { panelId: top, dir: 'h' })).status).toBe(404);
  });
});

describe('panels', () => {
  it('reads and patches a panel, validating values, the active image and characters', async () => {
    const { manga, chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: '2-rows' });
    const [a, b] = panelIds(d.page.layout) as [string, string];
    const aiko = (await call<Character>(t.app, 'POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko' })).body;
    const script = {
      ...EMPTY_SCRIPT, action: 'Aiko bows',
      characters: [{ characterId: aiko.id, pose: 'bowing', expression: 'calm', position: 'center' }],
      dialogue: [{ speakerId: aiko.id, kind: 'speech', text: 'Welcome.' }],
    };
    const patched = await call<Panel>(t.app, 'PATCH', `/api/panels/${a}`, { script, seedLock: true, seed: 7, imageTransform: { x: 0.1, y: 0, scale: 1.5 } });
    expect(patched.body).toMatchObject({ script, seedLock: true, seed: 7, imageTransform: { x: 0.1, y: 0, scale: 1.5 } });
    expect((await call<Panel>(t.app, 'GET', `/api/panels/${a}`)).body).toEqual(patched.body);
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { imageTransform: { x: 0, y: 0, scale: 0.5 } })).status).toBe(400);
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { script: { ...EMPTY_SCRIPT, shot: 'sideways' } })).status).toBe(400);
    const other = (await uploadTo(b, makePng(4, 4))).json() as Image;
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { activeImageId: other.id })).status).toBe(400);
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: a, op: 'updated', mangaId: manga.id });
  });

  it('uploads panel images that become the active variant, and lists the variants', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: 'splash' });
    const panelId = d.panels[0]?.id ?? '';
    const first = (await uploadTo(panelId, makePng(10, 20))).json() as Image;
    const second = (await uploadTo(panelId, makePng(30, 40))).json() as Image;
    expect(second).toMatchObject({ ownerType: 'panel', ownerId: panelId, role: null, width: 30, height: 40 });
    expect((await call<Panel>(t.app, 'GET', `/api/panels/${panelId}`)).body.activeImageId).toBe(second.id);
    expect((await call<Image[]>(t.app, 'GET', `/api/panels/${panelId}/images`)).body.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(Object.keys((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.images)).toEqual([second.id]);
    expect((await call<Panel>(t.app, 'PATCH', `/api/panels/${panelId}`, { activeImageId: first.id })).body.activeImageId).toBe(first.id);
  });
});

describe('frames', () => {
  it('creates a frame with defaults, then reads, patches and deletes it', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const anchor = d.panels[0]?.id ?? '';
    const created = await call<TextFrame>(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'speech', text: 'Hi', panelId: anchor });
    expect(created.body).toMatchObject({ kind: 'speech', text: 'Hi', panelId: anchor, font: 'Shantell Sans', fontSize: 9, order: 0, autoFit: true, align: 'center', rotation: 0, tail: null });
    expect((await call<TextFrame>(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'sfx', text: 'BAM' })).body).toMatchObject({ font: 'Dela Gothic One', fontSize: 20, order: 1 });
    const id = created.body.id;
    expect((await call<TextFrame>(t.app, 'GET', `/api/frames/${id}`)).body).toEqual(created.body);
    const patched = await call<TextFrame>(t.app, 'PATCH', `/api/frames/${id}`, { text: 'Hello!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, tail: { x: 0.3, y: 0.4 } });
    expect(patched.body).toMatchObject({ text: 'Hello!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, tail: { x: 0.3, y: 0.4 } });
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.frames.map((f) => f.id)).toContain(id);
    expect(await call(t.app, 'DELETE', `/api/frames/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/frames/${id}`)).status).toBe(404);
  });

  it('rejects a title frame on a story page, a foreign anchor, a bad box and an unknown kind', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const other = await addPage(chapter.id);
    const post = (body: Record<string, unknown>) => call(t.app, 'POST', `/api/pages/${d.page.id}/frames`, body);
    expect((await post({ kind: 'title', text: 'ONI' })).status).toBe(400);
    expect((await post({ kind: 'speech', panelId: other.panels[0]?.id })).status).toBe(400);
    expect((await post({ kind: 'speech', box: { x: 0, y: 0, w: 0, h: 0.1 } })).status).toBe(400);
    expect((await post({ kind: 'caption' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/api-pages.test.ts`
Expected: FAIL. `POST /api/mangas/:id/chapters` returns 404.

- [ ] **Step 3: Write the routes**

`packages/server/src/api/chapters.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { CreateChapterSchema, CreatePageSchema, ReorderSchema, UpdateChapterSchema, type Chapter, type Page, type PageDetail } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { chapterPages, createChapter, createCoverPage, createPage, deleteChapter, reorderPages } from '../domain/index.js';
import { defined } from '../util/defined.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerChapterRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/mangas/:id/chapters', async (req): Promise<Chapter[]> => {
    store.mangas.require(req.params.id);
    return store.chapters.listByManga(req.params.id);
  });

  app.post<IdParams>('/api/mangas/:id/chapters', async (req): Promise<Chapter> => {
    const chapter = createChapter(store, req.params.id, CreateChapterSchema.parse(req.body ?? {}));
    emitEntity(bus, 'chapter', chapter.id, 'created', chapter.mangaId);
    return chapter;
  });

  app.get<IdParams>('/api/chapters/:id', async (req): Promise<Chapter> => store.chapters.require(req.params.id));

  app.patch<IdParams>('/api/chapters/:id', async (req): Promise<Chapter> => {
    const chapter = store.chapters.update(req.params.id, defined(UpdateChapterSchema.parse(req.body ?? {})));
    emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    return chapter;
  });

  app.delete<IdParams>('/api/chapters/:id', async (req) => {
    const chapter = deleteChapter(store, req.params.id);
    emitEntity(bus, 'chapter', chapter.id, 'deleted', chapter.mangaId);
    return OK;
  });

  app.post<IdParams>('/api/chapters/:id/cover', async (req): Promise<PageDetail> => {
    const chapter = store.chapters.require(req.params.id);
    const detail = createCoverPage(store, chapter.mangaId, chapter.id);
    if (detail.page.id !== chapter.coverPageId) {
      emitEntity(bus, 'page', detail.page.id, 'created', chapter.mangaId);
      emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    }
    return detail;
  });

  /** Story pages only (kind 'page'), ordered. */
  app.get<IdParams>('/api/chapters/:id/pages', async (req): Promise<Page[]> => {
    store.chapters.require(req.params.id);
    return chapterPages(store, req.params.id);
  });

  app.post<IdParams>('/api/chapters/:id/pages', async (req): Promise<PageDetail> => {
    const body = CreatePageSchema.parse(req.body ?? {});
    const detail = createPage(store, req.params.id, body.layoutPreset, body.index);
    emitEntity(bus, 'page', detail.page.id, 'created', detail.page.mangaId);
    return detail;
  });

  app.post<IdParams>('/api/chapters/:id/pages/reorder', async (req): Promise<Page[]> => {
    const { ids } = ReorderSchema.parse(req.body ?? {});
    const pages = reorderPages(store, req.params.id, ids);
    const chapter = store.chapters.require(req.params.id);
    emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    return pages;
  });
}
```

`packages/server/src/api/pages.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ApplyPresetSchema, CreateFrameSchema, MergeSchema, ResizeSchema, SplitSchema, type PageDetail, type TextFrame } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { applyPreset, createFrame, deletePage, mergePagePanels, pageDetail, resizePageSplit, splitPagePanel } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerPageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  const changed = (detail: PageDetail): PageDetail => {
    emitEntity(bus, 'page', detail.page.id, 'updated', detail.page.mangaId);
    return detail;
  };

  app.get<IdParams>('/api/pages/:id', async (req): Promise<PageDetail> => pageDetail(store, req.params.id));

  app.delete<IdParams>('/api/pages/:id', async (req) => {
    const page = deletePage(store, req.params.id);
    emitEntity(bus, 'page', page.id, 'deleted', page.mangaId);
    return OK;
  });

  /** 409 needs_confirm (details { removedPanelIds }) when the preset has fewer panels and confirm is false. */
  app.post<IdParams>('/api/pages/:id/layout/preset', async (req): Promise<PageDetail> => {
    const { preset, confirm } = ApplyPresetSchema.parse(req.body ?? {});
    return changed(applyPreset(store, req.params.id, preset, confirm));
  });

  app.post<IdParams>('/api/pages/:id/layout/split', async (req): Promise<PageDetail> => {
    const { panelId, dir } = SplitSchema.parse(req.body ?? {});
    return changed(splitPagePanel(store, req.params.id, panelId, dir));
  });

  app.post<IdParams>('/api/pages/:id/layout/merge', async (req): Promise<PageDetail> => {
    const { panelIdA, panelIdB } = MergeSchema.parse(req.body ?? {});
    return changed(mergePagePanels(store, req.params.id, panelIdA, panelIdB));
  });

  app.post<IdParams>('/api/pages/:id/layout/resize', async (req): Promise<PageDetail> => {
    const { path, ratio } = ResizeSchema.parse(req.body ?? {});
    return changed(resizePageSplit(store, req.params.id, path, ratio));
  });

  app.post<IdParams>('/api/pages/:id/frames', async (req): Promise<TextFrame> => {
    const frame = createFrame(store, req.params.id, CreateFrameSchema.parse(req.body ?? {}));
    emitEntity(bus, 'textFrame', frame.id, 'created', store.pages.require(frame.pageId).mangaId);
    return frame;
  });
}
```

`packages/server/src/api/panels.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { UpdatePanelSchema, type Image, type Panel } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { saveUploadedImage, updatePanel } from '../domain/index.js';
import { emitEntity, readUpload, type IdParams } from './util.js';

export function registerPanelRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  const mangaOf = (pageId: string): string => store.pages.require(pageId).mangaId;

  app.get<IdParams>('/api/panels/:id', async (req): Promise<Panel> => store.panels.require(req.params.id));

  app.patch<IdParams>('/api/panels/:id', async (req): Promise<Panel> => {
    const panel = updatePanel(store, req.params.id, UpdatePanelSchema.parse(req.body ?? {}));
    emitEntity(bus, 'panel', panel.id, 'updated', mangaOf(panel.pageId));
    return panel;
  });

  app.get<IdParams>('/api/panels/:id/images', async (req): Promise<Image[]> => {
    store.panels.require(req.params.id);
    return store.images.listByOwner('panel', req.params.id);
  });

  /** The uploaded image becomes the panel's active variant. */
  app.post<IdParams>('/api/panels/:id/upload', async (req): Promise<Image> => {
    const panel = store.panels.require(req.params.id);
    const mangaId = mangaOf(panel.pageId);
    const upload = await readUpload(req);
    const image = saveUploadedImage(store, { mangaId, owner: { type: 'panel', id: panel.id }, role: null, bytes: upload.bytes, mimetype: upload.mimetype });
    store.panels.update(panel.id, { activeImageId: image.id });
    emitEntity(bus, 'image', image.id, 'created', mangaId);
    emitEntity(bus, 'panel', panel.id, 'updated', mangaId);
    return image;
  });
}
```

`packages/server/src/api/frames.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { UpdateFrameSchema, type TextFrame } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { updateFrame } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerFrameRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  const mangaOf = (pageId: string): string => store.pages.require(pageId).mangaId;

  app.get<IdParams>('/api/frames/:id', async (req): Promise<TextFrame> => store.frames.require(req.params.id));

  app.patch<IdParams>('/api/frames/:id', async (req): Promise<TextFrame> => {
    const frame = updateFrame(store, req.params.id, UpdateFrameSchema.parse(req.body ?? {}));
    emitEntity(bus, 'textFrame', frame.id, 'updated', mangaOf(frame.pageId));
    return frame;
  });

  app.delete<IdParams>('/api/frames/:id', async (req) => {
    const frame = store.frames.require(req.params.id);
    store.frames.delete(frame.id);
    emitEntity(bus, 'textFrame', frame.id, 'deleted', mangaOf(frame.pageId));
    return OK;
  });
}
```

Replace `packages/server/src/api/routes.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerChapterRoutes } from './chapters.js';
import { registerCharacterRoutes } from './characters.js';
import { registerEventRoutes } from './events.js';
import { registerFrameRoutes } from './frames.js';
import { registerImageRoutes } from './images.js';
import { registerMangaRoutes } from './mangas.js';
import { registerPageRoutes } from './pages.js';
import { registerPanelRoutes } from './panels.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMangaRoutes(app, deps);
  registerCharacterRoutes(app, deps);
  registerImageRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerPanelRoutes(app, deps);
  registerFrameRoutes(app, deps);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/api-pages.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add chapter, page, layout, panel and text-frame routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: API — jobs

**Files:**
- Create: `packages/server/src/api/jobs.ts`
- Modify: `packages/server/src/api/routes.ts`
- Test: `packages/server/test/api-jobs.test.ts`

**Interfaces:**
- Consumes: `store.jobs.list/require`, `queue.cancel`.
- Produces: `GET /api/jobs?status=&limit=` (newest first, default limit 50, max 500, validated), `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` → `Job`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/api-jobs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, ServerEvent } from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('jobs', () => {
  it('lists newest first, filters by status, applies the limit and validates the query', async () => {
    const q = t.deps.queue;
    const a = q.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { n: 1 } });
    const b = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: { n: 2 } });
    const c = q.enqueue({ kind: 'export.render', lane: 'cpu', payload: { n: 3 } });
    q.cancel(b.id);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs')).body.map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs?status=cancelled')).body.map((j) => j.id)).toEqual([b.id]);
    expect((await call<Job[]>(t.app, 'GET', '/api/jobs?status=queued&limit=1')).body.map((j) => j.id)).toEqual([c.id]);
    for (const url of ['/api/jobs?status=bogus', '/api/jobs?limit=0', '/api/jobs?limit=abc', '/api/jobs?limit=501']) {
      expect((await call(t.app, 'GET', url)).status, url).toBe(400);
    }
  });

  it('reads one job and 404s an unknown one', async () => {
    const job = t.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    expect((await call<Job>(t.app, 'GET', `/api/jobs/${job.id}`)).body).toEqual(job);
    expect((await call(t.app, 'GET', '/api/jobs/jb_missing000')).status).toBe(404);
    expect((await call(t.app, 'POST', '/api/jobs/jb_missing000/cancel')).status).toBe(404);
  });

  it('cancels a queued job, publishes the change, and is idempotent', async () => {
    const events: ServerEvent[] = [];
    t.deps.bus.on((e) => events.push(e));
    const job = t.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    expect((await call<Job>(t.app, 'POST', `/api/jobs/${job.id}/cancel`)).body).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(events.some((e) => e.type === 'job' && e.job.id === job.id && e.job.status === 'cancelled')).toBe(true);
    expect((await call<Job>(t.app, 'POST', `/api/jobs/${job.id}/cancel`)).body.status).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/api-jobs.test.ts`
Expected: FAIL. `GET /api/jobs` returns 404.

- [ ] **Step 3: Write the routes**

`packages/server/src/api/jobs.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JobStatusSchema, type Job } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import type { IdParams } from './util.js';

const JobListQuery = z.object({
  status: JobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export function registerJobRoutes(app: FastifyInstance, { store, queue }: CoreDeps): void {
  /** Newest first. */
  app.get('/api/jobs', async (req): Promise<Job[]> => {
    const query = JobListQuery.parse(req.query ?? {});
    return store.jobs.list({ ...(query.status === undefined ? {} : { status: query.status }), limit: query.limit });
  });

  app.get<IdParams>('/api/jobs/:id', async (req): Promise<Job> => store.jobs.require(req.params.id));

  app.post<IdParams>('/api/jobs/:id/cancel', async (req): Promise<Job> => queue.cancel(req.params.id));
}
```

Replace `packages/server/src/api/routes.ts` with its final M1 version:

```ts
import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerChapterRoutes } from './chapters.js';
import { registerCharacterRoutes } from './characters.js';
import { registerEventRoutes } from './events.js';
import { registerFrameRoutes } from './frames.js';
import { registerImageRoutes } from './images.js';
import { registerJobRoutes } from './jobs.js';
import { registerMangaRoutes } from './mangas.js';
import { registerPageRoutes } from './pages.js';
import { registerPanelRoutes } from './panels.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMangaRoutes(app, deps);
  registerCharacterRoutes(app, deps);
  registerImageRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerPanelRoutes(app, deps);
  registerFrameRoutes(app, deps);
  registerJobRoutes(app, deps);
}
```

- [ ] **Step 4: Run the whole server suite**

Run: `npx vitest run packages/server`
Expected: PASS. Every server test file passes.

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add job list, read and cancel routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 18: CLI foundation — client, resolver, context, auto-start, job waiting, program

**Files:**
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/version.ts`, `packages/cli/src/io.ts`, `packages/cli/src/errors.ts`, `packages/cli/src/args.ts`, `packages/cli/src/format.ts`, `packages/cli/src/client.ts`, `packages/cli/src/resolver.ts`, `packages/cli/src/autostart.ts`, `packages/cli/src/wait.ts`, `packages/cli/src/context.ts`, `packages/cli/src/program.ts`, `packages/cli/src/index.ts`
- Create: `packages/cli/test/helpers.ts`
- Modify: `tsconfig.json` (add the cli reference)
- Test: `packages/cli/test/client.test.ts`, `packages/cli/test/autostart.test.ts`, `packages/cli/test/context.test.ts`

**Interfaces:**
- Consumes:
  - `@manga/shared` types.
  - `loadConfig` and `readServerInfo` from `@manga/server/config`. This subpath does not load SQLite.
  - In tests, `startServer` from `@manga/server`.
- Produces (contract D):
  - `class ApiError extends Error { status; code; details? }`. Status 0 with code `unreachable` means no server; code `file` means an upload file could not be read.
  - `class ApiClient { get; post; patch; put; delete; upload }`.
  - `interface Resolver { manga; character; chapter; page; panel; frame }` and `createResolver(api)`.
    - A manga is an id or a unique case-insensitive title.
    - A character is an id or a unique case-insensitive name, optionally within a manga.
    - A chapter is an id or `<manga>/<number>`.
    - Failures throw `CliError` (exit 1; a malformed chapter reference exits 2).
  - `interface CliContext { api; json; wait; baseUrl; io; out(data, human); waitJobs(ids); resolve }` and `createContext({ json, wait, url, io })`.
  - `interface CliIo { stdout; stderr; signal? }`, `processIo`, `onInterrupt(signal, fn): dispose`.
  - `class CliError extends Error { exitCode: 1 | 2; silent }`.
  - `probeHealth(url)`, `serverEntry()`, `serverLogPath(lib)`, `spawnServerDetached(lib)`.
  - `ensureServer({ url?, config?, deps?, timeoutMs? }): Promise<string>` and `interface EnsureDeps`, `START_TIMEOUT_MS = 30_000`:
    - An explicit `url` is probed only, and is never auto-started.
    - Otherwise it probes the `server.json` port and the configured port.
    - If neither answers, it spawns `node <@manga/server/main>` detached with `windowsHide`, logging to `<library>/logs/server.log`, then polls the configured port for 30 s.
  - `waitForJobs({ baseUrl, api, ids, io, json })`: over WebSocket. After `hello` it catches up with `GET /api/jobs/:id`. Progress lines `"<jobId> <label> <value>/<max>"` go to stderr unless `--json`.
  - `streamJobs({ baseUrl, io, onReady, onJob })`, `progressText(job)`, `isTerminalJob(job)`.
  - `table(rows, header?)`, `fixed(n)`.
  - Option parsers `parseNonNegativeInt`, `parseNumber`, `parsePositiveNumber`, `parseBox`, `parseList`, `collect`.
  - `buildProgram(io?, factory?)`, `runCli(argv, io?, factory?): Promise<number>`, `exitCodeFor(err, io)`, `interface GlobalOptions`, `type ContextFactory`.
  - Exit codes: 0 success; 1 API or other errors, with `error: <message>` on stderr; 2 usage errors.

- [ ] **Step 1: Create the CLI tsconfig, the project reference and the test harness**

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }, { "path": "../server" }]
}
```

Replace `tsconfig.json` (repo root) with its final M1 content:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/server" },
    { "path": "./packages/cli" }
  ]
}
```

`packages/cli/test/helpers.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '@manga/server';
import { runCli } from '../src/program.js';

export { makePng } from '../../server/test/helpers/png.js';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface Started { result: Promise<RunResult>; output(): string }
export interface Harness {
  url: string;
  lib: string;
  server: RunningServer;
  /** `manga --url <server> …args`, capturing stdout/stderr. */
  run(...args: string[]): Promise<RunResult>;
  /** Same with --json; throws unless the exit code is 0; returns the parsed stdout. */
  json<T>(...args: string[]): Promise<T>;
  /** Starts a long-running command (serve, jobs --watch) that ends when `signal` aborts. */
  start(args: string[], signal: AbortSignal): Started;
  close(): Promise<void>;
}

/** An in-process server on a random port over a temp library, and a runner for the real commander program. */
export async function startHarness(): Promise<Harness> {
  const lib = mkdtempSync(join(tmpdir(), 'manga-cli-'));
  const server = await startServer({ config: { libraryPath: lib, port: 0 }, uiDir: null });
  const exec = (args: string[], signal?: AbortSignal): Started => {
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (s: string) => {
        stdout += s;
      },
      stderr: (s: string) => {
        stderr += s;
      },
      ...(signal ? { signal } : {}),
    };
    const result = runCli(['--url', server.url, ...args], io).then((code) => ({ code, stdout, stderr }));
    return { result, output: () => stdout };
  };
  return {
    url: server.url,
    lib,
    server,
    run: (...args) => exec(args).result,
    async json<T>(...args: string[]): Promise<T> {
      const r = await exec(['--json', ...args]).result;
      if (r.code !== 0) throw new Error(`manga ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout) as T;
    },
    start: (args, signal) => exec(args, signal),
    async close() {
      await server.stop();
      rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/client.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readingOrder, type Chapter, type Character, type Image, type Manga, type PageDetail, type Settings } from '@manga/shared';
import { ApiClient, ApiError } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('ApiClient', () => {
  it('returns parsed JSON and raises ApiError with the server code, message and details', async () => {
    const api = new ApiClient(h.url);
    expect((await api.get<{ ok: boolean }>('/api/health')).ok).toBe(true);
    const manga = await api.post<Manga>('/api/mangas', { title: 'Client Test', readingDirection: 'ltr' });
    const chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title: 'One' });
    const page = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: '2x2' });
    await expect(api.post(`/api/pages/${page.page.id}/layout/preset`, { preset: 'splash' })).rejects.toMatchObject({
      name: 'ApiError', status: 409, code: 'needs_confirm', details: { removedPanelIds: readingOrder(page.page.layout, 'ltr').slice(1) },
    });
    await expect(api.get('/api/mangas/mg_missing000')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'manga mg_missing000 not found' });
    expect((await api.patch<Settings>('/api/settings', { review: { rounds: 1 } })).review.rounds).toBe(1);
    expect(await api.delete(`/api/mangas/${manga.id}`)).toEqual({ ok: true });
    await expect(api.put('/api/nope', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('uploads a file as multipart with the content type of its extension', async () => {
    const api = new ApiClient(h.url);
    const manga = await api.post<Manga>('/api/mangas', { title: 'Upload Test' });
    const character = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Aiko' });
    const file = join(h.lib, 'portrait.png');
    writeFileSync(file, makePng(12, 16));
    const image = await api.upload<Image>(`/api/characters/${character.id}/upload?slot=portrait`, file);
    expect([image.width, image.height, image.role]).toEqual([12, 16, 'portrait']);
    await expect(api.upload(`/api/characters/${character.id}/upload?slot=portrait`, join(h.lib, 'missing.png'))).rejects.toMatchObject({ code: 'file' });
  });

  it('reports an unreachable server', async () => {
    await expect(new ApiClient('http://127.0.0.1:9').get('/api/health')).rejects.toMatchObject({
      code: 'unreachable', message: 'server not reachable at http://127.0.0.1:9',
    });
  });
});
```

`packages/cli/test/autostart.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigSchema, type AppConfig } from '@manga/shared';
import { writeServerInfo } from '@manga/server/config';
import { ensureServer, probeHealth, type EnsureDeps } from '../src/autostart.js';
import { CliError } from '../src/errors.js';
import { startHarness } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function library(): string {
  const d = mkdtempSync(join(tmpdir(), 'manga-auto-'));
  dirs.push(d);
  return d;
}
const config = (libraryPath: string, port = 4317): AppConfig => AppConfigSchema.parse({ libraryPath, port });

/** A fake world: a clock advanced by sleep, a probe answering per URL, and a spawn that may bring the server up. */
function fakeDeps(opts: { healthy?: (url: string) => boolean; upAfterSpawn?: boolean } = {}) {
  let clock = 0;
  let up = false;
  const probes: string[] = [];
  const spawned: string[] = [];
  const deps: EnsureDeps = {
    probe: async (url) => {
      probes.push(url);
      return up || (opts.healthy?.(url) ?? false);
    },
    spawnServer: (lib) => {
      spawned.push(lib);
      if (opts.upAfterSpawn) up = true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, probes, spawned };
}

describe('ensureServer', () => {
  it('uses the server recorded in server.json without spawning', async () => {
    const lib = library();
    writeServerInfo(lib, { pid: 1, port: 5555, startedAt: 'x' });
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:5555' });
    expect(await ensureServer({ config: config(lib), deps: f.deps })).toBe('http://127.0.0.1:5555');
    expect(f.spawned).toEqual([]);
  });

  it('uses the configured port when server.json is missing', async () => {
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:4317' });
    expect(await ensureServer({ config: config(library()), deps: f.deps })).toBe('http://127.0.0.1:4317');
    expect(f.spawned).toEqual([]);
  });

  it('spawns the server when nothing answers, then uses the configured port rather than a stale server.json', async () => {
    const lib = library();
    writeServerInfo(lib, { pid: 1, port: 5555, startedAt: 'x' });
    const f = fakeDeps({ upAfterSpawn: true });
    expect(await ensureServer({ config: config(lib, 4999), deps: f.deps })).toBe('http://127.0.0.1:4999');
    expect(f.spawned).toEqual([lib]);
    expect(f.probes.slice(0, 2)).toEqual(['http://127.0.0.1:5555', 'http://127.0.0.1:4999']);
  });

  it('gives up after 30 s and points at the server log', async () => {
    const f = fakeDeps();
    const err = await ensureServer({ config: config(library()), deps: f.deps }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/did not answer at http:\/\/127\.0\.0\.1:4317 within 30 s; see .*server\.log$/);
    expect(f.spawned).toHaveLength(1);
  });

  it('never spawns for an explicit --url', async () => {
    const f = fakeDeps();
    await expect(ensureServer({ url: 'http://127.0.0.1:7777/', deps: f.deps })).rejects.toThrow('server not reachable at http://127.0.0.1:7777');
    expect(f.spawned).toEqual([]);
  });
});

describe('probeHealth', () => {
  it('is true only for a live manga server', async () => {
    const h = await startHarness();
    try {
      expect(await probeHealth(h.url)).toBe(true);
      expect(await probeHealth('http://127.0.0.1:9')).toBe(false);
    } finally {
      await h.close();
    }
  });
});
```

`packages/cli/test/context.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chapter, Character, Manga } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { createContext } from '../src/context.js';
import { CliError } from '../src/errors.js';
import { createResolver } from '../src/resolver.js';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const silent = { stdout: () => {}, stderr: () => {} };

describe('resolver', () => {
  it('resolves mangas by id or case-insensitive title and refuses ambiguous titles', async () => {
    const api = new ApiClient(h.url);
    const r = createResolver(api);
    const a = await api.post<Manga>('/api/mangas', { title: 'Night Market' });
    expect((await r.manga(a.id)).id).toBe(a.id);
    expect((await r.manga('night market')).id).toBe(a.id);
    await expect(r.manga('Nope')).rejects.toThrow('no manga matches "Nope"');
    await api.post('/api/mangas', { title: 'NIGHT MARKET' });
    await expect(r.manga('Night Market')).rejects.toThrow('"Night Market" matches 2 mangas; use the id');
    await expect(r.manga('mg_missing000')).rejects.toMatchObject({ status: 404 });
  });

  it('resolves characters within a manga, and chapters by id or <manga>/<number>', async () => {
    const api = new ApiClient(h.url);
    const r = createResolver(api);
    const m = await api.post<Manga>('/api/mangas', { title: 'Oni Tales' });
    const other = await api.post<Manga>('/api/mangas', { title: 'Other Tales' });
    const aiko = await api.post<Character>(`/api/mangas/${m.id}/characters`, { name: 'Aiko' });
    await api.post(`/api/mangas/${other.id}/characters`, { name: 'Aiko' });
    expect((await r.character('aiko', 'oni tales')).id).toBe(aiko.id);
    expect((await r.character(aiko.id)).id).toBe(aiko.id);
    await expect(r.character('Aiko')).rejects.toThrow(/matches 2 characters/);
    const chapter = await api.post<Chapter>(`/api/mangas/${m.id}/chapters`, { title: 'One' });
    expect((await r.chapter('Oni Tales/1')).id).toBe(chapter.id);
    expect((await r.chapter(chapter.id)).id).toBe(chapter.id);
    await expect(r.chapter('Oni Tales/9')).rejects.toThrow('no chapter matches "Oni Tales/9"');
    const bad = await r.chapter('garbage').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(CliError);
    expect((bad as CliError).exitCode).toBe(2);
  });
});

describe('createContext', () => {
  it('prints JSON with --json and the human text otherwise', async () => {
    const lines: string[] = [];
    const io = {
      stdout: (s: string) => {
        lines.push(s);
      },
      stderr: () => {},
    };
    const human = await createContext({ json: false, wait: false, url: h.url, io });
    human.out({ a: 1 }, () => 'human');
    const json = await createContext({ json: true, wait: false, url: h.url, io });
    json.out({ a: 1 }, () => 'human');
    expect(lines).toEqual(['human\n', '{\n  "a": 1\n}\n']);
    expect(human.baseUrl).toBe(h.url);
  });

  it('waitJobs streams progress to stderr and resolves once every job is terminal, including already-finished ones', async () => {
    const queue = h.server.deps.queue;
    queue.register('export.render', async (ctx) => {
      ctx.progress('Rendering page', 1, 2);
      await new Promise((r) => setTimeout(r, 30));
      ctx.progress('Rendering page', 2, 2);
      return { files: [] };
    });
    const early = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    await queue.waitFor(early.id);
    const errors: string[] = [];
    const c = await createContext({
      json: false, wait: true, url: h.url,
      io: {
        stdout: () => {},
        stderr: (s) => {
          errors.push(s);
        },
      },
    });
    const live = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    const jobs = await c.waitJobs([early.id, live.id]);
    expect(jobs.map((j) => [j.id, j.status])).toEqual([[early.id, 'succeeded'], [live.id, 'succeeded']]);
    expect(errors.join('')).toContain(`${live.id} Rendering page 2/2`);
    expect(await c.waitJobs([])).toEqual([]);
    const quiet = await createContext({ json: true, wait: true, url: h.url, io: silent });
    const third = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    expect((await quiet.waitJobs([third.id]))[0]?.status).toBe('succeeded');
  });
});

describe('runCli', () => {
  it('exits 0 for --help and --version and 2 for an unknown option', async () => {
    const help = await h.run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: manga');
    expect(await h.run('--version')).toMatchObject({ code: 0, stdout: '0.1.0\n' });
    const bad = await h.run('--bogus');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown option/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/cli`
Expected: FAIL. `../src/program.js` (imported by `helpers.ts`) cannot be found.

- [ ] **Step 4: Write the small building blocks**

`packages/cli/src/version.ts`:

```ts
import { readFileSync } from 'node:fs';

export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
```

`packages/cli/src/io.ts`:

```ts
/** Where the CLI writes. Tests inject their own; `signal` ends long-running commands (serve, jobs --watch). */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

export const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Calls `fn` once on Ctrl+C, SIGTERM, or when `signal` aborts. Returns a disposer that removes the listeners. */
export function onInterrupt(signal: AbortSignal | undefined, fn: () => void): () => void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    dispose();
    fn();
  };
  const dispose = (): void => {
    process.off('SIGINT', fire);
    process.off('SIGTERM', fire);
    signal?.removeEventListener('abort', fire);
  };
  process.on('SIGINT', fire);
  process.on('SIGTERM', fire);
  if (signal?.aborted) queueMicrotask(fire);
  else signal?.addEventListener('abort', fire);
  return dispose;
}
```

`packages/cli/src/errors.ts`:

```ts
/** A CLI-level failure, printed as "error: <message>" (unless silent). Exit code 1 = failure, 2 = usage. */
export class CliError extends Error {
  constructor(message: string, public readonly exitCode: 1 | 2 = 1, public readonly silent = false) {
    super(message);
    this.name = 'CliError';
  }
}
```

`packages/cli/src/args.ts`:

```ts
import { InvalidArgumentError } from 'commander';

export function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a whole number >= 0');
  return n;
}

export function parseNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new InvalidArgumentError('expected a number');
  return n;
}

export function parsePositiveNumber(value: string): number {
  const n = parseNumber(value);
  if (n <= 0) throw new InvalidArgumentError('expected a number > 0');
  return n;
}

/** "x,y,w,h" in page-normalized units. */
export function parseBox(value: string): { x: number; y: number; w: number; h: number } {
  const parts = value.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new InvalidArgumentError('expected x,y,w,h as four numbers, e.g. 0.1,0.1,0.3,0.12');
  }
  const [x = 0, y = 0, w = 0, h = 0] = parts;
  return { x, y, w, h };
}

export function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Repeatable option: --line a --line b → ['a', 'b']. */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
```

`packages/cli/src/format.ts`:

```ts
/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all = header ? [header, ...rows] : [...rows];
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return all.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ')).join('\n');
}

/** At most `digits` decimals, without trailing zeros: 0.920 → "0.92". */
export function fixed(n: number, digits = 3): string {
  return String(Number(n.toFixed(digits)));
}
```

- [ ] **Step 5: Write the API client and the resolver**

`packages/cli/src/client.ts`:

```ts
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ApiErrorBody } from '@manga/shared';

/** status 0 = no HTTP response: code 'unreachable' (no server) or 'file' (upload file unreadable). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.json<T>('DELETE', path);
  }

  /** multipart/form-data with the file in field `file`; content type from the extension. */
  async upload<T>(path: string, filePath: string): Promise<T> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      throw new ApiError(0, 'file', `cannot read ${filePath}`);
    }
    const form = new FormData();
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), basename(filePath));
    return this.send<T>('POST', path, { body: form });
  }

  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  private async send<T>(method: string, path: string, init: { body?: RequestInit['body']; headers?: Record<string, string> }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, ...init });
    } catch {
      throw new ApiError(0, 'unreachable', `server not reachable at ${this.baseUrl}`);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const error = (data as Partial<ApiErrorBody> | null)?.error;
      throw new ApiError(res.status, error?.code ?? `http_${res.status}`, error?.message ?? `${method} ${path} failed with HTTP ${res.status}`, error?.details);
    }
    return data as T;
  }
}
```

`packages/cli/src/resolver.ts`:

```ts
import type { Chapter, Character, Manga, PageDetail, Panel, TextFrame } from '@manga/shared';
import type { ApiClient } from './client.js';
import { CliError } from './errors.js';

export interface Resolver {
  manga(ref: string): Promise<Manga>;                          // id, or unique case-insensitive title
  character(ref: string, mangaRef?: string): Promise<Character>;
  chapter(ref: string): Promise<Chapter>;                      // id, or '<mangaRef>/<number>'
  page(id: string): Promise<PageDetail>; panel(id: string): Promise<Panel>; frame(id: string): Promise<TextFrame>;
}

function pickOne<T>(matches: T[], what: string, ref: string): T {
  const [only, ...rest] = matches;
  if (only === undefined) throw new CliError(`no ${what} matches "${ref}"`);
  if (rest.length > 0) throw new CliError(`"${ref}" matches ${matches.length} ${what}s; use the id`);
  return only;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const enc = encodeURIComponent;

export function createResolver(api: ApiClient): Resolver {
  const resolver: Resolver = {
    async manga(ref) {
      if (ref.startsWith('mg_')) return api.get<Manga>(`/api/mangas/${enc(ref)}`);
      const all = await api.get<Manga[]>('/api/mangas');
      return pickOne(all.filter((m) => same(m.title, ref)), 'manga', ref);
    },

    async character(ref, mangaRef) {
      if (ref.startsWith('cr_')) return api.get<Character>(`/api/characters/${enc(ref)}`);
      const mangas = mangaRef === undefined ? await api.get<Manga[]>('/api/mangas') : [await resolver.manga(mangaRef)];
      const lists = await Promise.all(mangas.map((m) => api.get<Character[]>(`/api/mangas/${m.id}/characters`)));
      return pickOne(lists.flat().filter((c) => same(c.name, ref)), 'character', ref);
    },

    async chapter(ref) {
      if (ref.startsWith('ch_')) return api.get<Chapter>(`/api/chapters/${enc(ref)}`);
      const slash = ref.lastIndexOf('/');
      const number = Number(ref.slice(slash + 1));
      if (slash <= 0 || !Number.isInteger(number)) {
        throw new CliError(`a chapter is an id (ch_…) or <manga>/<number>, e.g. "Night Market/1"; got "${ref}"`, 2);
      }
      const manga = await resolver.manga(ref.slice(0, slash));
      const chapters = await api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`);
      return pickOne(chapters.filter((c) => c.number === number), 'chapter', ref);
    },

    page: (id) => api.get<PageDetail>(`/api/pages/${enc(id)}`),
    panel: (id) => api.get<Panel>(`/api/panels/${enc(id)}`),
    frame: (id) => api.get<TextFrame>(`/api/frames/${enc(id)}`),
  };
  return resolver;
}
```

- [ ] **Step 6: Write auto-start, job waiting, the context and the program**

`packages/cli/src/autostart.ts`:

```ts
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@manga/shared';
import { loadConfig, readServerInfo } from '@manga/server/config';
import { CliError } from './errors.js';

export const START_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export interface EnsureDeps {
  probe(url: string): Promise<boolean>;
  spawnServer(libraryPath: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface EnsureOptions { url?: string | undefined; config?: AppConfig; deps?: EnsureDeps; timeoutMs?: number }

/** True only when a manga server answers GET /api/health with {ok:true}. */
export async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** packages/server/dist/main.js, resolved through the @manga/server package exports. */
export function serverEntry(): string {
  return fileURLToPath(import.meta.resolve('@manga/server/main'));
}

export function serverLogPath(libraryPath: string): string {
  return join(libraryPath, 'logs', 'server.log');
}

/** Starts the server detached and hidden (no console window), its output appended to <library>/logs/server.log. */
export function spawnServerDetached(libraryPath: string): void {
  mkdirSync(join(libraryPath, 'logs'), { recursive: true });
  const log = openSync(serverLogPath(libraryPath), 'a');
  try {
    const child = spawn(process.execPath, [serverEntry()], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.on('error', () => {
      /* the health poll that follows reports it */
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export const realEnsureDeps: EnsureDeps = {
  probe: probeHealth,
  spawnServer: spawnServerDetached,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Returns the base URL of a healthy server. An explicit --url is only probed. Otherwise the server.json port and
 * the configured port are probed; if neither answers, the server is spawned and the configured port is polled.
 */
export async function ensureServer(opts: EnsureOptions = {}): Promise<string> {
  const deps = opts.deps ?? realEnsureDeps;
  if (opts.url !== undefined) {
    const url = opts.url.replace(/\/+$/, '');
    if (await deps.probe(url)) return url;
    throw new CliError(`server not reachable at ${url}`);
  }
  const config = opts.config ?? loadConfig();
  const target = `http://127.0.0.1:${config.port}`;
  const recorded = readServerInfo(config.libraryPath);
  const candidates = [...new Set([recorded === null ? target : `http://127.0.0.1:${recorded.port}`, target])];
  for (const url of candidates) {
    if (await deps.probe(url)) return url;
  }
  deps.spawnServer(config.libraryPath);
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    if (await deps.probe(target)) return target;
  }
  throw new CliError(
    `started the server but it did not answer at ${target} within ${Math.round(timeoutMs / 1000)} s; see ${serverLogPath(config.libraryPath)}`,
  );
}
```

`packages/cli/src/wait.ts`:

```ts
import WebSocket from 'ws';
import type { Job, ServerEvent } from '@manga/shared';
import type { ApiClient } from './client.js';
import { onInterrupt, type CliIo } from './io.js';

const TERMINAL: ReadonlySet<Job['status']> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminalJob(job: Job): boolean {
  return TERMINAL.has(job.status);
}

/** "label value/max", "label value", "label", the error of a failed job, or ''. */
export function progressText(job: Job): string {
  if (job.status === 'failed' && job.error !== null) return `error: ${job.error}`;
  if (job.progress === null) return '';
  const { label, value, max } = job.progress;
  if (value === undefined) return label;
  return max === undefined ? `${label} ${value}` : `${label} ${value}/${max}`;
}

export function openEvents(baseUrl: string): WebSocket {
  return new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/events`);
}

function parseEvent(raw: WebSocket.RawData): ServerEvent | null {
  try {
    return JSON.parse(String(raw)) as ServerEvent;
  } catch {
    return null;
  }
}

export interface WaitOptions { baseUrl: string; api: ApiClient; ids: readonly string[]; io: CliIo; json: boolean }

/** Resolves with the jobs (in `ids` order) once all are terminal. Progress lines go to stderr unless json. */
export function waitForJobs(opts: WaitOptions): Promise<Job[]> {
  if (opts.ids.length === 0) return Promise.resolve([]);
  const wanted = new Set(opts.ids);
  const done = new Map<string, Job>();
  const lastLine = new Map<string, string>();
  const ws = openEvents(opts.baseUrl);
  return new Promise<Job[]>((resolve, reject) => {
    let settled = false;
    const finish = (result: Job[] | Error): void => {
      if (settled) return;
      settled = true;
      ws.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const take = (job: Job): void => {
      if (!wanted.has(job.id) || done.has(job.id)) return;
      if (!opts.json) {
        const line = progressText(job);
        if (line !== '' && lastLine.get(job.id) !== line) {
          lastLine.set(job.id, line);
          opts.io.stderr(`${job.id} ${line}\n`);
        }
      }
      if (isTerminalJob(job)) {
        done.set(job.id, job);
        if (done.size === wanted.size) finish(opts.ids.map((id) => done.get(id) as Job));
      }
    };
    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (event?.type === 'hello') {
        // Subscribed: catch up on jobs that moved (or finished) before the stream opened.
        Promise.all(opts.ids.map((id) => opts.api.get<Job>(`/api/jobs/${encodeURIComponent(id)}`))).then(
          (jobs) => jobs.forEach(take),
          (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
        );
      } else if (event?.type === 'job') {
        take(event.job);
      }
    });
    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error('the event stream closed before the jobs finished')));
  });
}

export interface StreamOptions { baseUrl: string; io: CliIo; onReady(): Promise<void>; onJob(job: Job): void }

/** Streams job events until Ctrl+C or io.signal; `onReady` runs once the stream is subscribed. */
export function streamJobs(opts: StreamOptions): Promise<void> {
  const ws = openEvents(opts.baseUrl);
  return new Promise<void>((resolve, reject) => {
    const dispose = onInterrupt(opts.io.signal, () => ws.close());
    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (event?.type === 'hello') {
        opts.onReady().catch((err: unknown) => {
          dispose();
          reject(err);
          ws.close();
        });
      } else if (event?.type === 'job') {
        opts.onJob(event.job);
      }
    });
    ws.on('error', (err) => {
      dispose();
      reject(err);
    });
    ws.on('close', () => {
      dispose();
      resolve();
    });
  });
}
```

`packages/cli/src/context.ts`:

```ts
import type { Job } from '@manga/shared';
import { ensureServer } from './autostart.js';
import { ApiClient } from './client.js';
import type { CliIo } from './io.js';
import { createResolver, type Resolver } from './resolver.js';
import { waitForJobs } from './wait.js';

export type { Resolver } from './resolver.js';

export interface CliContext {
  api: ApiClient; json: boolean; wait: boolean; baseUrl: string; io: CliIo;
  out(data: unknown, human: () => string): void;              // --json → JSON.stringify(data, null, 2); else human()
  waitJobs(jobIds: string[]): Promise<Job[]>;                   // WS /api/events; prints "label value/max" lines to stderr unless --json
  resolve: Resolver;
}

export interface ContextOptions { json: boolean; wait: boolean; url: string | undefined; io: CliIo }

/** Finds (or auto-starts) the server and builds the context every command uses. */
export async function createContext(opts: ContextOptions): Promise<CliContext> {
  const baseUrl = await ensureServer({ url: opts.url });
  const api = new ApiClient(baseUrl);
  return {
    api,
    json: opts.json,
    wait: opts.wait,
    baseUrl,
    io: opts.io,
    out(data, human) {
      opts.io.stdout(`${opts.json ? JSON.stringify(data, null, 2) : human()}\n`);
    },
    waitJobs: (jobIds) => waitForJobs({ baseUrl, api, ids: jobIds, io: opts.io, json: opts.json }),
    resolve: createResolver(api),
  };
}
```

`packages/cli/src/program.ts` (Tasks 19–21 register the command groups here):

```ts
import { Command, CommanderError } from 'commander';
import { createContext, type CliContext } from './context.js';
import { CliError } from './errors.js';
import { processIo, type CliIo } from './io.js';
import { VERSION } from './version.js';

export interface GlobalOptions { json?: boolean; wait?: boolean; url?: string }
export type ContextFactory = (opts: GlobalOptions, io: CliIo) => Promise<CliContext>;

export const defaultContextFactory: ContextFactory = (opts, io) =>
  createContext({ json: opts.json === true, wait: opts.wait === true, url: opts.url, io });

export function buildProgram(io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Command {
  const program = new Command('manga')
    .description('Manga Builder from the command line')
    .version(VERSION)
    .option('--json', 'print raw API data as JSON')
    .option('--wait', 'wait for started jobs to finish, streaming progress to stderr')
    .option('--url <baseUrl>', 'server URL (default: <library>/server.json, else http://127.0.0.1:4317); never auto-starts')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });
  let context: Promise<CliContext> | null = null;
  const ctx = (): Promise<CliContext> => (context ??= factory(program.opts<GlobalOptions>(), io));
  void ctx; // command groups are registered in Tasks 19–21
  return program;
}

/** 0 for help/version; 2 for usage errors; the CliError's code; 1 for everything else (message on stderr). */
export function exitCodeFor(err: unknown, io: CliIo): number {
  if (err instanceof CommanderError) {
    return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2;
  }
  if (err instanceof CliError) {
    if (!err.silent) io.stderr(`error: ${err.message}\n`);
    return err.exitCode;
  }
  io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

export async function runCli(argv: readonly string[], io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Promise<number> {
  try {
    await buildProgram(io, factory).parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    return exitCodeFor(err, io);
  }
}
```

`packages/cli/src/index.ts`:

```ts
#!/usr/bin/env node
import { runCli } from './program.js';

process.exitCode = await runCli(process.argv.slice(2));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/cli`
Expected: PASS (14 tests across client, autostart and context).

- [ ] **Step 8: Type-check**

Run: `npm run build`
Expected: exits 0. `packages/cli/dist/index.js` exists and starts with `#!/usr/bin/env node`.

- [ ] **Step 9: Commit**

```bash
git add tsconfig.json packages/cli
git commit -m "feat(cli): add API client, resolver, context, server auto-start and job streaming" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: CLI — `serve`, `status`, `engine`, `create`, `list`, `show`, `rm`

**Files:**
- Create: `packages/cli/src/commands/server.ts`, `packages/cli/src/commands/mangas.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/cmd-server-mangas.test.ts`

**Interfaces:**
- Consumes: `CliContext`, `CliIo`, `onInterrupt`, `table`; `startServer` via a dynamic `import('@manga/server')`, so the other commands never load SQLite.
- Produces:
  - `registerServerCommands(program, ctx, io?)`:
    - `serve [--open]`: runs until Ctrl+C or `io.signal`.
    - `status`.
    - `engine [claude|local] [--task <task=engine...>]`: `task=default` clears an override.
  - `formatStatus`, `formatEngine`.
  - `registerMangaCommands(program, ctx)`:
    - `create <title> [--lang] [--color] [--dir] [--style] [--synopsis]`: `--color color` without `--style` picks `anime-color`.
    - `list`.
    - `show <manga>`: human tree, or JSON `{ manga, characters, chapters: [chapter + pages: [{id, order, panelIds (reading order)}]] }`.
    - `rm <manga>`.
  - `describeManga(m)`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cmd-server-mangas.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readingOrder, type Chapter, type Character, type Manga, type PageDetail, type ServiceStatus, type Settings } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { runCli } from '../src/program.js';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('status and engine', () => {
  it('status prints the server, services and the queue', async () => {
    const r = await h.run('status');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^server\\s+${h.url.replace(/\./g, '\\.')}$`, 'm'));
    expect(r.stdout).toMatch(/^claude\s+down\s+not configured$/m);
    expect(r.stdout).toMatch(/^queue\s+0 queued, 0 running$/m);
    expect((await h.json<ServiceStatus>('status')).queue).toEqual({ queued: 0, running: 0, pausedLanes: [] });
  });

  it('engine shows and sets the global mode and per-task overrides', async () => {
    expect((await h.run('engine')).stdout).toMatch(/^mode\s+claude$/m);
    expect((await h.run('engine', 'local')).stdout).toMatch(/^mode\s+local$/m);
    const r = await h.run('engine', '--task', 'story=claude', 'review=claude');
    expect(r.stdout).toMatch(/^story\s+claude \(override\)$/m);
    expect(r.stdout).toMatch(/^prompts\s+local$/m);
    await h.run('engine', '--task', 'story=default');
    expect(await h.json<Settings['engine']>('engine')).toEqual({ mode: 'local', tasks: { review: 'claude' } });
    const bad = await h.run('engine', 'gpt');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/engine must be claude or local/);
    expect((await h.run('engine', '--task', 'plot=local')).code).toBe(2);
    expect((await h.run('engine', 'claude', '--task', 'review=default')).code).toBe(0);
  });
});

describe('mangas', () => {
  it('create, list, show and rm', async () => {
    const created = await h.run('create', 'Night Market', '--lang', 'uk', '--dir', 'ltr');
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/^created mg_[a-z2-7]{10}  Night Market  \(uk, bw, ltr\)\n$/);
    const sunny = await h.json<Manga>('create', 'Sunny', '--color', 'color');
    expect(sunny.styleGuide.stylePrompt).toContain('vibrant colors');
    const list = await h.run('list');
    expect(list.stdout).toMatch(/Night Market\s+uk\s+bw\s+ltr/);
    expect(list.stdout).toMatch(/Sunny\s+en\s+color\s+rtl/);

    const night = (await h.json<Manga[]>('list')).find((m) => m.title === 'Night Market');
    expect(night).toBeDefined();
    const api = new ApiClient(h.url);
    const aiko = await api.post<Character>(`/api/mangas/${night?.id}/characters`, { name: 'Aiko', role: 'main' });
    const chapter = await api.post<Chapter>(`/api/mangas/${night?.id}/chapters`, { title: 'Opening' });
    const page = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: '2x2' });
    const order = readingOrder(page.page.layout, 'ltr');
    const shown = await h.run('show', 'night market');
    expect(shown.stdout).toContain(`  ${aiko.id}  Aiko  main`);
    expect(shown.stdout).toContain(`  #1  ${chapter.id}  Opening  draft`);
    expect(shown.stdout).toContain(`      p1  ${page.page.id}  ${order.join(' ')}`);
    const json = await h.json<{ chapters: Array<{ pages: Array<{ id: string; panelIds: string[] }> }> }>('show', 'night market');
    expect(json.chapters[0]?.pages[0]).toMatchObject({ id: page.page.id, panelIds: order });

    expect((await h.run('rm', 'sunny')).stdout).toBe(`deleted ${sunny.id}  Sunny\n`);
    const gone = await h.run('show', 'Sunny');
    expect(gone.code).toBe(1);
    expect(gone.stderr).toBe('error: no manga matches "Sunny"\n');
  });

  it('reports API validation errors on stderr with exit 1', async () => {
    const r = await h.run('create', 'X', '--lang', 'fr');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: language: /);
  });

  it('exits 2 for an unknown command or a missing argument', async () => {
    const unknown = await h.run('frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown command 'frobnicate'/);
    expect((await h.run('show')).code).toBe(2);
  });

  it('fails with exit 1 when the server at --url is unreachable', async () => {
    let stderr = '';
    const code = await runCli(['--url', 'http://127.0.0.1:9', 'list'], {
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toBe('error: server not reachable at http://127.0.0.1:9\n');
  });
});

describe('serve', () => {
  it('runs a server from MANGA_LIBRARY / MANGA_PORT until interrupted', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'manga-serve-'));
    const saved = { library: process.env['MANGA_LIBRARY'], port: process.env['MANGA_PORT'] };
    process.env['MANGA_LIBRARY'] = lib;
    process.env['MANGA_PORT'] = '0';
    try {
      const ac = new AbortController();
      let out = '';
      const done = runCli(['serve'], {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
        signal: ac.signal,
      });
      await vi.waitFor(() => expect(out).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/), { timeout: 10_000 });
      const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1] ?? '';
      expect(out).toContain(`(library: ${lib})`);
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
      expect(existsSync(join(lib, 'server.json'))).toBe(true);
      ac.abort();
      expect(await done).toBe(0);
      expect(existsSync(join(lib, 'server.json'))).toBe(false);
    } finally {
      if (saved.library === undefined) delete process.env['MANGA_LIBRARY'];
      else process.env['MANGA_LIBRARY'] = saved.library;
      if (saved.port === undefined) delete process.env['MANGA_PORT'];
      else process.env['MANGA_PORT'] = saved.port;
      rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/cmd-server-mangas.test.ts`
Expected: FAIL. `status` exits 2 with "unknown command 'status'".

- [ ] **Step 3: Write the command groups**

`packages/cli/src/commands/server.ts`:

```ts
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import {
  EngineNameSchema, TaskSchema, type EngineName, type ServiceState, type ServiceStatus, type Settings, type SettingsPatch, type Task,
} from '@manga/shared';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { onInterrupt, processIo, type CliIo } from '../io.js';

function browserCommand(url: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [url] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  const { cmd, args } = browserCommand(url);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    /* no browser: the URL is printed anyway */
  });
  child.unref();
}

const pad = (label: string): string => label.padEnd(8);

function serviceLine(name: string, state: ServiceState): string {
  return `${pad(name)}${state.ok ? 'ok  ' : 'down'}  ${state.detail}`;
}

export function formatStatus(status: ServiceStatus, baseUrl: string): string {
  const { queue } = status;
  return [
    `${pad('server')}${baseUrl}`,
    serviceLine('claude', status.claude),
    serviceLine('ollama', status.ollama),
    serviceLine('comfy', status.comfy),
    `${pad('queue')}${queue.queued} queued, ${queue.running} running`,
    ...queue.pausedLanes.map((p) => `${pad('paused')}${p.lane} ${p.until === null ? 'until resumed' : `until ${p.until}`} (${p.reason})`),
  ].join('\n');
}

export function formatEngine(settings: Settings): string {
  const { mode, tasks } = settings.engine;
  return [
    `${'mode'.padEnd(9)}${mode}`,
    ...TaskSchema.options.map((task) => {
      const override = tasks[task];
      return `${task.padEnd(9)}${override ?? mode}${override === undefined ? '' : ' (override)'}`;
    }),
  ].join('\n');
}

function parseEngine(value: string): EngineName {
  const parsed = EngineNameSchema.safeParse(value);
  if (!parsed.success) throw new CliError(`engine must be claude or local, got "${value}"`, 2);
  return parsed.data;
}

function parseTaskSpec(spec: string): [Task, EngineName | 'default'] {
  const [task = '', engine = ''] = spec.split('=', 2);
  const parsedTask = TaskSchema.safeParse(task);
  if (!parsedTask.success) throw new CliError(`unknown task "${task}" in "${spec}"; tasks are ${TaskSchema.options.join(', ')}`, 2);
  return [parsedTask.data, engine === 'default' ? 'default' : parseEngine(engine)];
}

export function registerServerCommands(program: Command, ctx: () => Promise<CliContext>, io: CliIo = processIo): void {
  program
    .command('serve')
    .description('run the server in this terminal until Ctrl+C')
    .option('--open', 'open the UI in the browser')
    .action(async (opts: { open?: boolean }) => {
      const { startServer } = await import('@manga/server');
      const server = await startServer();
      io.stdout(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})\n`);
      if (opts.open === true) openBrowser(server.url);
      await new Promise<void>((resolve) => {
        onInterrupt(io.signal, resolve);
      });
      await server.stop();
    });

  program
    .command('status')
    .description('server, engine, ComfyUI and queue status')
    .action(async () => {
      const c = await ctx();
      const status = await c.api.get<ServiceStatus>('/api/status');
      c.out(status, () => formatStatus(status, c.baseUrl));
    });

  program
    .command('engine')
    .description('show or set the AI engine, globally and per task')
    .argument('[mode]', 'claude or local')
    .option('--task <task=engine...>', 'per-task override, e.g. story=local; story=default clears it')
    .action(async (mode: string | undefined, opts: { task?: string[] }) => {
      const engineMode = mode === undefined ? undefined : parseEngine(mode);
      const specs = (opts.task ?? []).map(parseTaskSpec);
      const c = await ctx();
      const patch: SettingsPatch = {};
      if (engineMode !== undefined) patch.engine = { mode: engineMode };
      if (specs.length > 0) {
        const current = await c.api.get<Settings>('/api/settings');
        const tasks: Settings['engine']['tasks'] = { ...current.engine.tasks };
        for (const [task, engine] of specs) {
          if (engine === 'default') delete tasks[task];
          else tasks[task] = engine;
        }
        patch.engine = { ...patch.engine, tasks };
      }
      const settings = patch.engine === undefined
        ? await c.api.get<Settings>('/api/settings')
        : await c.api.patch<Settings>('/api/settings', patch);
      c.out(settings.engine, () => formatEngine(settings));
    });
}
```

`packages/cli/src/commands/mangas.ts`:

```ts
import type { Command } from 'commander';
import { readingOrder, STYLE_PRESETS, type Chapter, type Character, type Manga, type Page } from '@manga/shared';
import type { CliContext } from '../context.js';
import { table } from '../format.js';

interface ShowData {
  manga: Manga;
  characters: Character[];
  chapters: Array<Chapter & { pages: Array<{ id: string; order: number; panelIds: string[] }> }>;
}

export function describeManga(m: Manga): string {
  return `${m.id}  ${m.title}  (${m.language}, ${m.colorMode}, ${m.readingDirection})`;
}

function formatShow(d: ShowData): string {
  const lines = [describeManga(d.manga)];
  if (d.manga.coverPageId !== null) lines.push(`cover       ${d.manga.coverPageId}`);
  lines.push(d.characters.length === 0 ? 'characters  none' : 'characters');
  for (const c of d.characters) lines.push(`  ${c.id}  ${c.name}  ${c.role}`);
  lines.push(d.chapters.length === 0 ? 'chapters    none' : 'chapters');
  for (const chapter of d.chapters) {
    lines.push(`  #${chapter.number}  ${chapter.id}  ${chapter.title}  ${chapter.status}`);
    for (const page of chapter.pages) lines.push(`      p${page.order + 1}  ${page.id}  ${page.panelIds.join(' ')}`);
  }
  return lines.join('\n');
}

export function registerMangaCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program
    .command('create')
    .description('create a manga')
    .argument('<title>')
    .option('--lang <lang>', 'en or uk', 'en')
    .option('--color <mode>', 'bw or color', 'bw')
    .option('--dir <dir>', 'reading direction: rtl or ltr', 'rtl')
    .option('--style <preset>', `style preset: ${Object.keys(STYLE_PRESETS).join(', ')} (default manga-bw; anime-color with --color color)`)
    .option('--synopsis <text>', 'short synopsis', '')
    .action(async (title: string, opts: { lang: string; color: string; dir: string; style?: string; synopsis: string }) => {
      const c = await ctx();
      const manga = await c.api.post<Manga>('/api/mangas', {
        title,
        synopsis: opts.synopsis,
        language: opts.lang,
        colorMode: opts.color,
        readingDirection: opts.dir,
        stylePreset: opts.style ?? (opts.color === 'color' ? 'anime-color' : 'manga-bw'),
      });
      c.out(manga, () => `created ${describeManga(manga)}`);
    });

  program
    .command('list')
    .description('list mangas')
    .action(async () => {
      const c = await ctx();
      const mangas = await c.api.get<Manga[]>('/api/mangas');
      c.out(mangas, () =>
        mangas.length === 0
          ? 'no mangas yet; create one with: manga create "<title>"'
          : table(mangas.map((m) => [m.id, m.title, m.language, m.colorMode, m.readingDirection])),
      );
    });

  program
    .command('show')
    .description('show a manga: characters, chapters, pages and panel ids in reading order')
    .argument('<manga>', 'id or title')
    .action(async (ref: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      const [characters, chapters] = await Promise.all([
        c.api.get<Character[]>(`/api/mangas/${manga.id}/characters`),
        c.api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`),
      ]);
      const withPages = await Promise.all(chapters.map(async (chapter) => {
        const pages = await c.api.get<Page[]>(`/api/chapters/${chapter.id}/pages`);
        return { ...chapter, pages: pages.map((p) => ({ id: p.id, order: p.order, panelIds: readingOrder(p.layout, manga.readingDirection) })) };
      }));
      const data: ShowData = { manga, characters, chapters: withPages };
      c.out(data, () => formatShow(data));
    });

  program
    .command('rm')
    .description('delete a manga and everything in it')
    .argument('<manga>', 'id or title')
    .action(async (ref: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(ref);
      await c.api.delete(`/api/mangas/${manga.id}`);
      c.out({ ok: true, id: manga.id }, () => `deleted ${manga.id}  ${manga.title}`);
    });
}
```

In `packages/cli/src/program.ts`, add these imports after the `commander` import:

```ts
import { registerMangaCommands } from './commands/mangas.js';
import { registerServerCommands } from './commands/server.js';
```

and replace the line `void ctx; // command groups are registered in Tasks 19–21` with:

```ts
  registerServerCommands(program, ctx, io);
  registerMangaCommands(program, ctx);
```

- [ ] **Step 4: Run the CLI tests to verify they pass**

Run: `npx vitest run packages/cli`
Expected: PASS (all CLI test files; `cmd-server-mangas.test.ts` has 7 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add serve, status, engine, create, list, show and rm commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 20: CLI — `character`, `chapter`, `page`, `layouts`

**Files:**
- Create: `packages/cli/src/commands/characters.ts`, `packages/cli/src/commands/chapters.ts`, `packages/cli/src/commands/pages.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/cmd-structure.test.ts`

**Interfaces:**
- Consumes: `CliContext`, `ApiError`, `CliError`, `parseNonNegativeInt`, `table`, `fixed`; `readingOrder`, `computeRects` and `splitHandles` from `@manga/shared`.
- Produces:
  - `registerCharacterCommands(program, ctx)`:
    - `character add <manga> --name [--role] [--appearance] [--personality] [--speech] [--seed]`
    - `character upload <char> <file> --slot [--manga]`
    - `character pick <char> <image> [--slot portrait] [--manga]`
  - `registerChapterCommands(program, ctx)`: `chapter add <manga> <title> [--synopsis]`, `chapter list <manga>`, `chapter rm <chapter>`.
  - `registerPageCommands(program, ctx)`:
    - `layouts`
    - `page add <chapter> [--layout 2x2] [--at <index>]`
    - `page layout <page> <preset> [--confirm]`: on 409 `needs_confirm` it prints the panels that would be removed and exits 1. With `--json` it prints `{error:'needs_confirm', removedPanelIds}` to stdout instead.
    - `page split <panel> h|v`
    - `page merge <panelA> <panelB>`
    - `page resize <page> <splitPath> <ratio>`: `splitPath` is `root` or a/b steps. The output reports the ratio actually applied (clamped).
    - `page show <page>`: panels in reading order with rects, splits with paths and ratios, and the frame count.
    - `page rm <page>`
  - `parseSplitPath(arg)`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cmd-structure.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readingOrder, type Chapter, type Character, type Page, type PageDetail } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
let api: ApiClient;
beforeAll(async () => {
  h = await startHarness();
  api = new ApiClient(h.url);
});
afterAll(async () => {
  await h.close();
});

describe('character commands', () => {
  it('add, upload and pick', async () => {
    expect((await h.run('create', 'Oni Tales', '--dir', 'ltr')).code).toBe(0);
    const aiko = await h.json<Character>('character', 'add', 'oni tales', '--name', 'Aiko', '--role', 'main', '--appearance', '1girl, red hair', '--seed', '42');
    expect(aiko).toMatchObject({ name: 'Aiko', role: 'main', appearanceTags: '1girl, red hair', seed: 42 });
    expect((await h.run('character', 'add', 'oni tales', '--name', 'Ren')).stdout).toMatch(/^created cr_[a-z2-7]{10}  Ren  \(supporting, seed \d+\)\n$/);
    const file = join(h.lib, 'aiko.png');
    writeFileSync(file, makePng(32, 48));
    const up = await h.run('character', 'upload', 'Aiko', file, '--slot', 'portrait', '--manga', 'oni tales');
    expect(up.stdout).toMatch(/^uploaded im_[a-z2-7]{10} \(32x48\) as portrait of Aiko\n$/);
    const imageId = /(im_[a-z2-7]{10})/.exec(up.stdout)?.[1] ?? '';
    expect((await h.run('character', 'pick', 'Aiko', imageId, '--slot', 'fullbody')).stdout).toBe(`Aiko fullbody = ${imageId}\n`);
    expect((await api.get<Character>(`/api/characters/${aiko.id}`)).refs).toEqual({ portrait: imageId, fullbody: imageId });
    expect((await h.run('character', 'add', 'oni tales')).code).toBe(2);
    expect((await h.run('character', 'add', 'oni tales', '--name', 'B', '--seed', '-1')).code).toBe(2);
    expect((await h.run('character', 'upload', 'Aiko', join(h.lib, 'nope.png'), '--slot', 'portrait')).code).toBe(1);
  });
});

describe('chapter commands', () => {
  it('add, list and rm', async () => {
    expect((await h.run('chapter', 'add', 'Oni Tales', 'Opening')).stdout).toMatch(/^created ch_[a-z2-7]{10}  #1  Opening\n$/);
    await h.run('chapter', 'add', 'Oni Tales', 'Second');
    const list = await h.run('chapter', 'list', 'oni tales');
    expect(list.stdout).toMatch(/^#1\s+ch_[a-z2-7]{10}\s+Opening\s+draft$/m);
    expect(list.stdout).toMatch(/^#2\s+ch_[a-z2-7]{10}\s+Second\s+draft$/m);
    expect((await h.run('chapter', 'rm', 'Oni Tales/2')).stdout).toMatch(/^deleted ch_[a-z2-7]{10}  #2  Second\n$/);
    expect((await h.json<Chapter[]>('chapter', 'list', 'oni tales')).map((c) => c.number)).toEqual([1]);
    expect((await h.run('chapter', 'rm', 'garbage')).code).toBe(2);
  });
});

describe('page commands', () => {
  it('add, layout with and without --confirm, split, merge, resize, show, rm, and layouts', async () => {
    const added = await h.json<PageDetail>('page', 'add', 'Oni Tales/1', '--layout', '2x2');
    expect(added.panels).toHaveLength(4);
    expect((await h.run('page', 'add', 'Oni Tales/1', '--layout', 'splash', '--at', '0')).stdout).toMatch(/^created pg_[a-z2-7]{10}  \(splash\)  panels: pn_[a-z2-7]{10}\n$/);
    const order = readingOrder(added.page.layout, 'ltr');

    const refused = await h.run('page', 'layout', added.page.id, 'splash');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('these panels would be removed');
    for (const id of order.slice(1)) expect(refused.stderr).toContain(id);
    expect(refused.stderr).not.toContain('error:');
    const refusedJson = await h.run('--json', 'page', 'layout', added.page.id, 'splash');
    expect(refusedJson.code).toBe(1);
    expect(JSON.parse(refusedJson.stdout)).toEqual({ error: 'needs_confirm', removedPanelIds: order.slice(1) });
    expect((await api.get<PageDetail>(`/api/pages/${added.page.id}`)).panels).toHaveLength(4);
    expect((await h.run('page', 'layout', added.page.id, 'splash', '--confirm')).stdout).toBe(`layout splash on ${added.page.id}  panels: ${order[0]}\n`);

    const only = order[0] ?? '';
    const split = await h.run('page', 'split', only, 'v');
    const newPanel = /new panel (pn_[a-z2-7]{10})/.exec(split.stdout)?.[1] ?? '';
    expect(newPanel).not.toBe('');
    expect((await h.run('page', 'merge', only, newPanel)).stdout).toBe(`merged ${newPanel} into ${only}\n`);
    expect((await h.run('page', 'split', only, 'x')).code).toBe(2);

    expect((await h.run('page', 'split', only, 'h')).code).toBe(0);
    expect((await h.run('page', 'resize', added.page.id, 'root', '0.99')).stdout).toBe(`resized root of ${added.page.id}: ratio 0.92 (clamped from 0.99)\n`);
    expect((await h.run('page', 'resize', added.page.id, 'root', '0.4')).stdout).toBe(`resized root of ${added.page.id}: ratio 0.4\n`);
    expect((await h.run('page', 'resize', added.page.id, 'aq', '0.5')).code).toBe(2);
    expect((await h.run('page', 'resize', added.page.id, 'root', '1.5')).code).toBe(2);
    expect((await h.run('page', 'resize', added.page.id, 'a', '0.5')).code).toBe(1);

    const shown = await h.run('page', 'show', added.page.id);
    expect(shown.stdout).toContain('panels (reading order)');
    expect(shown.stdout).toMatch(new RegExp(`^ {2}1 {2}${only} {2}x=`, 'm'));
    expect(shown.stdout).toMatch(/^ {2}root {2}h {2}0\.4$/m);

    const layouts = await h.run('layouts');
    expect(layouts.stdout.split('\n')[0]).toMatch(/^preset\s+panels$/);
    expect(layouts.stdout).toMatch(/^2x3\s+6$/m);

    expect((await h.run('page', 'rm', added.page.id)).stdout).toBe(`deleted ${added.page.id}\n`);
    expect((await api.get<Page[]>(`/api/chapters/${added.page.chapterId}/pages`)).map((p) => p.order)).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/cmd-structure.test.ts`
Expected: FAIL. `character add` exits 2 with "unknown command 'character'".

- [ ] **Step 3: Write the command groups**

`packages/cli/src/commands/characters.ts`:

```ts
import type { Command } from 'commander';
import type { Character, Image } from '@manga/shared';
import { parseNonNegativeInt } from '../args.js';
import type { CliContext } from '../context.js';

export function registerCharacterCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const character = program.command('character').description('characters: add, upload, pick (generate and sheet come with AI imaging)');

  character
    .command('add')
    .description('add a character to a manga')
    .argument('<manga>', 'id or title')
    .requiredOption('--name <name>', 'character name')
    .option('--role <role>', 'main, supporting or minor', 'supporting')
    .option('--appearance <tags>', 'canonical appearance tags, inserted verbatim into every prompt', '')
    .option('--personality <text>', 'personality', '')
    .option('--speech <style>', 'speech style', '')
    .option('--seed <n>', 'fixed seed (default: random)', parseNonNegativeInt)
    .action(async (mangaRef: string, opts: { name: string; role: string; appearance: string; personality: string; speech: string; seed?: number }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const created = await c.api.post<Character>(`/api/mangas/${manga.id}/characters`, {
        name: opts.name,
        role: opts.role,
        appearanceTags: opts.appearance,
        personality: opts.personality,
        speechStyle: opts.speech,
        ...(opts.seed === undefined ? {} : { seed: opts.seed }),
      });
      c.out(created, () => `created ${created.id}  ${created.name}  (${created.role}, seed ${created.seed})`);
    });

  character
    .command('upload')
    .description('upload your own image (PNG or JPEG) into a reference slot')
    .argument('<char>', 'id or name')
    .argument('<file>', 'PNG or JPEG file')
    .requiredOption('--slot <slot>', 'portrait, fullbody, side or back')
    .option('--manga <manga>', 'manga to look the name up in')
    .action(async (charRef: string, file: string, opts: { slot: string; manga?: string }) => {
      const c = await ctx();
      const target = await c.resolve.character(charRef, opts.manga);
      const image = await c.api.upload<Image>(`/api/characters/${target.id}/upload?slot=${encodeURIComponent(opts.slot)}`, file);
      c.out(image, () => `uploaded ${image.id} (${image.width}x${image.height}) as ${opts.slot} of ${target.name}`);
    });

  character
    .command('pick')
    .description("use one of the character's images for a reference slot")
    .argument('<char>', 'id or name')
    .argument('<image>', 'image id')
    .option('--slot <slot>', 'portrait, fullbody, side or back', 'portrait')
    .option('--manga <manga>', 'manga to look the name up in')
    .action(async (charRef: string, imageId: string, opts: { slot: string; manga?: string }) => {
      const c = await ctx();
      const target = await c.resolve.character(charRef, opts.manga);
      const updated = await c.api.post<Character>(`/api/characters/${target.id}/refs/${encodeURIComponent(opts.slot)}`, { imageId });
      c.out(updated, () => `${updated.name} ${opts.slot} = ${imageId}`);
    });
}
```

`packages/cli/src/commands/chapters.ts`:

```ts
import type { Command } from 'commander';
import type { Chapter } from '@manga/shared';
import type { CliContext } from '../context.js';
import { table } from '../format.js';

export function registerChapterCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const chapter = program.command('chapter').description('chapters of a manga');

  chapter
    .command('add')
    .description('add a chapter (numbered after the last one)')
    .argument('<manga>', 'id or title')
    .argument('<title>')
    .option('--synopsis <text>', 'synopsis', '')
    .action(async (mangaRef: string, title: string, opts: { synopsis: string }) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const created = await c.api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title, synopsis: opts.synopsis });
      c.out(created, () => `created ${created.id}  #${created.number}  ${created.title}`);
    });

  chapter
    .command('list')
    .description("list a manga's chapters")
    .argument('<manga>', 'id or title')
    .action(async (mangaRef: string) => {
      const c = await ctx();
      const manga = await c.resolve.manga(mangaRef);
      const chapters = await c.api.get<Chapter[]>(`/api/mangas/${manga.id}/chapters`);
      c.out(chapters, () => (chapters.length === 0 ? 'no chapters yet' : table(chapters.map((ch) => [`#${ch.number}`, ch.id, ch.title, ch.status]))));
    });

  chapter
    .command('rm')
    .description('delete a chapter with its pages')
    .argument('<chapter>', 'id or <manga>/<number>')
    .action(async (ref: string) => {
      const c = await ctx();
      const target = await c.resolve.chapter(ref);
      await c.api.delete(`/api/chapters/${target.id}`);
      c.out({ ok: true, id: target.id }, () => `deleted ${target.id}  #${target.number}  ${target.title}`);
    });
}
```

`packages/cli/src/commands/pages.ts`:

```ts
import type { Command } from 'commander';
import { computeRects, readingOrder, splitHandles, type LayoutNode, type Manga, type PageDetail, type PresetInfo } from '@manga/shared';
import { parseNonNegativeInt } from '../args.js';
import { ApiError } from '../client.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { fixed, table } from '../format.js';

type SplitPath = Array<'a' | 'b'>;

/** "root" (or ".") is the top split; otherwise a/b steps from it, e.g. "ab". */
export function parseSplitPath(arg: string): SplitPath {
  if (arg === 'root' || arg === '.') return [];
  if (!/^[ab]+$/.test(arg)) throw new CliError(`split path must be "root" or a/b steps like "ab", got "${arg}"`, 2);
  return [...arg] as SplitPath;
}

function nodeAt(tree: LayoutNode, path: SplitPath): LayoutNode | null {
  let node: LayoutNode = tree;
  for (const step of path) {
    if (node.type !== 'split') return null;
    node = step === 'a' ? node.a : node.b;
  }
  return node;
}

const enc = encodeURIComponent;

async function mangaOf(c: CliContext, detail: PageDetail): Promise<Manga> {
  return c.api.get<Manga>(`/api/mangas/${detail.page.mangaId}`);
}

async function orderOf(c: CliContext, detail: PageDetail): Promise<string[]> {
  return readingOrder(detail.page.layout, (await mangaOf(c, detail)).readingDirection);
}

export function registerPageCommands(program: Command, ctx: () => Promise<CliContext>): void {
  program
    .command('layouts')
    .description('list the layout presets')
    .action(async () => {
      const c = await ctx();
      const presets = await c.api.get<PresetInfo[]>('/api/layouts');
      c.out(presets, () => table(presets.map((p) => [p.name, String(p.panelCount)]), ['preset', 'panels']));
    });

  const page = program.command('page').description('pages and their layout');

  page
    .command('add')
    .description('add a page to a chapter')
    .argument('<chapter>', 'id or <manga>/<number>')
    .option('--layout <preset>', 'layout preset (see: manga layouts)', '2x2')
    .option('--at <index>', 'insert position, 0-based (default: at the end)', parseNonNegativeInt)
    .action(async (chapterRef: string, opts: { layout: string; at?: number }) => {
      const c = await ctx();
      const chapter = await c.resolve.chapter(chapterRef);
      const detail = await c.api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, {
        layoutPreset: opts.layout, ...(opts.at === undefined ? {} : { index: opts.at }),
      });
      const order = await orderOf(c, detail);
      c.out(detail, () => `created ${detail.page.id}  (${opts.layout})  panels: ${order.join(' ')}`);
    });

  page
    .command('layout')
    .description('apply a layout preset; existing panels map onto it in reading order')
    .argument('<page>')
    .argument('<preset>')
    .option('--confirm', 'allow removing the panels that do not fit the new preset')
    .action(async (pageId: string, preset: string, opts: { confirm?: boolean }) => {
      const c = await ctx();
      let detail: PageDetail;
      try {
        detail = await c.api.post<PageDetail>(`/api/pages/${enc(pageId)}/layout/preset`, { preset, confirm: opts.confirm === true });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'needs_confirm') throw err;
        const removed = (err.details as { removedPanelIds?: string[] } | undefined)?.removedPanelIds ?? [];
        if (c.json) {
          c.io.stdout(`${JSON.stringify({ error: 'needs_confirm', removedPanelIds: removed }, null, 2)}\n`);
        } else {
          c.io.stderr(`layout ${preset} has fewer panels; these panels would be removed with their images:\n${removed.map((id) => `  ${id}`).join('\n')}\nre-run with --confirm to apply\n`);
        }
        throw new CliError('needs confirmation', 1, true);
      }
      const order = await orderOf(c, detail);
      c.out(detail, () => `layout ${preset} on ${detail.page.id}  panels: ${order.join(' ')}`);
    });

  page
    .command('split')
    .description('split a panel in two: h puts the new panel below, v puts it to the right')
    .argument('<panel>')
    .argument('<dir>', 'h or v')
    .action(async (panelId: string, dir: string) => {
      if (dir !== 'h' && dir !== 'v') throw new CliError(`direction must be h or v, got "${dir}"`, 2);
      const c = await ctx();
      const panel = await c.resolve.panel(panelId);
      const before = await c.resolve.page(panel.pageId);
      const detail = await c.api.post<PageDetail>(`/api/pages/${panel.pageId}/layout/split`, { panelId: panel.id, dir });
      const added = detail.panels.map((p) => p.id).filter((id) => !before.panels.some((p) => p.id === id));
      c.out(detail, () => `split ${panel.id} (${dir}); new panel ${added.join(' ')}`);
    });

  page
    .command('merge')
    .description('merge two sibling panels; the first keeps its content, the second\'s images become its variants')
    .argument('<panelA>')
    .argument('<panelB>')
    .action(async (a: string, b: string) => {
      const c = await ctx();
      const panel = await c.resolve.panel(a);
      const detail = await c.api.post<PageDetail>(`/api/pages/${panel.pageId}/layout/merge`, { panelIdA: a, panelIdB: b });
      c.out(detail, () => `merged ${b} into ${a}`);
    });

  page
    .command('resize')
    .description('set the ratio of a split (see the paths in: manga page show)')
    .argument('<page>')
    .argument('<splitPath>', '"root" for the top split, or a/b steps from it such as "ab"')
    .argument('<ratio>', 'between 0 and 1; each side keeps at least 8%')
    .action(async (pageId: string, pathArg: string, ratioArg: string) => {
      const path = parseSplitPath(pathArg);
      const ratio = Number(ratioArg);
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new CliError(`ratio must be between 0 and 1, got "${ratioArg}"`, 2);
      const c = await ctx();
      const detail = await c.api.post<PageDetail>(`/api/pages/${enc(pageId)}/layout/resize`, { path, ratio });
      const node = nodeAt(detail.page.layout, path);
      const actual = node?.type === 'split' ? node.ratio : ratio;
      const label = path.length === 0 ? 'root' : path.join('');
      c.out(detail, () => `resized ${label} of ${detail.page.id}: ratio ${fixed(actual)}${actual === ratio ? '' : ` (clamped from ${ratioArg})`}`);
    });

  page
    .command('show')
    .description('panels in reading order with their rects, the splits, and the frame count')
    .argument('<page>')
    .action(async (pageId: string) => {
      const c = await ctx();
      const detail = await c.resolve.page(pageId);
      const manga = await mangaOf(c, detail);
      const order = readingOrder(detail.page.layout, manga.readingDirection);
      const rects = new Map(computeRects(detail.page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
      const splits = splitHandles(detail.page.layout, manga.pageFormat).map((s) => ({
        path: s.path.length === 0 ? 'root' : s.path.join(''), dir: s.dir, ratio: s.ratio,
      }));
      c.out({ ...detail, readingOrder: order, splits }, () => [
        `${detail.page.id}  ${detail.page.kind}  p${detail.page.order + 1}`,
        'panels (reading order)',
        ...order.map((id, i) => {
          const r = rects.get(id);
          const active = detail.panels.find((p) => p.id === id)?.activeImageId ?? '-';
          return `  ${i + 1}  ${id}  x=${fixed(r?.x ?? 0)} y=${fixed(r?.y ?? 0)} w=${fixed(r?.w ?? 0)} h=${fixed(r?.h ?? 0)}  image ${active}`;
        }),
        splits.length === 0 ? 'splits  none' : 'splits',
        ...splits.map((s) => `  ${s.path.padEnd(6)}${s.dir}  ${fixed(s.ratio)}`),
        `frames  ${detail.frames.length}`,
      ].join('\n'));
    });

  page
    .command('rm')
    .description('delete a page with its panels, images and text')
    .argument('<page>')
    .action(async (pageId: string) => {
      const c = await ctx();
      await c.api.delete(`/api/pages/${enc(pageId)}`);
      c.out({ ok: true, id: pageId }, () => `deleted ${pageId}`);
    });
}
```

In `packages/cli/src/program.ts`, add these imports next to the other command imports:

```ts
import { registerChapterCommands } from './commands/chapters.js';
import { registerCharacterCommands } from './commands/characters.js';
import { registerPageCommands } from './commands/pages.js';
```

and register them after `registerMangaCommands(program, ctx);`:

```ts
  registerCharacterCommands(program, ctx);
  registerChapterCommands(program, ctx);
  registerPageCommands(program, ctx);
```

- [ ] **Step 4: Run the CLI tests to verify they pass**

Run: `npx vitest run packages/cli`
Expected: PASS (all CLI test files; `cmd-structure.test.ts` has 3 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add character, chapter, page and layouts commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: CLI — `panel`, `text`, `jobs`, `cancel`

**Files:**
- Create: `packages/cli/src/commands/panels.ts`, `packages/cli/src/commands/text.ts`, `packages/cli/src/commands/jobs.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/cmd-panels-text-jobs.test.ts`

**Interfaces:**
- Consumes: `CliContext`, `CliError`, the `args.ts` parsers, `table`, `progressText`, `streamJobs`.
- Produces:
  - `registerPanelCommands(program, ctx)`:
    - `panel script <panel> [--action] [--shot] [--angle] [--background] [--chars a,b] [--line speaker:kind:text ...]`. With no options it shows the script. `--chars` replaces the cast in stage order: 1 → center; 2 → left, right; 3+ → left, center, right, …; existing pose, expression and position are kept. `--line` replaces the dialogue, and speaker `-` means none.
    - `panel variants <panel>`, `panel pick <panel> <image>`, `panel upload <panel> <file>`.
  - `formatScript`, `stagePositions`, `parseLine`.
  - `registerTextCommands(program, ctx)`:
    - `text add <page> --kind [--text] [--speaker] [--panel]`
    - `text edit <frame> [--text] [--kind] [--speaker|-] [--panel|-] [--font] [--size] [--box x,y,w,h] [--rotation] [--align]`
    - `text rm <frame>`
  - `registerJobCommands(program, ctx)`:
    - `jobs [--watch] [--status] [--limit 20]`: `--watch` prints the table once subscribed, then one line per job event, until Ctrl+C or `io.signal`.
    - `cancel <job>`.
  - `jobRow`, `jobLine`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cmd-panels-text-jobs.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chapter, Character, Job, Manga, PageDetail, Panel, TextFrame } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
let api: ApiClient;
let aiko: Character;
let ren: Character;
let detail: PageDetail;

beforeAll(async () => {
  h = await startHarness();
  api = new ApiClient(h.url);
  const manga = await api.post<Manga>('/api/mangas', { title: 'Oni Tales', readingDirection: 'ltr' });
  aiko = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Aiko' });
  ren = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Ren' });
  const chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title: 'One' });
  detail = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: 'splash' });
});
afterAll(async () => {
  await h.close();
});

const panelId = (): string => detail.panels[0]?.id ?? '';

describe('panel commands', () => {
  it('script shows the script and edits action, shot, cast and dialogue', async () => {
    expect((await h.run('panel', 'script', panelId())).stdout).toMatch(/^shot\s+medium$/m);
    const updated = await h.json<Panel>(
      'panel', 'script', panelId(), '--action', 'Aiko bows', '--shot', 'close', '--chars', 'Aiko,ren',
      '--line', 'Aiko:speech:Welcome!', '--line', '-:narration:Dawn: the market opens.',
    );
    expect(updated.script).toMatchObject({
      action: 'Aiko bows',
      shot: 'close',
      characters: [{ characterId: aiko.id, position: 'left' }, { characterId: ren.id, position: 'right' }],
      dialogue: [
        { speakerId: aiko.id, kind: 'speech', text: 'Welcome!' },
        { speakerId: null, kind: 'narration', text: 'Dawn: the market opens.' },
      ],
    });
    expect((await h.run('panel', 'script', panelId())).stdout).toContain(`  speech ${aiko.id}: Welcome!`);
    expect((await h.run('panel', 'script', panelId(), '--line', 'Aiko:yell:hi')).code).toBe(2);
    expect((await h.run('panel', 'script', panelId(), '--shot', 'sideways')).code).toBe(1);
    expect((await h.run('panel', 'script', panelId(), '--chars', 'Nobody')).code).toBe(1);
  });

  it('upload, variants and pick', async () => {
    const a = join(h.lib, 'a.png');
    const b = join(h.lib, 'b.png');
    writeFileSync(a, makePng(10, 20));
    writeFileSync(b, makePng(30, 40));
    const upA = await h.run('panel', 'upload', panelId(), a);
    expect(upA.stdout).toMatch(new RegExp(`^uploaded im_[a-z2-7]{10} \\(10x20\\), now active on ${panelId()}\\n$`));
    const first = /(im_[a-z2-7]{10})/.exec(upA.stdout)?.[1] ?? '';
    const second = /(im_[a-z2-7]{10})/.exec((await h.run('panel', 'upload', panelId(), b)).stdout)?.[1] ?? '';
    const variants = await h.run('panel', 'variants', panelId());
    expect(variants.stdout).toMatch(new RegExp(`^\\*\\s+${second}\\s+uploaded\\s+30x40`, 'm'));
    expect(variants.stdout).toMatch(new RegExp(`^\\s+${first}\\s+uploaded\\s+10x20`, 'm'));
    expect((await h.run('panel', 'pick', panelId(), first)).stdout).toBe(`active image of ${panelId()}: ${first}\n`);
    expect((await api.get<Panel>(`/api/panels/${panelId()}`)).activeImageId).toBe(first);
    expect((await h.run('panel', 'pick', panelId(), 'im_missing000')).code).toBe(1);
  });
});

describe('text commands', () => {
  it('add, edit and rm', async () => {
    const frame = await h.json<TextFrame>('text', 'add', detail.page.id, '--kind', 'speech', '--text', 'Hello', '--speaker', 'Aiko', '--panel', panelId());
    expect(frame).toMatchObject({ kind: 'speech', text: 'Hello', speakerId: aiko.id, panelId: panelId(), font: 'Shantell Sans', fontSize: 9 });
    const edited = await h.json<TextFrame>('text', 'edit', frame.id, '--text', 'Hi!', '--box', '0.1,0.1,0.4,0.15', '--speaker', '-', '--size', '10');
    expect(edited).toMatchObject({ text: 'Hi!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, speakerId: null, fontSize: 10 });
    expect((await h.run('text', 'edit', frame.id, '--speaker', 'ren')).stdout).toBe(`updated ${frame.id}  speech  "Hi!"\n`);
    expect((await h.run('text', 'edit', frame.id)).code).toBe(2);
    expect((await h.run('text', 'edit', frame.id, '--box', '1,2')).code).toBe(2);
    expect((await h.run('text', 'add', detail.page.id, '--kind', 'title', '--text', 'ONI')).code).toBe(1);
    expect((await h.run('text', 'add', detail.page.id)).code).toBe(2);
    expect((await h.run('text', 'rm', frame.id)).stdout).toBe(`deleted ${frame.id}\n`);
    expect((await h.run('text', 'rm', frame.id)).code).toBe(1);
  });
});

describe('job commands', () => {
  it('jobs lists, --watch streams until interrupted, and cancel stops a running job', async () => {
    const queue = h.server.deps.queue;
    queue.register('export.render', (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve(null));
    }));
    expect((await h.run('jobs')).stdout).toBe('no jobs\n');
    const job = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    await vi.waitFor(() => expect(h.server.deps.store.jobs.require(job.id).status).toBe('running'));
    expect((await h.run('jobs')).stdout).toMatch(new RegExp(`^${job.id}\\s+export\\.render\\s+cpu\\s+running`, 'm'));
    expect((await h.json<Job[]>('jobs', '--status', 'running')).map((j) => j.id)).toEqual([job.id]);
    expect((await h.run('jobs', '--status', 'stuck')).code).toBe(2);

    const ac = new AbortController();
    const watch = h.start(['jobs', '--watch'], ac.signal);
    await vi.waitFor(() => expect(watch.output()).toContain(job.id));
    expect((await h.run('cancel', job.id)).stdout).toBe(`${job.id}  cancelled\n`);
    await vi.waitFor(() => expect(watch.output()).toMatch(new RegExp(`^${job.id}\\s+export\\.render\\s+cpu\\s+cancelled`, 'm')));
    ac.abort();
    expect((await watch.result).code).toBe(0);
    expect((await h.run('cancel', 'jb_missing000')).code).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/cmd-panels-text-jobs.test.ts`
Expected: FAIL. `panel script` exits 2 with "unknown command 'panel'".

- [ ] **Step 3: Write the command groups**

`packages/cli/src/commands/panels.ts`:

```ts
import type { Command } from 'commander';
import { DialogueKindSchema, type Character, type DialogueLine, type Image, type Panel, type PanelScript } from '@manga/shared';
import { collect, parseList } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { table } from '../format.js';

type StagePosition = 'left' | 'center' | 'right';
const POSITIONS: readonly StagePosition[] = ['left', 'center', 'right'];

/** 1 → center; 2 → left, right; 3+ → left, center, right, left, … */
export function stagePositions(count: number): StagePosition[] {
  if (count === 1) return ['center'];
  if (count === 2) return ['left', 'right'];
  return Array.from({ length: count }, (_, i) => POSITIONS[i % POSITIONS.length] ?? 'center');
}

export function formatScript(script: PanelScript): string {
  return [
    `action      ${script.action || '-'}`,
    `shot        ${script.shot}`,
    `angle       ${script.angle}`,
    `background  ${script.background || '-'}`,
    `characters  ${script.characters.map((c) => `${c.characterId}@${c.position}`).join(' ') || '-'}`,
    script.dialogue.length === 0 ? 'dialogue    -' : 'dialogue',
    ...script.dialogue.map((line) => `  ${line.kind} ${line.speakerId ?? '-'}: ${line.text}`),
  ].join('\n');
}

/** "<speaker>:<kind>:<text>"; speaker "-" (or empty) for none. The text may contain colons. */
export async function parseLine(spec: string, speaker: (ref: string) => Promise<Character>): Promise<DialogueLine> {
  const match = /^([^:]*):([^:]*):(.+)$/s.exec(spec);
  if (match === null) throw new CliError(`a dialogue line is "<speaker>:<kind>:<text>" (speaker "-" for none), got "${spec}"`, 2);
  const [, who = '', kindText = '', text = ''] = match;
  const kind = DialogueKindSchema.safeParse(kindText.trim());
  if (!kind.success) throw new CliError(`dialogue kind must be one of ${DialogueKindSchema.options.join(', ')}, got "${kindText}"`, 2);
  const speakerRef = who.trim();
  const speakerId = speakerRef === '' || speakerRef === '-' ? null : (await speaker(speakerRef)).id;
  return { speakerId, kind: kind.data, text };
}

interface ScriptOptions { action?: string; shot?: string; angle?: string; background?: string; chars?: string; line: string[] }

export function registerPanelCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const panel = program.command('panel').description('panels: script, variants, pick, upload (prompt, generate and review come with AI imaging)');

  panel
    .command('script')
    .description('show the panel script, or change parts of it')
    .argument('<panel>')
    .option('--action <text>', 'what happens in the panel')
    .option('--shot <shot>', 'extreme-close, close, medium, wide or extreme-wide')
    .option('--angle <angle>', 'eye, low, high, dutch or overhead')
    .option('--background <text>', 'background description')
    .option('--chars <list>', 'comma-separated character names or ids, in stage order (replaces the cast)')
    .option('--line <speaker:kind:text>', 'dialogue line, repeatable (replaces the dialogue); speaker "-" for none', collect, [] as string[])
    .action(async (panelId: string, opts: ScriptOptions) => {
      const c = await ctx();
      const current = await c.resolve.panel(panelId);
      const changing = [opts.action, opts.shot, opts.angle, opts.background, opts.chars].some((v) => v !== undefined) || opts.line.length > 0;
      if (!changing) {
        c.out(current.script, () => formatScript(current.script));
        return;
      }
      const { page } = await c.resolve.page(current.pageId);
      const castMember = (ref: string): Promise<Character> => c.resolve.character(ref, page.mangaId);
      const script: Record<string, unknown> = { ...current.script };
      if (opts.action !== undefined) script['action'] = opts.action;
      if (opts.shot !== undefined) script['shot'] = opts.shot;
      if (opts.angle !== undefined) script['angle'] = opts.angle;
      if (opts.background !== undefined) script['background'] = opts.background;
      if (opts.line.length > 0) {
        const lines: DialogueLine[] = [];
        for (const spec of opts.line) lines.push(await parseLine(spec, castMember));
        script['dialogue'] = lines;
      }
      if (opts.chars !== undefined) {
        const cast = await Promise.all(parseList(opts.chars).map(castMember));
        const positions = stagePositions(cast.length);
        script['characters'] = cast.map((member, i) => {
          const previous = current.script.characters.find((pc) => pc.characterId === member.id);
          return {
            characterId: member.id,
            pose: previous?.pose ?? '',
            expression: previous?.expression ?? '',
            position: previous?.position ?? positions[i] ?? 'center',
          };
        });
      }
      const updated = await c.api.patch<Panel>(`/api/panels/${current.id}`, { script });
      c.out(updated, () => formatScript(updated.script));
    });

  panel
    .command('variants')
    .description("list the panel's images; * marks the active one")
    .argument('<panel>')
    .action(async (panelId: string) => {
      const c = await ctx();
      const current = await c.resolve.panel(panelId);
      const images = await c.api.get<Image[]>(`/api/panels/${current.id}/images`);
      c.out(images, () =>
        images.length === 0
          ? 'no images yet'
          : table(images.map((im) => [im.id === current.activeImageId ? '*' : ' ', im.id, im.source, `${im.width}x${im.height}`, im.createdAt])),
      );
    });

  panel
    .command('pick')
    .description('make one of the variants the active image')
    .argument('<panel>')
    .argument('<image>', 'image id')
    .action(async (panelId: string, imageId: string) => {
      const c = await ctx();
      const updated = await c.api.patch<Panel>(`/api/panels/${encodeURIComponent(panelId)}`, { activeImageId: imageId });
      c.out(updated, () => `active image of ${updated.id}: ${imageId}`);
    });

  panel
    .command('upload')
    .description('upload your own art (PNG or JPEG); it becomes the active image')
    .argument('<panel>')
    .argument('<file>', 'PNG or JPEG file')
    .action(async (panelId: string, file: string) => {
      const c = await ctx();
      const image = await c.api.upload<Image>(`/api/panels/${encodeURIComponent(panelId)}/upload`, file);
      c.out(image, () => `uploaded ${image.id} (${image.width}x${image.height}), now active on ${panelId}`);
    });
}
```

`packages/cli/src/commands/text.ts`:

```ts
import type { Command } from 'commander';
import type { TextFrame } from '@manga/shared';
import { parseBox, parseNumber, parsePositiveNumber } from '../args.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';

interface EditOptions {
  text?: string; kind?: string; speaker?: string; panel?: string; font?: string; size?: number;
  box?: { x: number; y: number; w: number; h: number }; rotation?: number; align?: string;
}

export function registerTextCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const text = program.command('text').description('text frames: speech, thought, shout, narration, sfx, title');

  text
    .command('add')
    .description('add a text frame to a page (auto-placed in its panel, or on the page)')
    .argument('<page>')
    .requiredOption('--kind <kind>', 'speech, thought, shout, narration, sfx, or title (covers only)')
    .option('--text <text>', 'the text', '')
    .option('--speaker <char>', 'character name or id')
    .option('--panel <panel>', 'anchor panel id')
    .action(async (pageId: string, opts: { kind: string; text: string; speaker?: string; panel?: string }) => {
      const c = await ctx();
      const target = await c.resolve.page(pageId);
      const speakerId = opts.speaker === undefined ? null : (await c.resolve.character(opts.speaker, target.page.mangaId)).id;
      const frame = await c.api.post<TextFrame>(`/api/pages/${target.page.id}/frames`, {
        kind: opts.kind, text: opts.text, panelId: opts.panel ?? null, speakerId,
      });
      c.out(frame, () => `created ${frame.id}  ${frame.kind}  "${frame.text}"`);
    });

  text
    .command('edit')
    .description('change a text frame')
    .argument('<frame>')
    .option('--text <text>', 'the text')
    .option('--kind <kind>', 'speech, thought, shout, narration, sfx or title')
    .option('--speaker <char>', 'character name or id; "-" to clear')
    .option('--panel <panel>', 'anchor panel id; "-" to clear')
    .option('--font <font>', 'font family')
    .option('--size <pt>', 'font size in points', parsePositiveNumber)
    .option('--box <x,y,w,h>', 'page-normalized box, e.g. 0.1,0.1,0.3,0.12', parseBox)
    .option('--rotation <deg>', 'rotation in degrees', parseNumber)
    .option('--align <align>', 'left, center or right')
    .action(async (frameId: string, opts: EditOptions) => {
      const given = [opts.text, opts.kind, opts.speaker, opts.panel, opts.font, opts.size, opts.box, opts.rotation, opts.align];
      if (given.every((v) => v === undefined)) throw new CliError('nothing to change; pass at least one option (see: manga text edit --help)', 2);
      const c = await ctx();
      const frame = await c.resolve.frame(frameId);
      const patch: Record<string, unknown> = {};
      if (opts.text !== undefined) patch['text'] = opts.text;
      if (opts.kind !== undefined) patch['kind'] = opts.kind;
      if (opts.font !== undefined) patch['font'] = opts.font;
      if (opts.size !== undefined) patch['fontSize'] = opts.size;
      if (opts.box !== undefined) patch['box'] = opts.box;
      if (opts.rotation !== undefined) patch['rotation'] = opts.rotation;
      if (opts.align !== undefined) patch['align'] = opts.align;
      if (opts.panel !== undefined) patch['panelId'] = opts.panel === '-' ? null : opts.panel;
      if (opts.speaker !== undefined) {
        if (opts.speaker === '-') {
          patch['speakerId'] = null;
        } else {
          const { page } = await c.resolve.page(frame.pageId);
          patch['speakerId'] = (await c.resolve.character(opts.speaker, page.mangaId)).id;
        }
      }
      const updated = await c.api.patch<TextFrame>(`/api/frames/${frame.id}`, patch);
      c.out(updated, () => `updated ${updated.id}  ${updated.kind}  "${updated.text}"`);
    });

  text
    .command('rm')
    .description('delete a text frame')
    .argument('<frame>')
    .action(async (frameId: string) => {
      const c = await ctx();
      await c.api.delete(`/api/frames/${encodeURIComponent(frameId)}`);
      c.out({ ok: true, id: frameId }, () => `deleted ${frameId}`);
    });
}
```

`packages/cli/src/commands/jobs.ts`:

```ts
import type { Command } from 'commander';
import { JobStatusSchema, type Job } from '@manga/shared';
import { parseNonNegativeInt } from '../args.js';
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
    .option('--limit <n>', 'how many jobs to list', parseNonNegativeInt, 20)
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
```

Replace `packages/cli/src/program.ts` with its final M1 content:

```ts
import { Command, CommanderError } from 'commander';
import { registerChapterCommands } from './commands/chapters.js';
import { registerCharacterCommands } from './commands/characters.js';
import { registerJobCommands } from './commands/jobs.js';
import { registerMangaCommands } from './commands/mangas.js';
import { registerPageCommands } from './commands/pages.js';
import { registerPanelCommands } from './commands/panels.js';
import { registerServerCommands } from './commands/server.js';
import { registerTextCommands } from './commands/text.js';
import { createContext, type CliContext } from './context.js';
import { CliError } from './errors.js';
import { processIo, type CliIo } from './io.js';
import { VERSION } from './version.js';

export interface GlobalOptions { json?: boolean; wait?: boolean; url?: string }
export type ContextFactory = (opts: GlobalOptions, io: CliIo) => Promise<CliContext>;

export const defaultContextFactory: ContextFactory = (opts, io) =>
  createContext({ json: opts.json === true, wait: opts.wait === true, url: opts.url, io });

export function buildProgram(io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Command {
  const program = new Command('manga')
    .description('Manga Builder from the command line')
    .version(VERSION)
    .option('--json', 'print raw API data as JSON')
    .option('--wait', 'wait for started jobs to finish, streaming progress to stderr')
    .option('--url <baseUrl>', 'server URL (default: <library>/server.json, else http://127.0.0.1:4317); never auto-starts')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });
  let context: Promise<CliContext> | null = null;
  const ctx = (): Promise<CliContext> => (context ??= factory(program.opts<GlobalOptions>(), io));
  registerServerCommands(program, ctx, io);
  registerMangaCommands(program, ctx);
  registerCharacterCommands(program, ctx);
  registerChapterCommands(program, ctx);
  registerPageCommands(program, ctx);
  registerPanelCommands(program, ctx);
  registerTextCommands(program, ctx);
  registerJobCommands(program, ctx);
  return program;
}

/** 0 for help/version; 2 for usage errors; the CliError's code; 1 for everything else (message on stderr). */
export function exitCodeFor(err: unknown, io: CliIo): number {
  if (err instanceof CommanderError) {
    return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2;
  }
  if (err instanceof CliError) {
    if (!err.silent) io.stderr(`error: ${err.message}\n`);
    return err.exitCode;
  }
  io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

export async function runCli(argv: readonly string[], io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Promise<number> {
  try {
    await buildProgram(io, factory).parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    return exitCodeFor(err, io);
  }
}
```

- [ ] **Step 4: Run the CLI tests to verify they pass**

Run: `npx vitest run packages/cli`
Expected: PASS (all CLI test files; `cmd-panels-text-jobs.test.ts` has 4 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add panel, text, jobs and cancel commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: README and end-to-end verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: the setup guide and CLI quick reference, and a verified M1 build: tests, types, a real auto-start from the built CLI, and `npm run link-cli`.

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# Manga Builder

A personal, local tool for making manga with AI. It keeps character art consistent, builds chapters from a prompt with review points, and handles page layouts, lettering in text frames (never inside the art), and PNG/PDF export. Every action is also available from the `manga` CLI.

**Status: milestone M1 (foundation).** Everything that does not need an AI engine or a GPU already works from the REST API and the CLI: mangas, characters, chapters, pages and layouts, panels, text frames, image uploads and the job queue. AI imaging (M2), the web UI (M3), and the episode workflow and export (M4) are next.

## Requirements

- Windows 11. The commands below are for Git Bash.
- Node.js 22 or newer (developed on 25.2.1) and npm 11.
- Visual Studio C++ build tools, only if `better-sqlite3` has no prebuilt binary for your Node version.

## Setup

```bash
npm install
# check that the SQLite native module loads on this Node version:
node --input-type=module -e "import Database from 'better-sqlite3'; console.log('sqlite', new Database(':memory:').prepare('select sqlite_version() as v').get().v)"
npm run build
npm run link-cli        # puts `manga` on your PATH (undo: npm unlink -g @manga/cli)
```

If the check fails with a "bindings" or "compiled against a different Node.js version" error, run `npm rebuild better-sqlite3` and check again.

## Running

```bash
npm start               # or: manga serve [--open]
```

The server listens on `http://127.0.0.1:4317`, on loopback only. You rarely need to start it by hand: when no server is running, any other `manga` command starts one in the background. That server runs without a window and logs to `<library>/logs/server.log`.

## Configuration

`%USERPROFILE%\.manga-builder\config.json` is optional, and so is every key in it:

```json
{
  "libraryPath": "C:/Users/you/MangaBuilder",
  "port": 4317,
  "comfyRoot": "C:/Users/roman/Dev/Exalink/claude-image-gen",
  "comfyUrl": "http://127.0.0.1:8188",
  "ollamaUrl": "http://127.0.0.1:11434",
  "claudeBin": "claude"
}
```

The environment variables `MANGA_LIBRARY` and `MANGA_PORT` override `libraryPath` and `port`. Everything else lives in the database: engines per task, models and review settings. Change it with `manga engine …` or `PATCH /api/settings`.

Keep the library out of OneDrive-synced folders such as Documents, because syncing corrupts SQLite.

## Library folder

```
<library>/library.sqlite                       all data (SQLite, WAL mode)
<library>/server.json                          {pid, port, startedAt} of the running server
<library>/mangas/<mangaId>/images/<id>.png     uploaded and generated images
<library>/exports/                             PNG/PDF exports (M4)
<library>/logs/server.log                      output of an auto-started server
<library>/tmp/, <library>/.claude-cwd/         scratch folders
```

## CLI quick reference

These global flags work before or after the command:

- `--json` prints raw API data.
- `--wait` streams job progress until the started jobs finish.
- `--url <baseUrl>` talks to one specific server and never auto-starts one.

References take an id or a unique name or title, case-insensitive. A chapter can also be given as `<manga>/<number>`, e.g. `"Night Market/1"`.

| Command | What it does |
|---|---|
| `manga serve [--open]` | Run the server in this terminal |
| `manga status` | Server, engines, ComfyUI and queue status |
| `manga engine [claude\|local] [--task story=local …]` | Show or set the AI engine; `task=default` clears an override |
| `manga create "<title>" [--lang en\|uk] [--color bw\|color] [--dir rtl\|ltr] [--style <preset>]` | Create a manga |
| `manga list` · `manga show <manga>` · `manga rm <manga>` | List, inspect (characters, chapters, pages, panel ids) or delete |
| `manga character add <manga> --name … [--role] [--appearance] [--personality] [--speech] [--seed]` | Add a character |
| `manga character upload <char> <file> --slot portrait\|fullbody\|side\|back` | Use your own reference image |
| `manga character pick <char> <image> [--slot portrait]` | Point a reference slot at one of the character's images |
| `manga chapter add <manga> "<title>"` · `chapter list <manga>` · `chapter rm <chapter>` | Chapters |
| `manga layouts` | The 16 layout presets |
| `manga page add <chapter> [--layout 2x2] [--at <index>]` | Add a page |
| `manga page layout <page> <preset> [--confirm]` | Apply a preset. Panels map in reading order. Without `--confirm` it refuses to drop panels and lists them |
| `manga page split <panel> h\|v` · `page merge <a> <b>` · `page resize <page> <root\|ab…> <ratio>` | Edit the layout |
| `manga page show <page>` · `page rm <page>` | Inspect (reading order, rects, split paths) or delete |
| `manga panel script <panel> [--action] [--shot] [--angle] [--background] [--chars a,b] [--line "Aiko:speech:Hi!" …]` | Show or edit the panel script |
| `manga panel variants <panel>` · `panel pick <panel> <image>` · `panel upload <panel> <file>` | Panel images |
| `manga text add <page> --kind speech --text "…" [--speaker <char>] [--panel <panel>]` | Add a text frame |
| `manga text edit <frame> [--text] [--box x,y,w,h] [--speaker <char>\|-] …` · `text rm <frame>` | Edit or delete a text frame |
| `manga jobs [--watch] [--status <s>]` · `manga cancel <job>` | Background jobs |

The exit code is `0` on success, `1` for API or validation errors (the message goes to stderr), and `2` for usage errors.

## Development

```bash
npm test                # vitest over all packages, against the TypeScript sources
npm run typecheck       # tsc --build --force
npm run dev             # tsc --build --watch
```

The packages are `@manga/shared` (schemas, layout engine and prompt helpers, safe for browsers), `@manga/server` (Fastify, SQLite, jobs) and `@manga/cli` (`manga`). `docs/superpowers/` holds the design spec and the milestone plans.
````

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS. All test files in `packages/shared/test`, `packages/server/test` and `packages/cli/test` pass, with 0 failures.

- [ ] **Step 3: Type-check everything from scratch**

Run: `npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 4: Smoke-test the built CLI with a real auto-start**

Run (Git Bash; a throwaway library on a spare port):

```bash
npm run build
export MANGA_LIBRARY="$(cygpath -w "$(mktemp -d)")"; export MANGA_PORT=4399
node packages/cli/dist/index.js list
cat "$MANGA_LIBRARY/server.json"
node packages/cli/dist/index.js create "Smoke Test" --dir ltr
node packages/cli/dist/index.js chapter add "smoke test" "One"
node packages/cli/dist/index.js page add "Smoke Test/1" --layout 2x2
node packages/cli/dist/index.js show "smoke test"
node packages/cli/dist/index.js status
node -e "process.kill(require(process.env.MANGA_LIBRARY + '/server.json').pid)"
unset MANGA_LIBRARY MANGA_PORT
```

Expected:
- The first `list` takes a second or two, because it starts the server, and then prints `no mangas yet; create one with: manga create "<title>"`.
- `server.json` shows `"port": 4399`.
- `show` prints the manga, `#1 … One draft` and `p1 pg_… pn_… pn_… pn_… pn_…`.
- `status` prints `server  http://127.0.0.1:4399`, then three `down  not configured` lines and `queue   0 queued, 0 running`.
- No console window appears at any point.

- [ ] **Step 5: Link the CLI globally**

Run: `npm run link-cli && manga --version`
Expected: `0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup, configuration and CLI quick reference" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing this plan)

- **Spec coverage (M1 scope).**
  - §3.1 packages: shared, server and cli are covered. UI serving is in Task 14.
  - §3.2 store/api: Tasks 8, 9 and 14–17. Engines, imaging, workflows and export are M2 and M4.
  - §3.3 lifecycle: `server.json` (Task 14), auto-start (Task 18) and config (Task 7).
  - §4 data model: every entity has a table and a repo (Task 8), including episode runs and jobs.
  - §5 layout engine: Tasks 3–5, and presets on pages in Task 12, including the confirm rule.
  - §6.2 sizes and §6.3 prompt assembly: Task 6.
  - §7 queue: lanes, retries, cancel, resume and pause are in Task 11. The GPU arbiter is in Task 10; the ComfyUI and ollama releasers are M2.
  - §9.3 fonts and default frames: Tasks 6 and 13.
  - §12 CLI: every non-AI command (Tasks 19–21). `character generate|sheet`, `panel prompt|generate|review`, `text auto`, `episode` and `export` belong to M2 and M4.
  - §13 error handling: the M1 rows (validation and 404) are in Task 14.
  - §14 testing: layout, prompt and size unit tests; queue lanes, retry, cancel and resume; server routes against a temp library; a real WebSocket test.
- **Placeholders:** none. Every code step shows the full file or the exact lines to add.
- **Type consistency:** these names were checked across tasks:
  - `Store`/`Repo` methods;
  - `NeedsConfirmError.removedPanelIds`;
  - `CoreDeps`, `AppModule`, `RunningServer` and `startServer({ config, modules, uiDir })`;
  - `CliContext { api, json, wait, baseUrl, io, out, waitJobs, resolve }`;
  - `ensureServer({ url, config, deps, timeoutMs })`;
  - `register*Commands(program, ctx)` and `registerServerCommands(program, ctx, io)`.
- **Review Focus:** each of its five items has a pinning test, in Tasks 12/16/20 (preset confirm), 15 (bad uploads), 18 (stale `server.json` and auto-start), 18 (ambiguous and case-insensitive references) and 13 (reading-direction change).
