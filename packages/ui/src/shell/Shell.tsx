import type { JSX } from 'react';
import { Outlet } from 'react-router';
import { useServerEvents } from '../events';
import { Toaster } from '../ui/Toaster';
import { TooltipLayer } from '../ui/TooltipLayer';
import { QuotaBanner } from './QuotaBanner';
import { TopBar } from './TopBar';
import './shell.css';

export function Shell(): JSX.Element {
  useServerEvents();
  return (
    <div className="app">
      <TopBar />
      <QuotaBanner />
      <main className="app-main"><Outlet /></main>
      <TooltipLayer />
      <Toaster />
    </div>
  );
}
