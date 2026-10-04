# Manga from a prompt, the gallery, image models per manga/chapter (A1): design

**Date:** 2026-10-04
**Builds on:** `2026-09-27-manga-builder-design.md` §8 (episode workflow) and `2026-09-30-workflow-improvements-design.md` (W1).

## What was asked

1. Make a whole **manga** from a prompt (chapters, pages per chapter, one brief), not only a chapter. The brief carries **plot and notes** ("simplistic art style"). Auto creation also draws a **manga poster** and the **chapter posters**.
2. A **gallery** of every image that was generated and not deleted.
3. Find out how to automate manga creation further: fewer user actions, better output.
4. Pick the **image model** per manga and per chapter for auto creation.

## 1. Manga from a prompt

### Flow

`POST /api/auto-mangas {input}` creates the manga at once (titled "Untitled manga" until the plan names it, unless the user typed a title) and a durable `auto_runs` row, then one driver per run walks these stages. Each stage can be run again, so a restart, a retry and a resume re-enter at the stored stage and adopt the jobs and episode runs that exist.

| Stage | What happens |
|---|---|
| `plan` | One story-task LLM call (`llm.step {type:'manga-plan'}`, prompt `prompts/manga/plan.md`) turns the brief into: title, synopsis, tone, **notes**, **styleTags** / **negativeTags**, the cast (same draft shape as the episode outline, so colour rules and the count tags apply), one `{title, synopsis, plot}` per chapter (exactly the asked number, checked by the schema's correction round) and the poster idea. The plan is applied in one transaction: manga title/synopsis, style tags merged into the manga's style and negative prompts, the chapters (each with its own image model), the cast. |
| `portraits` | `AUTO_PORTRAITS_PER_CHARACTER` (2) portrait variants per character; the oldest becomes the reference, as in an autopilot episode. |
| `poster` | The manga cover page, one panel with the leads (role `main` first, at most 3), a scene prompt written by the same step as the editor's "AI write prompt" (so the prompt style follows the model's recipe), the picture, and the title frame. Optional: a failure is a note on the run and the chapters go on. |
| `chapters` | One episode run per chapter, in autopilot, one after the other, so each chapter's premise reads the chapters before it (plan synopsis, then the written summary: the driver waits for the previous chapter's summary job). The input is the chapter's slice of the plan (`chapterPrompt`), the plan's `notes` and `tone`, `previewFirst: false`. The driver approves the render step's size stop itself: the whole manga's estimate was shown before the start. Each episode draws and letters **its own chapter poster** (the cover). |

A failed chapter fails the run with the chapter and the step's error; `POST /api/auto-runs/:id/resume` retries the failed step (the finished chapters stay). `cancel` stops the driver, the plan job, the characters' portrait jobs, the poster jobs and the running chapter's episode. Deleting the manga ends the driver.

API: `POST /api/auto-mangas`, `GET /api/auto-runs/:id`, `GET /api/mangas/:id/auto-run`, `POST /api/auto-runs/:id/cancel|resume`. Event: `entity autoRun`. CLI: `manga auto start|status|cancel|resume`. UI: New manga → "From a prompt"; the manga page shows the stages and the chapter being written until the run finishes cleanly.

### Plot and notes in one prompt

The prompt box is now "Plot and notes", for chapters and manga alike.

- **Chapter episodes:** the premise step separates the two. `PremiseOutput` gained `notes` (non-visual wishes: pacing, content to include or avoid, how dialogue sounds; later steps read them) and `artTags` (English tags for a requested look, "simplistic art style" → "simple background, minimal shading"). The prompts effect adds `artTags` to every panel scene of the chapter, the cover too. `EpisodeInput.notes` carries extra notes from a caller (CLI `--notes`; the auto run passes the plan's).
- **Whole manga:** the planner makes the same split once, so the look is the same in every chapter: `styleTags` go into the **manga's** style prompt (not re-derived per chapter), the non-visual `notes` go to every chapter.

## Reading the brief properly (A2)

The first version trusted one model call to remember a long text. A2 reads the text in several passes, keeps what it finds as a **ledger of directives**, hands each step the directives that concern it, and checks the result against them.

### The ledger (`shared/directives.ts`)

A `Directive` is one atomic requirement: `text` (a self-contained sentence naming who or what it is about, in the book's language), `kind` (plot, character, setting, tone, dialogue, visual, structure, avoid, format, other), `chapters` (the chapters it names; empty = all), `must` (false for hedged wishes), `quote` (the author's words), `sources` (numbers of the brief's sentences) and, for `visual`, English `tags`. The code numbers them D1, D2, …; the model never writes ids.

### Passes

1. **Extract** (`prompts/brief/extract.md`): the brief arrives as numbered sentences (`briefSegments`); one directive per detail, a sentence with several details becomes several directives, every name, number and colour kept verbatim.
2. **Audit** (`prompts/brief/audit.md`): the text, the directives so far and the sentences **no directive names** (found by code, `uncoveredSegments`) go back to the model, which adds what the first pass lost, clause by clause. Repeats are dropped by text.
3. **Plan** (auto manga): written from the directives. The schema requires an entry in `coverage` for every `must` directive (cast, style, notes, or the chapters it is applied in); a plan that drops one fails validation, so the engine's correction round names the missing directives and asks again.
4. **Plan audit** (`prompts/manga/plan-audit.md`): checks the plan against the directives; the unmet ones are written once more as `revisions` (with the first plan), then checked again. What is still unmet after that stays marked `unmet` (with the auditor's note) on its directive, and the manga page shows it.
5. **Per chapter**: the premise of a planned chapter is handed its directives (`planChapterDirectives`: those that name the chapter, those the plan applied to it, and the series-wide ones) and does not read the brief again. A chapter made on its own (a prompt in the chapter dialog) runs passes 1 and 2 inside its premise step, and keeps the ledger in the premise output, where it can be read and edited like any step output.
6. **Script audit** (`prompts/episode/script-audit.md`): after the scripts step, one call checks the whole script (every panel's action and dialogue) against the chapter's `must` directives that a script can show. Unmet ones are written once more as `revisions` to every page chunk, which fixes those that belong to its pages. A failed check or rewrite keeps the first script.

### Where directives go

| Step | Reads kinds |
|---|---|
| premise, plan | all |
| outline | plot, character, setting, tone, structure, avoid, format, other |
| breakdown | structure, format, tone, avoid, other |
| scripts | all but visual |
| prompts | visual, setting, avoid, tone, other |

Notes and art tags are **derived by code** from the ledger (`deriveNotes`, `deriveArtTags`), not left to the model: the visual directives' tags reach every panel prompt of the chapter; for a planned manga, the series-wide tags go into the manga's style prompt once (`applyPlan`) and are not repeated per chapter.

### Unattended flow

A chapter whose step fails is run again up to `CHAPTER_RETRIES` (2) times (a cancel by the user is never retried) before the run fails, so a flaky answer or a stalled image no longer stops a whole manga. `error` on a run stays the reason it stopped.

## 4. Image model per manga and chapter

`ImageModel` presets (shared `IMAGE_MODELS`) fill the three panel routes in one choice: `sdxl` (WAI Illustrious: anime / anime-ref), `flux2` (klein-ref everywhere), `qwen` (klein for panels without references, qwen-edit-ref with them), `anima`, `anima-turbo` (tags only, no references). `mangas.image_model` and `chapters.image_model` (migration 4, NULL = Settings' routing); a chapter's own wins over its manga's (`effectiveImageModel`).

- `routeRecipe` takes the model: its routes replace Settings' (a panel's own recipe still wins), and a panel without references uses the model's `noChars` route instead of the manga style's recipe, so a chapter comes from one model. The identity-drift retry and the B&W refine pass stay as Settings say.
- Style LoRAs only apply to the family of the manga's style recipe. When a model draws on another family, it takes the LoRAs of the built-in preset of that family and colour mode (Anima's manga LoRA for a B&W book), so the look carries over. Without a chosen model nothing changes.
- The estimates (`estimateChapter`, `estimateManga`) and the prompts step (which writes tags or sentences by recipe) follow the model.
- UI: manga settings → Image model; the chapter row's lightning button; the chapter AI section; the auto form (manga model + a per-chapter list). CLI: `--model` on `create`, `edit`, `chapter add|edit`, `auto start` (`--chapter-model 2=anima`), `manga models`.

## 2. Gallery

`GET /api/gallery?mangaId&ownerType&source&limit&before` lists the images that exist (deleting an image removes its row and file), newest first, keyset-paged, each with its owner resolved (chapter and page number, cover, character and slot) and whether it is the active picture. Default source is `generated`. UI: `/gallery` (top bar), filters, lightbox with the generation parameters, "Open in editor", delete. CLI: `manga gallery`.

## 3. Automating further: findings

What a user still does after this change: type the brief and press Create; fix whatever the AI got wrong afterwards. What is left, ordered by value over effort. Numbers come from the recorded timings in `RECIPE_AVG_SECONDS` and the W1 evidence.

| # | Idea | Why it matters | Cost |
|---|---|---|---|
| 1 | **Pick the portrait with the vision reviewer** (best of N against the appearance tags: one character, no text, face visible), then draw the full-body / side sheets for main characters. | Every panel inherits the portrait as its reference; today the first of two is taken blindly. Full-body is the second reference of one-character panels (`anime-ref`, `qwen-edit-ref`). | ~2 × 15 s per character plus 10 s per review; one review call per variant. |
| 2 | **Unattended failure policy** (the bounded retry of a failed chapter step is built, A2): on a chapter that still fails, continue with the next, finishing with `render-missing`; push a notification when the run ends. | A chapter that keeps failing still stops the whole run until someone presses Continue; a 3-chapter manga is hours long. | Small: the pieces (`rerun`, `renderMissing`) exist. |
| 3 | **Infer the dialog's settings from the brief** (language, colour, reading direction, page/chapter counts: "a short 3-chapter story in Ukrainian, in colour"). The plan can return them; the dialog shrinks to one text box and Create. | The dialog is the only place the user still decides; the answers are in the text most of the time. | Small: plan fields plus defaults the user can override. |
| 4 | **Best-of-N for key pictures** (poster, chapter covers, splash panels) judged by the vision reviewer. | The few pictures a reader sees first; N=3 costs 2 extra images each. | Small per picture; GPU time only on those. |
| 5 | **Style probe**: draw the poster first, let the reviewer check it against the notes ("simplistic"), adjust `styleTags` once before the long render. | A wrong look is discovered after hours today. The poster is already drawn before the chapters. | Small. |
| 6 | **"Best for this story" model**: choose the preset from the cast (several characters on most panels → `flux2`; no recurring cast → `anima`) and a speed/quality choice, instead of asking for a model. | The model list needs knowledge of recipes; the estimate already shows the cost. | Small: a rule over the plan. |
| 7 | **Overlap the text and image work of neighbouring chapters** (chapter n+1's premise → prompts while chapter n renders; the plan's synopsis stands in for the not-yet-written summary). | The GPU is idle during every chapter's text steps (a few minutes per chapter). Only a saving of minutes against hours of rendering; do it last. | Medium: the lanes already allow it, the ordering rules do not. |
| 8 | **Auto export** (PDF at the end) and a "Made" screen that links to it. | Last manual step of an unattended run. | Small: the `export.render` job exists. |
| 9 | **A story bible in the plan** (recurring locations and props as tag sets reused in prompts). | Backgrounds drift between chapters; characters are already pinned by tags and references. | Medium. |

Recommended next: 1, 2 and 3 (they remove the remaining stops and improve the pictures every page depends on), then 4 and 5.

## Out of scope here
Per-panel model overrides in the UI (a panel's own `recipe` still works), editing the plan before the run starts (the run can be cancelled and restarted; a "review the plan" stop is the natural first addition if wanted), portraits judged by a model (idea 1).
