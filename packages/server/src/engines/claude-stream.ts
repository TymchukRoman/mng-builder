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
  | { kind: 'init'; tools: string[] | null }
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
      // `null` means the init event carried no tools array at all (malformed/unexpected shape), distinct
      // from a genuinely empty array (a run that legitimately declared zero tools). Callers that must
      // verify the toolset (ClaudeEngine) fail closed on `null`; they must not treat it as "no tools".
      const tools = raw['tools'];
      return { kind: 'init', tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : null };
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
  onInit?: (tools: string[] | null) => void;
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
