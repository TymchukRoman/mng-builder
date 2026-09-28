// Stands in for the `claude` binary in tests: node fake-claude.mjs <fixture|hang|crash|logged-in|logged-out> <record.json> ...claudeArgs
// crash: reports an empty toolset, then fails with a generic error on stderr and exit code 1 (no result event).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [, , fixture = '', record = '', ...args] = process.argv;

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: fixture === 'logged-in', authMethod: fixture === 'logged-in' ? 'claude.ai' : 'none' }));
  process.exit(0);
}

const baseRecord = () => ({
  args,
  cwd: process.cwd(),
  pid: process.pid,
  env: {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    claudeCode: process.env.CLAUDECODE ?? null,
    hasPath: Boolean(process.env.PATH),
  },
});

// write+rename, never a direct writeFileSync onto `record`: a reader (a test killing this process, or
// racing it under load) must never observe a truncated/partial file. rename() is a single filesystem
// metadata operation, so a concurrent read of `record` always sees either the previous complete write or
// the new one, never a half-written one.
function writeRecordAtomically(data) {
  const tmp = `${record}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, record);
}

// Written synchronously right away, before stdin is even read: a caller that kills this process quickly
// (an abort test) must still be able to find its pid without waiting on a full stdin round trip through
// the pipe, which can lag under system load. Overwritten below, once stdin actually ends, with the real
// stdin content for the tests that check it.
if (record) writeRecordAtomically({ ...baseRecord(), stdin: null });

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  writeRecordAtomically({ ...baseRecord(), stdin });
  if (fixture === 'hang') {
    setInterval(() => {}, 1_000);
    return;
  }
  if (fixture === 'crash') {
    const init = { type: 'system', subtype: 'init', cwd: process.cwd(), session_id: '00000000-0000-4000-8000-000000000009', tools: [], mcp_servers: [] };
    process.stdout.write(`${JSON.stringify(init)}\n`, () => {
      process.stderr.write('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}\n', () => process.exit(1));
    });
    return;
  }
  process.stdout.write(readFileSync(fixture, 'utf8'));
});
