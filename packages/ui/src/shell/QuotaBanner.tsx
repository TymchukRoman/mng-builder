import type { JSX } from 'react';
import { useStatus } from '../queries';
import { Clock } from '../ui/icons';
import { pausedBanner } from './engineState';

export function QuotaBanner(): JSX.Element | null {
  const text = pausedBanner(useStatus().data);
  if (!text) return null;
  return <div className="banner banner--warn" role="status"><Clock size={14} aria-hidden /><span>{text}</span></div>;
}
