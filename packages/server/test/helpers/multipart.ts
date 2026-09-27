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
