# Manga Builder — Design

**Date:** 2026-09-27 · **Status:** approved in conversation, awaiting written-spec review
**Sub-project:** 2 of 2. Depends on sub-project 1, the image-generation upgrade in `claude-image-gen` (see `claude-image-gen/docs/superpowers/specs/2026-09-27-manga-models-upgrade-design.md`).

## 1. Purpose and success criteria

A personal, local tool for making manga with AI. Roman uses it himself; it is not a product.

**v1 is done when** a working MVP covers the full workflow:

1. Create a manga and its characters, with consistent character art.
2. Create a chapter from a single prompt. The workflow goes step by step with review points: premise → outline → pages → panel scripts → image prompts → images → lettering.
3. Edit any page: layout, panel images, text frames.
4. Export the chapter to PNG or PDF.
5. Every one of these actions is also possible from a CLI.

**Core rule:** panel images never contain text. All text lives in text frames overlaid on the art, so it stays correct, readable and free of AI artifacts.

## 2. Decisions (from the Q&A)

| Topic | Decision |
|---|---|
| Colour | Setting per manga: B&W (screentone) or colour |
| Page format | Printed-manga pages, one fixed size: B5, 182×257 mm, exported at 300 dpi = 2150×3035 px |
| Reading direction | Setting per manga: RTL or LTR |
| Language | Setting per manga: English or Ukrainian. No translation layer in v1 |
| Style | A style guide per manga (generation setup, style prompt, negative prompt, style LoRAs), applied to every generation |
| Layout | Presets plus split, merge (siblings only) and resize. Rectangular panels only |
| Character consistency | Saved appearance tags + seed + reference images. Reference-guided generation uses noobIPA, Qwen-Image-Edit-2511 or FLUX.2 klein |
| Image pipeline | The AI writes the prompts; the app calls ComfyUI directly; an optional AI review step flags bad images for a retry |
| Image setup | Manga-builder owns its ComfyUI graph builders. It shares the ComfyUI install and the model files in `claude-image-gen` and never copies models |
| AI engines | Claude through the `claude` CLI (subscription). Local through **direct** ollama calls. Engine-switch code is copied from cleopatra |
| Engine switch | Global setting plus a per-task override |
| GPU | Local mode runs in phases: text first, unload, then images |
| Episode flow | Stops at review points by default; a "Run to end" button runs the rest unattended |
| Text frames | Speech, thought, shout, narration and SFX, plus title (covers only). Auto-placed, then adjusted by hand |
| Covers | Title rendered as overlay text, not inside the image |
| Export | PNG per page, and PDF per page or per chapter |
| CLI | Scriptable subcommands with `--json`. A thin client of the server, which it auto-starts |
| Stack | Same as cleopatra: TypeScript (ESM, strict), Node ≥ 22, npm workspaces, Fastify 5, React 19 + Vite, SQLite (better-sqlite3), zod 4, vitest, Playwright |
| Data location | Library folder, default `%USERPROFILE%\MangaBuilder`. **Not** under Documents, which is synced by OneDrive and would corrupt SQLite |
| Users | Single user, no auth, bound to 127.0.0.1. Windows-first |

### Not in v1

- Webtoon or vertical-scroll format.
- Translation layer (one language per manga).
- Per-character LoRA training.
- Slanted or irregular panels.
- Merging non-sibling panels.
- CBZ export.
- Bleed and print marks.
- Mobile layout.
- Multiple users.

## 3. Architecture

```
 UI (React) ──HTTP + WebSocket──┐
                                ├──► server (single process, 127.0.0.1:4317)
 manga CLI ──HTTP + WebSocket───┘       ├─ store: SQLite + image files (library folder)
   (auto-starts server if down)         ├─ job queue + worker ──► GPU scheduler
                                        ├─ engines: claude CLI | ollama
                                        ├─ imaging: ComfyUI client + recipes
                                        └─ episode workflow + export (Playwright)
```

**Why a single server.** Exactly one process owns the GPU, the database and the queue. That means no write races or worker locks, and a job started from the CLI shows live progress in the UI.

### 3.1 Packages (npm workspaces)

| Package | Responsibility |
|---|---|
| `packages/shared` | zod schemas and types for every entity and API DTO; layout-tree operations (pure functions, used by UI and server); layout presets; prompt-assembly helpers |
| `packages/server` | Fastify REST API and WebSocket events; store; jobs; engines; imaging; episode workflow; export; serves the built UI |
| `packages/cli` | The `manga` binary: argument parsing, HTTP client, WebSocket progress, auto-start of the server |
| `packages/ui` | React 19 + Vite SPA, plus the print render route used by export |

### 3.2 Server modules (`packages/server/src/`)

- **`store/`** — better-sqlite3 in WAL mode. Numbered SQL migrations, one repository per entity. JSON columns are validated with zod on read.
- **`engines/`** — copied from cleopatra and trimmed.
  - `claude.ts` spawns `claude -p` with stream-json output. Cleopatra's rules carry over:
    - Never set `ANTHROPIC_*` env vars, so the subscription auth is used.
    - Run in an isolated empty cwd (`<library>/.claude-cwd`, which has no CLAUDE.md).
    - `--strict-mcp-config` with an empty MCP config.
    - All tools disabled, except `Read` for the review task, which also gets `--add-dir <library>/mangas`.
  - `ollama.ts` calls the native `/api/chat`:
    - `format: <JSON schema>` for structured output.
    - `think: false`.
    - `images` for vision.
  - `structured.ts` handles both engines: prompt → extract JSON → zod `safeParse` → one correction round → fail.
  - `quota.ts` reads `rate_limit_event` from the Claude stream.
- **`imaging/`**
  - `comfy.ts`: ComfyUI HTTP and WebSocket client. Endpoints used:
    - `/system_stats` for health.
    - `/upload/image` for reference and init images.
    - `/prompt` to queue work.
    - `/ws` for progress.
    - `/history/{id}` and `/view` to fetch results.
    - `/free` to unload models.
    - `/interrupt` to cancel a running job.
  - `launcher.ts` starts ComfyUI detached if it is down. It runs `claude-image-gen/ComfyUI/.venv/Scripts/python.exe ComfyUI/main.py --port 8188 --listen 127.0.0.1 --fast` and logs to `ComfyUI/server.log`, exactly as `gen.py` does.
  - `recipes/`: one TypeScript graph builder per generation setup (§6).
- **`jobs/`** — a durable queue in SQLite plus a worker, with resource lanes (§7).
- **`workflows/episode/`** — the step pipeline (§8). Step prompts live in `prompts/*.md`.
- **`export/`** — Playwright Chromium renders the UI print route to PNG or PDF (§10).
- **`api/`** — REST routes, and the WebSocket at `/api/events`.

### 3.3 Server lifecycle

- `manga serve [--open]`, or `npm start`, starts the server.
- On start it writes `<library>/server.json` containing `{pid, port, startedAt}`.
- The CLI reads that file, probes `GET /api/health`, and if the server is not reachable it spawns it detached and hidden, then waits for health (up to 30 s).
- Config lives in `%USERPROFILE%\.manga-builder\config.json`: `libraryPath`, `port`, `comfyRoot` (default `C:/Users/roman/Dev/Exalink/claude-image-gen`), `comfyUrl` (default `http://127.0.0.1:8188`) and `ollamaUrl` (default `http://127.0.0.1:11434`).
- Everything else is stored in the settings table.

## 4. Data model

IDs are short, prefixed random strings: `mg_`, `cr_`, `ch_`, `pg_`, `pn_`, `tf_`, `im_`, `jb_`, `er_`. All timestamps are ISO strings. Geometry is normalized to 0..1 of the page (or of the panel, for image transforms), so it is independent of resolution.

- **Manga**
  - Core fields: `id`, `title`, `synopsis`, `language: 'en'|'uk'`, `colorMode: 'bw'|'color'`, `readingDirection: 'rtl'|'ltr'`.
  - `pageFormat`: `{widthMm:182, heightMm:257, dpi:300, marginsMm:{top:12,bottom:12,inner:10,outer:10}, gutterColMm:3, gutterRowMm:6, borderMm:0.8}`.
  - `styleGuide`: `{recipe, stylePrompt, negativePrompt, loras:[{name,strength}]}`.
  - `coverPageId`, `createdAt`, `updatedAt`.
- **Character** (belongs to a manga)
  - Identity: `id`, `mangaId`, `name`, `role: 'main'|'supporting'|'minor'`, `personality`, `speechStyle`.
  - Generation: `appearanceTags` (canonical tag string, inserted verbatim into every prompt), `seed`, `recipe`.
  - Images: `refs: {portrait?:imageId, fullbody?:imageId, side?:imageId, back?:imageId}`.
- **Chapter**
  - `id`, `mangaId`, `number`, `title`, `synopsis`, `coverPageId`.
  - `status: 'draft'|'generating'|'ready'`, `order`.
- **Page**
  - `id`, `chapterId` (null for a manga cover), `kind: 'page'|'cover'`, `order`.
  - `layout: LayoutNode`, where `LayoutNode = {type:'panel', id} | {type:'split', dir:'h'|'v', ratio:number, a:LayoutNode, b:LayoutNode}`.
  - Every panel id in the tree has a Panel row.
  - A cover is a page with a single panel.
- **Panel** (keyed by its layout-leaf id)
  - `id`, `pageId`.
  - `script: {action, shot:'extreme-close'|'close'|'medium'|'wide'|'extreme-wide', angle:'eye'|'low'|'high'|'dutch'|'overhead', characters:[{characterId, pose, expression, position:'left'|'center'|'right'}], background, dialogue:[{speakerId|null, kind:'speech'|'thought'|'shout'|'narration'|'sfx', text}]}`.
  - `prompt: {scene, negative}` — the AI writes `scene`. The final prompt is assembled (§6.3).
  - `recipe` (null means use the manga's default), `seedLock:boolean`, `seed`, `refCharacterIds[]`.
  - `activeImageId`, `imageTransform: {x, y, scale}` (pan and zoom within the panel; cover-fit by default).
- **TextFrame**
  - `id`, `pageId`, `panelId?` (anchor for reading order and auto-placement), `kind: 'speech'|'thought'|'shout'|'narration'|'sfx'|'title'`, `text`, `speakerId?`.
  - Geometry: `box: {x,y,w,h}` in page-normalized units, `tail?: {x,y}` (page-normalized tip point), `rotation`.
  - Text: `font`, `fontSize` (pt), `autoFit:boolean`, `align`, `order`.
- **Image** — every generated or uploaded image.
  - `id`, `ownerType: 'character'|'panel'`, `ownerId`, `role?` (`portrait|fullbody|side|back` for character refs), `path` (relative to the library), `width`, `height`.
  - `source: 'generated'|'uploaded'|'upscaled'`, `parentImageId?` (for upscales).
  - `gen: {recipe, prompt, negative, seed, steps, cfg, size, loras, refs:[imageId], control?, comfyPromptId, durationMs}`.
  - `review?: {engine, pass, issues:[{kind:'character-count'|'identity'|'anatomy'|'text'|'script-mismatch'|'other', note}], at}`.
  - `createdAt`.
  - Owners point at their active image; all other images for the same owner are its variants.
- **Job**
  - `id`, `kind: 'image.generate'|'image.review'|'image.upscale'|'character.refs'|'llm.step'|'export.render'`.
  - `lane: 'gpu'|'claude'|'cpu'`, `status: 'queued'|'running'|'succeeded'|'failed'|'cancelled'`.
  - `priority`, `payload`, `result`, `error`, `attempts`, `maxAttempts`, `nextRunAt`.
  - `progress: {label, value?, max?}`, `episodeRunId?`, `createdAt`, `startedAt`, `finishedAt`.
- **EpisodeRun**
  - `id`, `chapterId`, `input: {prompt, characterIds[], pages, tone}`, `mode: 'review'|'autopilot'`.
  - `steps: [{name, status:'pending'|'running'|'awaiting-review'|'done'|'failed', output?, error?, startedAt?, finishedAt?}]`, `currentStep`, `createdAt`.
- **Settings** (key/value)
  - `engine.mode: 'claude'|'local'`.
  - `engine.tasks: {story?, prompts?, dialogue?, review?}` (per-task override).
  - `claude.models: {story:'opus', dialogue:'opus', prompts:'sonnet', review:'sonnet'}`.
  - `ollama.textModel: 'qwen3:14b'`, `ollama.visionModel: 'qwen3-vl:8b'`.
  - `review: {autoInEpisode:true, rounds:2}`.

**Files** live under `<library>/mangas/<mangaId>/images/<imageId>.png`. Deleting an entity cascades in SQL, and the image files of deleted Image rows are removed in the same operation.

## 5. Layout engine (`packages/shared/src/layout/`)

- **Guillotine split tree.**
  - `computeRects(tree, pageFormat) → {panelId, rect}[]` applies margins, gutters and ratios.
  - Horizontal gutters (between rows) use `gutterRowMm`; vertical gutters use `gutterColMm`.
- **Operations**, all pure and all returning a new tree:
  - `split(panelId, dir, newId)`
  - `resize(splitPath, ratio)` clamps each side to a minimum of 8% of the parent.
  - `merge(panelIdA, panelIdB)`, allowed only if A and B are the two leaves of the same split. It keeps A's id and A's content.
  - `readingOrder(tree, direction)`: depth-first, top before bottom. For vertical splits, right before left in RTL and left before right in LTR.
- **Presets.** About 16 named trees:
  - `splash`
  - `2-rows`, `3-rows`, `4-rows`
  - `2x2`, `2x3`
  - `big-top-2`, `big-top-3`, `big-bottom-2`, `2-big-bottom`
  - `left-tall-2`, `right-tall-2`
  - `3-rows-mid-split`, `row-2-1-2`, `cinematic-3`, `5-stagger`

  Each preset is defined once; `mirror()` produces the RTL variant, since presets are authored LTR.
- **Applying a preset** to a page that has content maps existing panels to new ones in reading order. Panels left without a slot are deleted, and the API requires `confirm=true` when that would happen.

## 6. Imaging

### 6.1 Recipes (generation setups)

A recipe is `build(params) → ComfyUI API graph`, plus metadata: `id`, `label`, `supportsRefs` (max count), `supportsPose`, `supportsLoras`, `sizeBuckets`, `defaultSteps` / `cfg` / `sampler`.

Settings are **ported from the `gen.py` presets validated in sub-project 1**. Where the bake-off (`claude-image-gen/docs/BAKEOFF.md`) produces better defaults, they are copied here.

| Recipe | Base | Refs | Use |
|---|---|---|---|
| `anime` | WAI-illustrious v17 (SDXL) | — | Default panel art; colour or B&W (with manga LoRAs) |
| `anime-ref` | WAI + noobIPA + CLIP-ViT-bigG (IPAdapter_plus) | 1–2 images, one character | Single-character panels and character sheets |
| `anime-pose` | WAI + noob_openpose ControlNet | optional | Pose-driven panels (a pose image uploaded by the user) |
| `qwen-edit-ref` | Qwen-Image-Edit-2511 Q5 + Lightning 8-step | up to 3 images | Multi-character panels; retry when identity drifts; side and back views |
| `klein-ref` | FLUX.2 klein 4B fp8 | multiple | Fast alternative reference path (chosen per the bake-off) |
| `anima` / `anima-turbo` | Anima v1.1 + optional LLLite pose/lineart | — | Alternative style engine |
| `anime-refine` | WAI img2img, denoise ≈0.3 + manga LoRA | init image | Restores ink and screentone look after `qwen-edit-ref` / `klein-ref` |
| `upscale` | 4x-AnimeSharp | init image | Upscaling for print at export |

**Default routing per panel** (can be overridden per manga and per panel):

| Panel content | Recipe |
|---|---|
| 0 characters | `anime` |
| 1 character with refs | `anime-ref` |
| ≥ 2 characters with refs | `klein-ref` (grey-shaded in B&W; no refine pass: `bwRefine` is null) |
| Identity drift on retry | `qwen-edit-ref` (`driftFallback`; only when the panel has portrait refs) |

Roman chose mixed routing after the bake-off (2026-09-30): only `multiChar` moved, from `qwen-edit-ref` to `klein-ref`. The routing function reads these from settings, so a library can switch any of them in Settings → Routing.

### 6.2 Sizes

Generate at the SDXL bucket closest to the panel's aspect ratio. The buckets are 1024×1024, 896×1152, 832×1216, 768×1344, 640×1536, 1152×896, 1216×832, 1344×768 and 1536×640; Qwen and klein use the same aspect ratios scaled to about 1 MP. The image is cover-fit into the panel, and the user can pan and zoom it.

### 6.3 Prompt assembly (`packages/shared/src/prompt.ts`)

`final = [styleGuide.stylePrompt, colourTokens, characterTags…, panel.prompt.scene].join(', ')`

- `colourTokens` for B&W: `monochrome, greyscale, screentone, lineart`.
- `negative = [styleGuide.negativePrompt, BASE_NEGATIVE, panel.prompt.negative]`, where `BASE_NEGATIVE = 'text, speech bubble, sound effects, signature, watermark, logo'`.
- The words `manga` and `comic` are stripped from the positive prompt, because they pull in bubbles and SFX.
- Character appearance tags and the style prompt are inserted **verbatim**. The AI never rewrites them, which prevents character drift.

### 6.4 Character references

1. "Generate portrait" produces 4 variants (`anime`, bust, front, plain background) from `appearanceTags` + `seed`. The user picks one, which becomes `refs.portrait`.
2. "Generate sheet" produces `fullbody` (`anime-ref` from the portrait), then `side` and `back` (`qwen-edit-ref` from portrait + fullbody).
3. The user can upload their own image for any ref slot instead.

## 7. Jobs and GPU scheduling

- **Worker.** A single worker loop with three lanes:
  - `gpu`: exclusive, concurrency 1.
  - `claude`: concurrency 2.
  - `cpu`: concurrency 1, used for export.
- **Lane assignment.** LLM-backed jobs (`llm.step`, and `image.review`) run in the `gpu` lane when their task resolves to local, and in the `claude` lane when it resolves to Claude.
- **GPU owner tracking.** The worker tracks `comfy | ollama | none`. Before a GPU job whose owner differs from the current one, the worker frees the other side:
  - ComfyUI: `POST /free {unload_models:true, free_memory:true}`.
  - ollama: a request with `keep_alive: 0`.
- **Progress** is shown as named statuses:
  - ComfyUI WebSocket `executing` on loader nodes → "Loading model".
  - `progress` → "Sampling n/m", then "Decoding", then "Saving".
  - LLM jobs → "Writing outline…", etc.
  - Every status is broadcast on `/api/events`.
- **Retries.** Transient errors are retried with backoff 5 s → 30 s → 120 s (max 3 attempts). Transient means network, ComfyUI restarting, or a 5xx.
- **Validation errors** are never retried blindly: invalid AI output after the correction round, or a graph rejected by ComfyUI. The job fails with the details attached.
- **Cancel.** Queued jobs are cancelled immediately. A running ComfyUI job gets `POST /interrupt`; a running LLM job has its child killed via `AbortSignal`.
- **Resume.** On server start, jobs left `running` are reset to `queued`.
- **Quota.** When the Claude stream reports quota exhaustion, the `claude` lane pauses until the reported reset time, and the UI shows a banner.
- **Missing engine.** An unavailable engine (ollama down, `claude` not logged in) fails the job with a specific message. There is no silent fallback.

## 8. Episode workflow

**Input:** `prompt` (required), `characterIds[]` (optional), `pages` (default 8, range 1–30) and `tone` (optional).

The chapter's `status` is `generating` while a run is active.

| # | Step | Task(s) | Output (zod-validated) | Review point |
|---|---|---|---|---|
| 1 | premise | story | `{title, synopsis, tone, setting}` → written to the chapter | — |
| 2 | outline | story | `{scenes:[{summary, purpose, location, characterNames[]}], newCharacters:[{name, role, personality, speechStyle, appearanceTags}]}` | ◆ Approving creates the new characters and queues `character.refs` for them. In review mode the user picks portraits before step 6 |
| 3 | breakdown | story | `{pages:[{sceneIdx[], panelCount, pacing, layoutPreset}]}`. `layoutPreset` must exist and match `panelCount` | — |
| 4 | scripts | story + dialogue | `{pages:[{panels:[PanelScript]}]}` in the manga language. **Materializes Pages and Panels** | ◆ Edit in forms or in the editor |
| 5 | prompts | prompts | `{panels:[{panelId, scene, negative?}]}` | — |
| 6 | render | GPU | One `image.generate` per panel, plus a chapter cover page. Shows a time estimate (panels × recipe average) before queueing | ◆ |
| 7 | lettering | — | TextFrames from dialogue, auto-placed (§9.3) | ◆ Final check, then chapter `status=ready` |

- **Review and retry** (step 6, when `review.autoInEpisode` is on) work in batches:
  1. Render all panels.
  2. Switch the GPU owner and review all of them.
  3. Re-render the flagged ones.
  4. Repeat, for at most `review.rounds` rounds (default 2).
- **Reviewer input and output.** The reviewer gets the panel script, character portrait refs and the image, and returns `{pass, issues[]}`.
- **Retry strategy by issue:**
  - `identity` → `qwen-edit-ref` with refs (+ `anime-refine` for B&W).
  - `text` → new seed with a strengthened negative.
  - `anatomy` / `character-count` / `script-mismatch` → new seed, with the issue noted in the scene prompt.
- **Review mode vs autopilot.** In review mode the run stops at each ◆ with `awaiting-review`. "Run to end" switches `mode` to `autopilot` from the current step; in autopilot, the first generated portrait is taken as canonical.
- **Edit and re-run.** At a review point the user can edit the output JSON (through forms in the UI, or `manga episode edit`) or re-run the step. Re-running a step after materialization (step 4) replaces the chapter's pages and needs `confirm=true`.
- **Resumability.** Each step's output is persisted, so after a crash the run continues from `currentStep`. A failed step shows the error, with a retry.

## 9. Chapter editor

### 9.1 Screen

- **Left:** page thumbnails (drag to reorder; add/delete).
- **Centre:** the page canvas with zoom.
- **Right:** inspector for the selected Page, Panel or TextFrame.
- **Top:** icon toolbar with tooltips — layout presets, split H/V, merge, add speech/thought/shout/narration/SFX, generate, undo/redo, export.
- **Bottom:** a slim job bar with status loaders.

### 9.2 Panels

- **Script fields**, and prompt fields with an "AI write prompt" icon button (runs the `prompts` task).
- **Controls:** recipe select, seed and lock, and reference-character toggles.
- **Action icons:** generate, review, upload image.
- **Variant strip:** click to activate, delete a variant.
- **Pan and zoom:** double-click a panel to enter image-adjust mode (drag to pan, wheel to zoom, reset).
- **Print upscale:** at export, any image whose rendered resolution is under 300 dpi is upscaled once through the `upscale` recipe. The result is cached as an `upscaled` Image with `parentImageId`.

### 9.3 Text frames

- **Shapes**, all SVG:
  - speech: ellipse with a draggable tail
  - thought: cloud with a trail of small circles
  - shout: jagged burst
  - narration: rectangle
  - sfx: no frame; stroked text, rotatable
  - title: display font, covers only
- **Text** is HTML inside the shape's inscribed box. Auto-fit shrinks the font size to fit and warns when it drops below 7 pt.
- **Fonts.** Bundled OFL fonts, self-hosted, all with Cyrillic:

  | Use | Font |
  |---|---|
  | Speech and thought | Shantell Sans (alternative: Comic Relief) |
  | Shout and SFX | Dela Gothic One |
  | Narration | Sofia Sans Condensed |
  | Title | Unbounded |

  A unit test asserts every bundled font has glyphs for `і ї є ґ І Ї Є Ґ` plus the Latin alphabet.
- **Auto-placement (lettering step and the "auto-letter" button).**
  - For each panel, its dialogue lines in order become frames placed along the top of the panel, starting from the reading-direction side and stacking down when out of room.
  - The tail tip goes toward the speaker's `position` (left, center or right) at 40% of the panel height.
  - Narration goes in the top corner on the reading-start side.
  - SFX goes centred, rotated −10°.
- **Undo and redo.** A client-side command stack per editor session covers layout ops, frame edits, image transform and switching the active variant. Each command applies an API patch and knows its inverse. Generation is not undoable; it only adds variants.
- **Autosave.** Every change is persisted immediately (debounced 300 ms).
- **Keyboard:** Del, Ctrl+Z/Ctrl+Y, and arrow keys to nudge (Shift = 10×).

## 10. Rendering and export

- **One renderer.** `PageView` (React) renders a page:
  - absolutely-positioned panels with borders
  - images clipped inside panels using `imageTransform`
  - SVG bubble shapes with HTML text
- **Where it is used.** The editor, the thumbnails, and the print route `/render/page/:id?scale=` all use `PageView`.
- **Export.** Playwright Chromium opens the print route at the page's exact pixel size (2150×3035) and waits for fonts and images:
  - **PNG** is a screenshot.
  - **PDF** comes from `page.pdf()` at 182×257 mm, so the text stays vector and selectable.
  - **A chapter PDF** is the page PDFs merged with `pdf-lib`.
- **Output location** is `<library>/exports/<manga>/<chapter>/`, or `--out`.

## 11. UI

**Stack:** React 19 + Vite, React Router, TanStack Query (server state, invalidated by `/api/events`), lucide-react icons, plain CSS with design tokens (as cleopatra does).

**Style rules (from Roman):**
- No unnecessary text; use tooltips instead.
- Icon buttons rather than labelled buttons.
- Loaders that show what is happening.
- Compact layout with consistent spacing.
- Nothing fancy or neon; clean and tool-like.
- Neutral, pleasant colours.
- Light and dark themes, following the system and toggleable.

**Screens:**

| Screen | Content |
|---|---|
| Top bar (global) | Logo; engine switch (Claude/Local, status dot, quota tooltip); job-queue indicator (popover with the job list and cancel); theme toggle; settings icon |
| Manga list (`/`) | Grid of cover cards (title under the cover). A **＋** card opens the Create Manga modal: title, language, colour mode, reading direction, style preset |
| Manga (`/m/:id`) | Header: cover (click → cover editor), inline-editable title and synopsis, settings icon (style guide and page geometry). Tabs: **Chapters** (rows: cover thumbnail, number, title, page count, status; **＋** opens Create Chapter) and **Characters** (portrait grid; **＋** opens the character drawer) |
| Create Chapter modal | Title. Collapsible "Generate with AI" section: prompt, pages, character multiselect, autopilot toggle. Submitting with a prompt starts an EpisodeRun |
| Character drawer | Name, role, personality, speech style, appearance tags (with an "AI suggest" button that turns the description into tags via the `prompts` task), recipe, seed and lock. Portrait variants grid (generate ×4, pick). Ref slots (portrait, fullbody, side, back) with generate-sheet and upload buttons |
| Chapter (`/m/:id/c/:cid`) | Chapter editor (§9). When a run exists, a collapsible **episode stepper** shows step statuses and, at a review point, the step output as an editable form with continue / run to end / re-run / cancel icons |
| Cover editor | The chapter editor limited to a cover page (one panel plus title frames) |
| Settings (`/settings`) | Library path (read-only; change via config), engine per task, Claude model per task, ollama models, ComfyUI root and URL, review toggle and rounds. Status checks for claude, ollama and ComfyUI |

## 12. CLI (`manga`)

Global flags: `--json` (machine-readable output) and `--wait` (stream progress until the triggered jobs finish).

References accept an id, or a unique title/name within scope.

```
manga serve [--open]              manga status          manga engine [claude|local] [--task story=local]
manga create "<title>" [--lang en|uk] [--color bw|color] [--dir rtl|ltr] [--style <preset>]
manga list | show <manga> | rm <manga>
manga character add <manga> --name .. [--appearance ..] [--personality ..] | generate <char> [--n 4] | pick <char> <image> [--slot portrait] | sheet <char> | upload <char> <file> --slot ..
manga chapter add <manga> "<title>" | list <manga> | rm <chapter>
manga page add <chapter> [--layout <preset>] | layout <page> <preset> [--confirm] | split <panel> h|v | merge <panelA> <panelB> | resize <page> <splitPath> <ratio> | rm <page>
manga layouts
manga panel script <panel> [--action ..] [--shot ..] [--chars a,b] | prompt <panel> [--ai | --scene ..] | generate <panel> [--recipe ..] [--seed ..] | review <panel> | variants <panel> | pick <panel> <image> | upload <panel> <file>
manga text add <page> --kind speech --text ".." [--speaker <char>] [--panel <panel>] | edit <frame> [..] | rm <frame> | auto <page>
manga episode start <chapter> --prompt ".." [--pages 8] [--chars a,b] [--tone ..] [--autopilot] | status <chapter> | approve <chapter> | edit <chapter> <step> --file x.json | rerun <chapter> <step> [--confirm] | cancel <chapter>
manga jobs [--watch] | cancel <job>
manga export <chapter|page> [--format pdf|png] [--out <dir>]
```

## 13. Error handling

| Situation | Behaviour |
|---|---|
| ComfyUI down | Auto-started; job status "Starting image server"; fails after 240 s with the log path |
| ComfyUI rejects the graph | Job fails with the node errors (no retry) |
| ollama down or model missing | Job fails: "ollama not reachable at … / model qwen3:14b not pulled" |
| `claude` missing or logged out | Job fails with a hint to run `claude` once to log in |
| Claude quota exhausted | `claude` lane paused until reset; banner in the UI |
| Invalid AI output after correction | Step or job fails; raw output viewable in the stepper and job details |
| Server restart mid-job | Running jobs are re-queued; episode runs resume |
| Export render timeout (60 s per page) | Job fails with the page id |

## 14. Testing

- **Unit (vitest):**
  - layout ops and reading order (LTR and RTL), presets valid
  - prompt assembly (verbatim tags, stripped words, B&W tokens)
  - size-bucket choice
  - structured-output extraction and correction
  - job-queue lanes, retry, cancel and resume, GPU-owner switching
  - episode step machine
  - auto-letter placement
  - font glyph coverage
- **Integration:**
  - server routes against a temp library
  - `claude` engine against recorded stream-json fixtures (from cleopatra)
  - ollama engine against a fake HTTP server
  - imaging against **FakeComfy**, an in-process HTTP + WebSocket server that implements the endpoints in §3.2, returns a solid PNG of the requested size, and records received graphs so recipe builders can be asserted
- **E2E (Playwright), with fakes:**
  1. create manga → character → chapter
  2. add page → preset → split, merge, resize
  3. generate panel → add text
  4. export PDF
  5. an episode run in autopilot with a fake engine
- **Live smoke** (`npm run smoke`, manual): real Claude plus real ComfyUI; one character, one 2-panel page, export. Not part of `npm test`.

## 15. Dependencies on sub-project 1

- Required models present in `claude-image-gen/models`, and extra model paths registered (`clip_vision`, `ipadapter`, `upscale_models`, `model_patches`).
- `ComfyUI_IPAdapter_plus` installed, with torch still `2.14.0+cu130`.
- Working `gen.py` presets for every recipe in §6.1. Their node settings are what the TypeScript recipes port.
- `docs/BAKEOFF.md` with timings and recommended default routing. Until it exists, the §6.1 defaults apply.
