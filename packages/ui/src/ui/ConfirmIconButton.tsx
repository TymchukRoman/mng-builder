import { useEffect, useState, type JSX } from 'react';
import { IconButton } from './IconButton';
import { Check, Trash2, type LucideIcon } from './icons';

/** A two-click destructive action: the first click arms it for 3 s, the second confirms. */
export function ConfirmIconButton({ icon = Trash2, label, confirmLabel = 'Click again to confirm', onConfirm, size = 'md', className }: {
  icon?: LucideIcon; label: string; confirmLabel?: string; onConfirm(): void; size?: 'sm' | 'md'; className?: string;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <IconButton
      icon={armed ? Check : icon}
      label={armed ? confirmLabel : label}
      tone={armed ? 'danger' : 'default'}
      size={size}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) { setArmed(false); onConfirm(); } else setArmed(true);
      }}
    />
  );
}
