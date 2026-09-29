import type { JSX } from 'react';
import { IconButton } from '../ui/IconButton';
import { Check, X } from '../ui/icons';
import { Modal } from '../ui/Modal';

export function ConfirmPresetModal({ open, preset, removed, busy, onCancel, onConfirm }: {
  open: boolean; preset: string; removed: number; busy: boolean; onCancel(): void; onConfirm(): void;
}): JSX.Element | null {
  return (
    <Modal open={open} onClose={onCancel} title="Replace layout?">
      <p>“{preset}” has fewer panels: {removed} {removed === 1 ? 'panel' : 'panels'} and their images will be removed. This cannot be undone.</p>
      <div className="form-actions">
        <IconButton icon={X} label="Keep the current layout" onClick={onCancel} />
        <IconButton icon={Check} tone="danger" label="Apply layout" busy={busy} onClick={onConfirm} />
      </div>
    </Modal>
  );
}
