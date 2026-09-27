import type { ApiErrorBody } from '@manga/shared';

export type ApiErrorCode = ApiErrorBody['error']['code'];

/** An error that already knows its HTTP status and ApiErrorBody code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(entity: string, id: string) {
    super(404, 'not_found', `${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation', message, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details);
    this.name = 'ConflictError';
  }
}

/** A request from somewhere the server does not serve (not loopback, a foreign Host or Origin). */
export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, 'forbidden', message);
    this.name = 'ForbiddenError';
  }
}

/** A row whose stored JSON no longer matches its schema. Never shown to clients in detail. */
export class StoreCorruptError extends HttpError {
  constructor(entity: string, id: string, detail: string) {
    super(500, 'internal', `${entity} ${id} has invalid stored data: ${detail}`);
    this.name = 'StoreCorruptError';
  }
}
