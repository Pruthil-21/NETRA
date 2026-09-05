'use client';

import { useCallback, useEffect, useState } from 'react';
import { Theme, THEME_STORAGE_KEY } from '@/lib/theme';

function readCurrentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Reads whatever theme app/layout.tsx's inline script already applied
 * pre-paint (see lib/theme.ts) -- this hook never decides the theme itself,
 * it only reflects/toggles the [data-theme] attribute that script set. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(readCurrentTheme());
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      if (next === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Private browsing / quota exceeded -- the toggle still works for
        // this page load, it just won't be remembered on the next one.
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
