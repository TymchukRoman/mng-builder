import { PassThrough } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/** A single-file multipart/form-data body for app.inject(). */
export function multipart(field: string, filename: string, contentType: string, data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----manga-test-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/**
 * Streams a single-file upload, running `meanwhile` once the route has started reading it and before the body ends
 * (to delete the owner mid-upload, say).
 */
export async function uploadWhile(app: FastifyInstance, url: string, data: Buffer, meanwhile: () => Promise<void>): Promise<LightMyRequestResponse> {
  const form = multipart('file', 'art.png', 'image/png', data);
  const body = new PassThrough();
  const pending = app.inject({ method: 'POST', url, payload: body, headers: form.headers });
  body.write(form.payload.subarray(0, 60));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await meanwhile();
  body.end(form.payload.subarray(60));
  return pending;
}
