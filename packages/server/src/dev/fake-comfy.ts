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
