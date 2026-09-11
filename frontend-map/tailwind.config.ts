import type { Config } from "tailwindcss";

// Each token below is an "R G B" triplet CSS variable (see app/globals.css),
// not a hex string -- this builds the rgb(var(--x) / <alpha-value>) form
// Tailwind needs to honor a `/NN` opacity modifier (bg-command/10,
// border-signal-red/30, ...) on a CSS-variable-backed color. Passing the
// bare variable string instead (as this file used to) renders the base
// color fine but silently drops to fully transparent on any `/NN` use --
// found via the alert banner's Acknowledge button rendering invisible.
function withOpacity(variable: string): string {
  // Tailwind accepts a function here at runtime (its documented pattern for
  // opacity-modifier-capable CSS-variable colors) even though this
  // version's bundled Config type only declares `string`, hence the cast.
  return ((({ opacityValue }: { opacityValue?: string }) =>
    opacityValue === undefined ? `rgb(var(${variable}))` : `rgb(var(${variable}) / ${opacityValue})`) as unknown) as string;
}

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Every value here is a CSS variable defined in app/globals.css --
      // that's the actual light/dark design-system foundation (token
      // definitions, theming rules, which colors are deliberately left
      // theme-invariant and why). Nothing below picks a color; it only
      // wires Tailwind's class names to the variables that do.
      colors: {
        white: withOpacity('--color-white'),
        ink: withOpacity('--color-ink'),
        panel: withOpacity('--color-panel'),
        'panel-raised': withOpacity('--color-panel-raised'),
        line: withOpacity('--color-line'),
        command: {
          DEFAULT: withOpacity('--color-command'),
          dim: withOpacity('--color-command-dim'),
        },
        signal: {
          amber: withOpacity('--color-signal-amber'),
          green: withOpacity('--color-signal-green'),
          red: withOpacity('--color-signal-red'),
        },
        // gray and slate are the same palette under two names -- both were
        // used interchangeably for the same "muted text / dark surface"
        // role across the app before this pass; aliasing them to identical
        // variables unifies them visually without renaming every call site.
        slate: {
          100: withOpacity('--color-slate-100'),
          200: withOpacity('--color-slate-200'),
          300: withOpacity('--color-slate-300'),
          400: withOpacity('--color-slate-400'),
          500: withOpacity('--color-slate-500'),
          600: withOpacity('--color-slate-600'),
          700: withOpacity('--color-slate-700'),
          800: withOpacity('--color-slate-800'),
          900: withOpacity('--color-slate-900'),
          950: withOpacity('--color-slate-950'),
        },
        gray: {
          100: withOpacity('--color-slate-100'),
          200: withOpacity('--color-slate-200'),
          300: withOpacity('--color-slate-300'),
          400: withOpacity('--color-slate-400'),
          500: withOpacity('--color-slate-500'),
          600: withOpacity('--color-slate-600'),
          700: withOpacity('--color-slate-700'),
          800: withOpacity('--color-slate-800'),
          900: withOpacity('--color-slate-900'),
          950: withOpacity('--color-slate-950'),
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
