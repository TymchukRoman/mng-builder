// Stands in for the `claude` binary in tests: node fake-claude.mjs <fixture|hang|logged-in|logged-out> <record.json> ...claudeArgs
import { readFileSync, writeFileSync } from 'node:fs';

const [, , fixture = '', record = '', ...args] = process.argv;

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: fixture === 'logged-in', authMethod: fixture === 'logged-in' ? 'claude.ai' : 'none' }));
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  writeFileSync(record, JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    env: {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      claudeCode: process.env.CLAUDECODE ?? null,
      hasPath: Boolean(process.env.PATH),
    },
  }));
  if (fixture === 'hang') {
    setInterval(() => {}, 1_000);
    return;
  }
  process.stdout.write(readFileSync(fixture, 'utf8'));
});
