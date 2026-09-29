import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { ErrorState } from '../src/ui/ErrorState';

const noop = (): void => undefined;
const render = (el: JSX.Element): string => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe('ErrorState (M2)', () => {
  it('says what failed, with Retry and Back icon buttons that carry aria-label and data-tip', () => {
    const html = render(<ErrorState error={new ApiError(404, 'not_found', 'chapter ch_x not found')} onRetry={noop} backTo="/m/mg_1" backLabel="Back to the manga" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('chapter ch_x not found');
    for (const label of ['Retry', 'Back to the manga']) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`data-tip="${label}"`);
    }
  });
  it('takes a fixed text instead of an error, and shows only the buttons it is given', () => {
    const html = render(<ErrorState text="Not found" backTo="/" />);
    expect(html).toContain('Not found');
    expect(html).toContain('aria-label="Back"');
    expect(html).not.toContain('aria-label="Retry"');
    expect(render(<ErrorState error={new Error('boom')} />)).not.toContain('<button');
  });
  it('marks Retry busy while retrying', () => {
    expect(render(<ErrorState error={new Error('boom')} onRetry={noop} retrying />)).toMatch(/<button[^>]*aria-label="Retry"[^>]*aria-busy="true"|<button[^>]*aria-busy="true"[^>]*aria-label="Retry"/);
  });
});
