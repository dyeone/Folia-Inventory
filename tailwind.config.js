/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // The app's accent color (`emerald-*`, used in ~750 places) is the active
      // brand's color, not a fixed green. We map every emerald shade to a CSS
      // variable so switching brands re-themes the whole UI with no per-file
      // changes. Defaults to Folia green; `[data-brand="bae"]` flips it to red.
      // See the brand palettes in src/index.css. Channels are space-separated
      // RGB so Tailwind opacity modifiers (bg-emerald-600/20) still work.
      colors: {
        emerald: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
          800: "rgb(var(--brand-800) / <alpha-value>)",
          900: "rgb(var(--brand-900) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
