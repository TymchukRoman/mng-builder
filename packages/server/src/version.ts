import { readFileSync } from 'node:fs';

/** The server package version (src/ and dist/ both sit one level below package.json). */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
