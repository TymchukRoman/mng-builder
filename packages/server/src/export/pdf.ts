// packages/server/src/export/pdf.ts
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/**
 * Spec §10: "A chapter PDF is the page PDFs merged with pdf-lib". Written atomically (M3, review): a temp file in the same
 * folder, then a rename, so a crash mid-write never leaves a truncated `outPath` (the previous one stays until the rename).
 */
export async function mergePdfs(inputs: string[], outPath: string): Promise<string> {
  const doc = await PDFDocument.create();
  for (const file of inputs) {
    const src = await PDFDocument.load(await readFile(file));
    for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
  }
  const temp = `${outPath}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, await doc.save());
    await rename(temp, outPath);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return outPath;
}
