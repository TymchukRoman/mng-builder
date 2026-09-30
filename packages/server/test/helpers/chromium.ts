import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Whether Playwright's headless Chromium is installed (M4 final M9): the headless shell from
 * `npx playwright install --only-shell chromium` (what export launches), or the full browser. Tests that launch it
 * skip without it, with the reason in their suite name, instead of failing `npm test`.
 */
export function hasHeadlessChromium(): boolean {
  const full = chromium.executablePath(); // <browsers>/chromium-<rev>/…; the shell sits beside it
  if (existsSync(full)) return true;
  const match = /[\\/]chromium-(\d+)[\\/]/.exec(full);
  return match !== null && existsSync(join(full.slice(0, match.index), `chromium_headless_shell-${match[1]}`, 'INSTALLATION_COMPLETE'));
}
