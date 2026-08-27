/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          dark: "#0b0f19",
          card: "#111827",
          border: "#1f2937",
        },
      },
    },
  },
  plugins: [],
};
