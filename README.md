# Manga Builder

A personal, local tool for making manga with AI. It keeps character art consistent, builds chapters from a prompt with review points, and handles page layouts, lettering in text frames (never inside the art), and PNG/PDF export. Every action is also available from the `manga` CLI.

**Status: milestones M1–M4 complete (MVP).** The foundation (M1: mangas, characters, chapters, pages and layouts, panels, text frames, uploads, the job queue), AI imaging (M2), the web UI (M3), and the episode workflow with PNG/PDF export (M4) all work from the web UI, the REST API and the `manga` CLI.

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
npx playwright install --only-shell chromium   # the headless Chromium that export (and `npm test`) render pages with
npm run link-cli        # puts `manga` on your PATH (undo: npm unlink -g @manga/cli)
```

If the check fails with a "bindings" or "compiled against a different Node.js version" error, run `npm rebuild better-sqlite3` and check again.

## Running

```bash
npm start               # or: manga serve [--open]
```

The server listens on `http://127.0.0.1:4317`, on loopback only. You rarely need to start it by hand: when no server is running, any other `manga` command starts one in the background. That server runs without a window and logs to `<library>/logs/server.log`.

`manga stop` stops the library's server (the one named in `<library>/server.json`), wherever it was started. After `npm run build`, you don't need to stop it yourself: the next `manga` command notices that the running server is an older build, stops it and starts the new one, printing one line to stderr.

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

The environment variables `MANGA_LIBRARY` and `MANGA_PORT` override `libraryPath` and `port`, and `MANGA_CONFIG` reads another config file instead. Everything else lives in the database: engines per task, models and review settings. Change it with `manga engine …` or `PATCH /api/settings`.

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

Disk cost of print export: before exporting, every panel image that would print below 300 dpi is upscaled once (2x when that suffices, otherwise 4x) and the result is kept in the library as an `upscaled` image next to the original, so later exports reuse it. A 4x upscale is roughly 20-30 MB of PNG each; an episode of many low-resolution panels adds up quickly.

## CLI quick reference

These global flags work before or after the command:

- `--json` prints raw API data.
- `--wait` streams job progress until the started jobs finish.
- `--url <baseUrl>` talks to one specific server and never auto-starts one.

References take an id or a unique name or title, case-insensitive. A chapter can also be given as `<manga>/<number>`, e.g. `"Night Market/1"`.

| Command | What it does |
|---|---|
| `manga serve [--open]` | Run the server in this terminal |
| `manga stop` | Stop the library's server; prints `no server running` if there is none |
| `manga status` | Server, engines, ComfyUI and queue status |
| `manga engine [claude\|local] [--task story=local …]` | Show or set the AI engine; `task=default` clears an override |
| `manga create "<title>" [--lang en\|uk] [--color bw\|color] [--dir rtl\|ltr] [--style <preset>]` | Create a manga. The colour mode follows the style preset unless `--color` is given (it then wins, with a warning if they disagree) |
| `manga list` · `manga show <manga>` · `manga rm <manga>` | List, inspect (characters, chapters, pages, panel ids) or delete |
| `manga edit <manga> [--title] [--synopsis] [--lang en\|uk] [--color bw\|color] [--dir rtl\|ltr] [--style <preset>]` | Change a manga; only the options you pass change. `--dir` mirrors every page; `--style` takes the preset's style guide |
| `manga cover <manga> [--chapter <chapter>]` | Create the manga (or chapter) cover page; prints its page and panel ids |
| `manga character add <manga> --name … [--role] [--appearance] [--personality] [--speech] [--seed]` | Add a character |
| `manga character upload <char> <file> --slot portrait\|fullbody\|side\|back` | Use your own reference image |
| `manga character pick <char> <image> [--slot portrait]` | Point a reference slot at one of the character's images |
| `manga character edit <char> [--manga <m>] [--name] [--role] [--personality] [--speech] [--appearance] [--seed] [--recipe <id>\|-]` | Change a character; only the options you pass change |
| `manga character generate <char> [--n 4] [--manga <m>]` | Generate portrait variants (AI); pick one with `character pick` |
| `manga character sheet <char> [--manga <m>]` | Generate full-body, side and back reference views from the picked portrait (AI) |
| `manga character suggest <char> --description "…" [--manga <m>]` | Turn a description into appearance tags (AI) |
| `manga chapter add <manga> "<title>"` · `chapter list <manga>` · `chapter rm <chapter>` | Chapters. The title `"Untitled chapter"` leaves it to the AI: an episode's premise then names the chapter; any other title is kept |
| `manga chapter edit <chapter> [--title] [--synopsis] [--number <n>]` | Change a chapter; the number must be free in the manga |
| `manga layouts` | The 16 layout presets |
| `manga page add <chapter> [--layout 2x2] [--at <index>]` | Add a page |
| `manga page layout <page> <preset> [--confirm]` | Apply a preset. Panels map in reading order. Without `--confirm` it refuses to drop panels and lists them |
| `manga page split <panel> h\|v` · `page merge <a> <b>` · `page resize <page> <root\|ab…> <ratio>` | Edit the layout |
| `manga page show <page>` · `page rm <page>` | Inspect (reading order, rects, split paths) or delete |
| `manga panel script <panel> [--action] [--shot] [--angle] [--background] [--chars a,b] [--line "Aiko:speech:Hi!" …]` | Show or edit the panel script |
| `manga panel variants <panel>` · `panel pick <panel> <image>` · `panel upload <panel> <file>` | Panel images |
| `manga panel prompt <panel> [--ai \| --scene "…"]` | Set the scene prompt by hand (`--scene`) or let the AI write it (`--ai`) |
| `manga panel generate <panel> [--recipe <id>] [--seed <n>]` | Generate a new image variant for the panel (AI) |
| `manga panel review <panel>` | Ask the AI to check the panel's active image |
| `manga recipes` | List image recipes |
| `manga text add <page> --kind speech --text "…" [--speaker <char>] [--panel <panel>]` | Add a text frame |
| `manga text edit <frame> [--text] [--box x,y,w,h] [--speaker <char>\|-] …` · `text rm <frame>` | Edit or delete a text frame |
| `manga text auto <page>` | Auto-letter a page: add text frames for the dialogue lines that have none yet |
| `manga episode start <chapter> --prompt "…" [--pages 8] [--chars a,b] [--tone "…"] [--autopilot]` | Generate the chapter from one prompt (AI). Without `--autopilot` it stops at the review points; with `--wait` it follows the run and prints each step's progress. The premise writes the chapter's synopsis, and its title only when the chapter is titled `"Untitled chapter"` (or with an earlier premise's title) |
| `manga episode status <chapter>` · `episode approve <chapter>` · `episode autopilot <chapter>` · `episode cancel <chapter>` | Show the latest run, continue past a review point, run to the end, or cancel it and its jobs |
| `manga episode edit <chapter> <step> --file <out.json>` · `episode rerun <chapter> <step> [--confirm]` | Replace a step's output, or run a step again (and every later step); `--confirm` allows replacing the chapter's pages |
| `manga export <page\|chapter> [--format pdf\|png] [--out <dir>]` | Export a page, or a whole chapter (cover first, plus `chapter.pdf`), at print size; default folder `<library>/exports/<manga>/<chapter>` |
| `manga jobs [--watch] [--status <s>]` · `manga cancel <job>` | Background jobs |

The exit code is `0` on success, `1` for API or validation errors (the message goes to stderr), and `2` for usage errors.

## Development

```bash
npm test                # vitest over all packages, against the TypeScript sources
npm run typecheck       # tsc --build --force, then the UI's own tsc -p
npm run dev             # tsc --build, then tsc --build --watch + the server (node --watch) + Vite, together
npm run build           # tsc --build, then the UI's vite build into packages/ui/dist (the server serves it at /)
npm run e2e             # build, then the Playwright specs in e2e/ against the built UI
npm run smoke           # live smoke test: real Claude + ComfyUI, one episode and its export (slow; uses the GPU)
```

`npm run smoke` needs `npm run build` first, a logged-in `claude` CLI and a working ComfyUI. It starts its own server on port 4398 (`SMOKE_PORT` overrides it) with a throwaway library in the OS temp folder (`SMOKE_LIBRARY` names another one), never port 4317 or your library.

The UI dev server is `http://127.0.0.1:5173`; it proxies `/api` (with the WebSocket) and `/files` to the server. Open the UI there during `npm run dev`; the built UI is served by the server itself at `http://127.0.0.1:4317/`.

`npm run e2e` is hermetic: Playwright starts its own built server with `MANGA_FAKES=1` (fake AI engines, no ComfyUI or ollama), a throwaway library in the OS temp folder, a config path that does not exist, and port 4399 (`MANGA_E2E_PORT` overrides it). It never touches port 4317 or your library.

The lettering fonts in `packages/ui/public/fonts` and `src/styles/fonts.css` are committed; `npm run fonts --workspace @manga/ui` downloads them again.

Before `npm run dev`, run `manga stop`: the dev server runs its own copy of `@manga/server` on the default library and port 4317, replacing any background server already serving that library. The Vite dev proxy (`packages/ui/vite.config.ts`) assumes the server is on `127.0.0.1:4317`.

After the *first* `npm run build` that produces `packages/ui/dist`, run `manga stop` once. A server auto-started by the CLI before that build only knows to restart itself when the server or shared build changes, not when the UI is built, so it would otherwise keep answering `/` with a JSON 404. The next `manga` command auto-starts a server that serves the built UI from `/`.

The packages are `@manga/shared` (schemas, layout engine and prompt helpers, safe for browsers), `@manga/server` (Fastify, SQLite, jobs), `@manga/cli` (`manga`) and `@manga/ui` (the web UI, Vite + React). `docs/superpowers/` holds the design spec and the milestone plans.

The environment variable `MANGA_CONFIG` names another config file to read instead of `%USERPROFILE%\.manga-builder\config.json`. The root `vitest.config.ts` points it at a file that cannot exist, so the tests never read your personal config; they pin `libraryPath` and `port` through explicit overrides or `MANGA_LIBRARY`/`MANGA_PORT`.
