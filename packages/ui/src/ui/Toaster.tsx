import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../lib/store';
import { IconButton } from './IconButton';
import { CircleCheck, CircleX, X } from './icons';
import { dismissToast, toastStore } from './toasts';

export function Toaster(): JSX.Element {
  const toasts = useStore(toastStore);
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'error' ? <CircleX size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}
          <span className="toast__text">{t.text}</span>
          <IconButton icon={X} label="Dismiss" size="sm" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
