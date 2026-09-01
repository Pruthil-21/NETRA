import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: '#05070A',
        panel: '#0E141B',
        'panel-raised': '#141B24',
        line: '#1F2A35',
        command: {
          DEFAULT: '#2F6FED',
          dim: '#1E4FBE',
        },
        signal: {
          amber: '#F5A623',
          green: '#22C55E',
          red: '#EF4444',
        },
        // Ported 1:1 from frontend-dashboard/tailwind.config.js -- the
        // Dashboard page's components (components/dashboard/*, AlertBanner,
        // AlertLog, HlsPlayer) reference these class names directly, so they
        // need to exist for that page to render as designed.
        brand: {
          dark: '#0b0f19',
          card: '#111827',
          border: '#1f2937',
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