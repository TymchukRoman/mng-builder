import type { FastifyRequest } from 'fastify';
import { ValidationError } from '../errors.js';

export interface IdParams { Params: { id: string } }

export const OK = { ok: true } as const;

// Controller ruling (M1 pre-flight R6): emitEntity is defined once in events/bus.ts, next to EventBus, so M2 and
// M4 — which may only import from events/bus.js — can use it without copying it. This re-export keeps every
// importer of api/util.js (as the brief shows them) working unchanged.
export { emitEntity } from '../events/bus.js';

export interface Upload { bytes: Buffer; mimetype: string; filename: string }

/** Reads the single multipart field `file` into memory (limit set in buildApp). */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw new ValidationError('expected a multipart/form-data upload with a "file" field');
  const file = await req.file();
  if (file === undefined) throw new ValidationError('the upload has no "file" field');
  if (file.fieldname !== 'file') throw new ValidationError(`expected the upload in a field named "file", got "${file.fieldname}"`);
  return { bytes: await file.toBuffer(), mimetype: file.mimetype, filename: file.filename };
}
