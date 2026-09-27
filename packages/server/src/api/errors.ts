import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { LayoutError, type ApiErrorBody } from '@manga/shared';
import { HttpError, type ApiErrorCode } from '../errors.js';

export interface ApiErrorReply { status: number; body: ApiErrorBody }

function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Maps anything a route throws to the contract's ApiErrorBody and HTTP status. */
export function toApiError(err: unknown): ApiErrorReply {
  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'body'}: ${issue.message}`)
      .join('; ');
    return { status: 400, body: errorBody('validation', message, err.issues) };
  }
  if (err instanceof HttpError) return { status: err.status, body: errorBody(err.code, err.message, err.details) };
  if (err instanceof LayoutError) {
    return err.code === 'not-found'
      ? { status: 404, body: errorBody('not_found', err.message, { layoutError: err.code }) }
      : { status: 400, body: errorBody('validation', err.message, { layoutError: err.code }) };
  }
  const statusCode = typeof err === 'object' && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { status: 400, body: errorBody('validation', err instanceof Error ? err.message : 'bad request') };
  }
  return { status: 500, body: errorBody('internal', 'internal error') };
}

/** SQLite text and file paths go to the log, never to the client. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const out = toApiError(err);
    if (out.status >= 500) console.error(`[manga] ${req.method} ${req.url.split('?')[0] ?? ''} failed:`, err);
    return reply.code(out.status).send(out.body);
  });
}
