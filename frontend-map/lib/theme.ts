export const THEME_STORAGE_KEY = 'netra_theme';
export type Theme = 'dark' | 'light';

/** Runs before hydration (see app/layout.tsx) so the [data-theme] attribute
 * is already correct on the very first paint -- setting it later, from a
 * React effect, would flash the wrong theme for a frame. Kept as a plain
 * string (not an imported function) because it has to be inlined into a
 * <script> tag; Next.js can't bundle a real import into that. */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {}
})();
`;
