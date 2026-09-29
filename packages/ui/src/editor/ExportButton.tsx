import type { JSX } from 'react';
import { IconButton } from '../ui/IconButton';
import { Download } from '../ui/icons';

/** M4 extension slot (Contract E): M4 replaces this with an enabled button that POSTs /api/export for `target`. */
export function ExportButton(_props: { target: { type: 'page' | 'chapter'; id: string } | null }): JSX.Element {
  return <IconButton icon={Download} label="Export (coming soon)" disabled />;
}
