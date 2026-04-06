import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        base: "var(--bg-base)",
        surface: "var(--bg-surface)",
        "surface-hover": "var(--bg-surface-hover)",
        "coach-bubble": "var(--bg-coach-bubble)",
        "athlete-bubble": "var(--bg-athlete-bubble)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
        },
      },
      textColor: {
        primary: "var(--text-primary)",
        muted: "var(--text-muted)",
        streaming: "var(--text-streaming)",
      },
      borderColor: {
        default: "var(--border-default)",
        hover: "var(--border-hover)",
      },
    },
  },
  plugins: [],
};
export default config;
