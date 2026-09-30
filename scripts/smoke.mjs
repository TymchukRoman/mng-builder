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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const seconds = (ms) => `${Math.round(ms / 1000)} s`;
/** How long one job (a portrait, an export) may take before the smoke gives up on it (Task 22 review minor 4). */
const JOB_DEADLINE_MS = 10 * 60_000;

// Task 22 review minor 3: a server already answering on the port (an orphan of an earlier run, or a SMOKE_PORT
// collision) would make the smoke test stale code against another library. Refuse before spawning anything.
try {
  await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
  console.error(`A server already answers at ${base}: stop it (manga stop --url ${base}) or set SMOKE_PORT to a free port.`);
  process.exit(1);
} catch {
  // nothing listening: good
}

const server = spawn(process.execPath, [serverMain], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
/** Set when the server process ends; waitHealth fails fast with its exit code instead of waiting 60 s. */
let serverExit = null;
server.on('exit', (code, signal) => { serverExit = { code, signal }; });

/** An error that ends the smoke with this exit code (the server's own, when it died early). */
class ExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function api(method, path, body) {
  const res = await fetch(base + path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    if (serverExit !== null) {
      const { code, signal } = serverExit;
      throw new ExitError(`the server exited before it answered (code ${code ?? '-'}, signal ${signal ?? '-'})`, code || 1);
    }
    try { await api('GET', '/api/health'); return; } catch { await sleep(500); }
  }
  throw new Error('the server did not start within 60 s');
}

async function waitJob(id, label, deadlineMs = JOB_DEADLINE_MS) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const job = await api('GET', `/api/jobs/${id}`);
    const now = job.progress?.label ?? job.status;
    if (now !== last) { console.log(`[${label}] ${now}`); last = now; }
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      console.log(`[${label}] took ${seconds(Date.now() - t0)}`);
      return job;
    }
    if (Date.now() - t0 > deadlineMs) throw new Error(`[${label}] job ${id} did not finish within ${seconds(deadlineMs)}`);
    await sleep(2000);
  }
}

/**
 * Task 22 review minor 4: stop the server the graceful way (POST /api/shutdown: the queue stops, ComfyUI work is
 * cancelled), and kill it only if it has not exited 15 s later.
 */
async function stopServer() {
  if (serverExit !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    await fetch(`${base}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {
    // not answering: the kill below ends it
  }
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000).unref());
  if ((await Promise.race([exited, timer])) === 'timeout' && serverExit === null) server.kill();
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
  let run;
  for (;;) {
    run = await api('GET', `/api/chapters/${chapter.id}/episode`);
    const step = run.steps[run.currentStep];
    const key = `${run.status} ${step?.name} ${step?.status}`;
    if (key !== lastKey) { console.log(`[episode ${Math.round((Date.now() - t0) / 1000)} s] ${key}`); lastKey = key; }
    if (run.status === 'failed') throw new Error(`episode failed at ${step?.name}: ${step?.error}`);
    if (run.status === 'cancelled') throw new Error('episode was cancelled');
    if (run.status === 'done') break;
    if (Date.now() - t0 > 45 * 60_000) throw new Error('episode did not finish within 45 minutes');
    await sleep(3000);
  }
  for (const s of run.steps) {
    const took = s.startedAt && s.finishedAt ? seconds(Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : '-';
    console.log(`[episode] ${s.name}: ${took}`);
  }
  console.log(`[episode] total: ${seconds(Date.now() - t0)}`);

  const png = await waitJob((await api('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'png' })).jobId, 'export png');
  const pdf = await waitJob((await api('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).jobId, 'export pdf');
  for (const job of [png, pdf]) if (job.status !== 'succeeded') throw new Error(`export failed: ${job.error}`);

  console.log('\nSMOKE OK');
  console.log(`total: ${seconds(Date.now() - started)}`);
  console.log('library:', library);
  for (const file of [...png.result.files, ...pdf.result.files]) console.log('file:', file);
}

main().then(
  async () => { await stopServer(); process.exit(0); },
  async (err) => {
    console.error('SMOKE FAILED:', err.message);
    console.error('library:', library);
    await stopServer();
    process.exit(err instanceof ExitError ? err.exitCode : 1);
  },
);
