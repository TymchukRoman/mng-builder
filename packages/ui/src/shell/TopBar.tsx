import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router';
import { useConnection } from '../events';
import { IconButton } from '../ui/IconButton';
import { Settings } from '../ui/icons';
import { StatusLoader } from '../ui/StatusLoader';
import { EngineSwitch } from './EngineSwitch';
import { GpuPausedChip } from './GpuQueueControl';
import { JobsIndicator } from './JobsIndicator';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

export function TopBar(): JSX.Element {
  const navigate = useNavigate();
  const connection = useConnection();
  return (
    <header className="topbar">
      <Link to="/" className="topbar__brand" aria-label="All manga" data-tip="All manga">
        <Logo />
      </Link>
      <div className="spacer" />
      {connection === 'closed' && <StatusLoader label="Reconnecting to server" className="topbar__conn" />}
      <GpuPausedChip />
      <EngineSwitch />
      <JobsIndicator />
      <ThemeToggle />
      <IconButton icon={Settings} label="Settings" onClick={() => navigate('/settings')} />
    </header>
  );
}
