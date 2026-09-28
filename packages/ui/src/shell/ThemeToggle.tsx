import type { JSX } from 'react';
import { useTheme } from '../theme';
import { IconButton } from '../ui/IconButton';
import { Moon, Sun } from '../ui/icons';

export function ThemeToggle(): JSX.Element {
  const { theme, toggle } = useTheme();
  return <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle} />;
}
