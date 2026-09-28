import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ComfyGraph } from '../imaging/comfy-graph.js';
import { readImageMeta } from '../files/image-meta.js';
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
  /** GET /system_stats → devices[0].torch_vram_total, mutable so tests can exercise ComfyClient.prepareFor's
   *  wait loop. Default 0 (nothing resident). */
  torchVramTotal: number;
  /** Delay before POST /free drops torchVramTotal to 0, mimicking ComfyUI's async unload (its prompt worker
   *  applies the flag on its next wake-up, not immediately on the POST). Default 0 (drops right away). */
  freeDelayMs: number;
  /** The next POST /prompt answers 400 with this body. */
  rejectNext: FakeComfyRejection | null;
  /** The next run ends with an execution_error carrying this exception message. */
  failNext: string | null;
  /** The next run ends as `execution_interrupted`, like an /interrupt from another client. */
  interruptNext: boolean;
  /** The next accepted prompt vanishes: never run, never listed by GET /queue, no history entry (like a queue
   *  cleared from the ComfyUI web UI). */
  dropNext: boolean;
  /** Extra delay before a run completes (to test cancel and crashes). */
  completionDelayMs: number;
  /** Deterministic alternative to `completionDelayMs` for liveness-polling tests: when > 0, a run only completes
   *  once at least this many `GET /queue` calls have happened, instead of racing a fixed real-time delay against
   *  the poll loop's `pollMs` (flaky under CPU load, where each poll's real HTTP round trip can take much longer
   *  than `pollMs`). Default 0 (no hold). */
  completeAfterQueuePolls: number;
  /** Like a real ComfyUI folder: when set, uploads are also written to <dataDir>/input/<subfolder>/<name> and each
   *  SaveImage output to <dataDir>/output/<subfolder>/<filename>, so tests can check ComfyClient cleans them up.
   *  Default null (nothing on disk). */
  dataDir: string | null;
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

/** The size a real run of `graph` would produce: the empty-latent size, else the loaded image × upscalers.
 *  Inputs are sized from their PNG or JPEG header (uploads keep the user's bytes, M8); anything else throws. */
export function fakeOutputSize(graph: ComfyGraph, uploads: ReadonlyMap<string, Uint8Array>): { width: number; height: number } {
  const nodes = Object.values(graph);
  const latent = nodes.find((n) => LATENTS.has(n.class_type));
  if (latent) return { width: Number(latent.inputs['width']), height: Number(latent.inputs['height']) };
  const load = nodes.find((n) => n.class_type === 'LoadImage');
  const name = String(load?.inputs['image'] ?? '');
  const bytes = load ? uploads.get(name) : undefined;
  const meta = bytes ? readImageMeta(bytes) : null;
  if (bytes && !meta) throw new Error(`LoadImage ${name}: not a PNG or JPEG image`);
  let { width, height } = meta ?? { width: 512, height: 512 };
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

const outputKey = (subfolder: string, filename: string): string => (subfolder ? `${subfolder}/${filename}` : filename);

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

class FakeComfyServer implements FakeComfy {
  url = '';
  readonly graphs: ComfyGraph[] = [];
  readonly promptIds: string[] = [];
  readonly uploads = new Map<string, Uint8Array>();
  readonly calls: FakeComfyCall[] = [];
  up = true;
  torchVramTotal = 0;
  freeDelayMs = 0;
  rejectNext: FakeComfyRejection | null = null;
  failNext: string | null = null;
  interruptNext = false;
  dropNext = false;
  completionDelayMs = 0;
  completeAfterQueuePolls = 0;
  dataDir: string | null = null;
  private readonly history = new Map<string, HistoryEntry>();
  /** Accepted prompts that have no history entry yet (GET /queue lists them as running). */
  private readonly active = new Set<string>();
  private readonly outputs = new Map<string, Uint8Array>();
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly server = createServer((req, res) => { void this.handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, 500, { error: 'Internal server error', message: String(err) });
    else res.destroy();
  }); });
  private readonly wss = new WebSocketServer({ noServer: true });
  private closed = false;
  private counter = 0;
  private readonly pendingTimeouts: NodeJS.Timeout[] = [];
  /** Total GET /queue calls observed, and resolvers waiting for `completeAfterQueuePolls` to be reached. */
  private queueCallCount = 0;
  private readonly queueWaiters: Array<{ count: number; resolve: () => void }> = [];

  /** Resolves once at least `count` GET /queue calls have happened (see `completeAfterQueuePolls`). */
  private waitForQueuePolls(count: number): Promise<void> {
    if (this.queueCallCount >= count) return Promise.resolve();
    return new Promise((resolve) => { this.queueWaiters.push({ count, resolve }); });
  }

  private async delayMs(ms: number): Promise<void> {
    if (this.closed) return;
    return new Promise((resolve) => {
      const handle = setTimeout(resolve, ms);
      this.pendingTimeouts.push(handle);
    });
  }

  async listen(): Promise<void> {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (url.pathname !== '/ws' || !this.up) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {}); // no-op, 'close' already cleans up
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
    for (const handle of this.pendingTimeouts) clearTimeout(handle);
    this.pendingTimeouts.length = 0;
    for (const waiter of this.queueWaiters) waiter.resolve();
    this.queueWaiters.length = 0;
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
        devices: [{ name: 'FakeGPU', type: 'cuda', index: 0, vram_total: 16e9, vram_free: 15e9, torch_vram_total: this.torchVramTotal }],
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
      const bytes = this.outputs.get(outputKey(url.searchParams.get('subfolder') ?? '', url.searchParams.get('filename') ?? ''));
      if (!bytes) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(bytes);
      return;
    }
    if (route === 'POST /free') {
      send(res, 200);
      // Real ComfyUI applies /free asynchronously (its prompt worker picks it up on its next wake-up); mimic
      // that with a delay so tests can exercise ComfyClient.prepareFor's poll-until-dropped wait.
      void this.delayMs(this.freeDelayMs).then(() => { this.torchVramTotal = 0; });
      return;
    }
    if (route === 'GET /queue') {
      this.queueCallCount += 1;
      for (const waiter of [...this.queueWaiters]) {
        if (this.queueCallCount < waiter.count) continue;
        const idx = this.queueWaiters.indexOf(waiter);
        if (idx >= 0) this.queueWaiters.splice(idx, 1);
        waiter.resolve();
      }
      return send(res, 200, { queue_running: [...this.active].map((id, i) => [i, id, {}, {}, []]), queue_pending: [] });
    }
    if (route === 'POST /interrupt' || route === 'POST /queue') return send(res, 200);
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.uploads.set(key, bytes);
    this.writeToDataDir('input', key, bytes);
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
    if (this.dropNext) {
      this.dropNext = false;
      return;
    }
    this.active.add(id);
    // M8: a run that throws (e.g. an input it cannot size) ends as an execution_error, like a real node failure,
    // instead of an unhandled rejection that takes the whole fakes server down.
    const clientId = b.client_id ?? '';
    void this.execute(id, b.prompt, clientId)
      .catch((err: unknown) => this.recordCrash(id, clientId, err))
      .finally(() => this.active.delete(id));
  }

  private recordCrash(id: string, clientId: string, err: unknown): void {
    if (this.closed) return;
    const error = {
      prompt_id: id, node_id: '?', node_type: '?',
      exception_message: err instanceof Error ? err.message : String(err), exception_type: err instanceof Error ? err.name : 'Error',
    };
    this.history.set(id, { prompt: [], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', error]] } });
    this.emit(clientId, 'execution_error', error);
  }

  private writeToDataDir(kind: 'input' | 'output', key: string, bytes: Uint8Array): void {
    if (this.dataDir === null) return;
    const dir = join(this.dataDir, kind, ...key.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, key.split('/').at(-1)!), bytes);
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
      if (this.closed) return;
      this.emit(clientId, 'executing', { node: nodeId, display_node: nodeId, prompt_id: id });
      if (WORKERS.has(node.class_type)) {
        for (let step = 1; step <= 3; step++) {
          this.emit(clientId, 'progress', { value: step, max: 3, prompt_id: id, node: nodeId });
          await this.delayMs(2);
          if (this.closed) return;
        }
      }
      await this.delayMs(2);
      if (this.closed) return;
    }
    if (this.completeAfterQueuePolls > 0) {
      await this.waitForQueuePolls(this.completeAfterQueuePolls);
      if (this.closed) return;
    }
    if (this.completionDelayMs > 0) {
      await this.delayMs(this.completionDelayMs);
      if (this.closed) return;
    }
    await this.delayMs(25);
    if (this.closed) return;
    if (this.interruptNext) {
      this.interruptNext = false;
      const node = nodes.find(([, n]) => WORKERS.has(n.class_type)) ?? nodes[0];
      const interrupted = { prompt_id: id, node_id: node?.[0] ?? '?', node_type: node?.[1].class_type ?? '?', executed: [] };
      this.history.set(id, {
        prompt: [], outputs: {},
        status: { status_str: 'error', completed: false, messages: [['execution_start', { prompt_id: id }], ['execution_interrupted', interrupted]] },
      });
      this.emit(clientId, 'execution_interrupted', interrupted);
      return;
    }
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
    // ComfyUI's SaveImage: filename_prefix "a/b/c" → subfolder "a/b", file "c_00001_.png".
    const prefix = String(save?.[1].inputs['filename_prefix'] ?? 'fake').split('/');
    const subfolder = prefix.slice(0, -1).join('/');
    const filename = `${prefix.at(-1) || 'fake'}_${String(this.outputs.size + 1).padStart(5, '0')}_.png`;
    const png = encodeSolidPng(width, height, FAKE_COLOR);
    this.outputs.set(outputKey(subfolder, filename), png);
    if (save) this.writeToDataDir('output', outputKey(subfolder, filename), png);
    this.history.set(id, {
      prompt: [],
      outputs: save ? { [save[0]]: { images: [{ filename, subfolder, type: 'output' }] } } : {},
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
