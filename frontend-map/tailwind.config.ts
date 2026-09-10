import type { Config } from "tailwindcss";

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
        white: 'var(--color-white)',
        ink: 'var(--color-ink)',
        panel: 'var(--color-panel)',
        'panel-raised': 'var(--color-panel-raised)',
        line: 'var(--color-line)',
        command: {
          DEFAULT: 'var(--color-command)',
          dim: 'var(--color-command-dim)',
        },
        signal: {
          amber: 'var(--color-signal-amber)',
          green: 'var(--color-signal-green)',
          red: 'var(--color-signal-red)',
        },
        // gray and slate are the same palette under two names -- both were
        // used interchangeably for the same "muted text / dark surface"
        // role across the app before this pass; aliasing them to identical
        // variables unifies them visually without renaming every call site.
        slate: {
          100: 'var(--color-slate-100)',
          200: 'var(--color-slate-200)',
          300: 'var(--color-slate-300)',
          400: 'var(--color-slate-400)',
          500: 'var(--color-slate-500)',
          600: 'var(--color-slate-600)',
          700: 'var(--color-slate-700)',
          800: 'var(--color-slate-800)',
          900: 'var(--color-slate-900)',
          950: 'var(--color-slate-950)',
        },
        gray: {
          100: 'var(--color-slate-100)',
          200: 'var(--color-slate-200)',
          300: 'var(--color-slate-300)',
          400: 'var(--color-slate-400)',
          500: 'var(--color-slate-500)',
          600: 'var(--color-slate-600)',
          700: 'var(--color-slate-700)',
          800: 'var(--color-slate-800)',
          900: 'var(--color-slate-900)',
          950: 'var(--color-slate-950)',
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
