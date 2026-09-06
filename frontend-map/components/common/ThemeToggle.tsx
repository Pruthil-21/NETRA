'use client';

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-panel-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
    >
      {isLight ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  );
}
