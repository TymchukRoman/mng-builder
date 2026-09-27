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
