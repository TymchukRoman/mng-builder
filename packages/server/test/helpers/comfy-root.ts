import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temp comfyRoot that looks installed: ComfyUI/.venv/Scripts/python.exe and ComfyUI/main.py exist (empty). */
export function fakeComfyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'comfy-root-'));
  mkdirSync(join(root, 'ComfyUI', '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(root, 'ComfyUI', 'main.py'), '');
  return root;
}
