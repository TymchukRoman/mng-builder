import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { cx } from '../lib/cx';
import { IconButton } from './IconButton';
import { ArrowLeft, RefreshCw, TriangleAlert } from './icons';
import { errorText } from './toasts';

/**
 * A failed load (M2): says what failed, and offers the next step as icon buttons: Retry (`onRetry`) and a way back
 * (`backTo`). `text` replaces the error's own message, e.g. "Not found" for a route whose id is not valid.
 */
export function ErrorState({ error, text, onRetry, retrying = false, backTo, backLabel = 'Back', className }: {
  error?: unknown; text?: string; onRetry?: (() => void) | undefined; retrying?: boolean; backTo?: string | undefined; backLabel?: string; className?: string;
}): JSX.Element {
  const navigate = useNavigate();
  return (
    <div role="alert" className={cx('error-state', className)}>
      <TriangleAlert size={14} aria-hidden className="error-state__icon" />
      <span className="error-state__text">{text ?? errorText(error)}</span>
      {onRetry && <IconButton icon={RefreshCw} label="Retry" size="sm" busy={retrying} onClick={onRetry} />}
      {backTo !== undefined && <IconButton icon={ArrowLeft} label={backLabel} size="sm" onClick={() => void navigate(backTo)} />}
    </div>
  );
}
