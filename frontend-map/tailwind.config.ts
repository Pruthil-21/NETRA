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