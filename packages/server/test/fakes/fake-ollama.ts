import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOllamaRequest { method: string; path: string; body: Record<string, unknown> | null }
/** A plain string sets message.content. An object also lets a test set message.thinking, to exercise
 *  OllamaEngine's fallback for replies that land there with content left empty (live: qwen3-vl:8b + think:false). */
export type FakeOllamaReply = string | { content: string; thinking?: string };
export interface FakeOllama {
  url: string;
  requests: FakeOllamaRequest[];
  /** Answers for /api/chat, consumed in order; '{}' when empty. */
  replies: FakeOllamaReply[];
  /** Pulled models (/api/tags). */
  models: string[];
  /** Models currently loaded (/api/ps): added by /api/chat, removed by keep_alive 0. */
  loaded: Set<string>;
  close(): Promise<void>;
}

export async function startFakeOllama(opts: { models?: string[]; replies?: FakeOllamaReply[] } = {}): Promise<FakeOllama> {
  const requests: FakeOllamaRequest[] = [];
  const replies: FakeOllamaReply[] = [...(opts.replies ?? [])];
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
        const reply = replies.shift() ?? '{}';
        const message = typeof reply === 'string'
          ? { role: 'assistant', content: reply }
          : { role: 'assistant', content: reply.content, ...(reply.thinking !== undefined ? { thinking: reply.thinking } : {}) };
        return json(200, { model, message, done: true });
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
