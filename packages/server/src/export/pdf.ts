// packages/server/src/export/pdf.ts
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/** Spec §10: "A chapter PDF is the page PDFs merged with pdf-lib". */
export async function mergePdfs(inputs: string[], outPath: string): Promise<string> {
  const doc = await PDFDocument.create();
  for (const file of inputs) {
    const src = await PDFDocument.load(await readFile(file));
    for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
  }
  await writeFile(outPath, await doc.save());
  return outPath;
}
