import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#05070a",
          900: "#0a0d13",
          800: "#0d121a",
          700: "#131a24",
          600: "#1c2530",
        },
        line: "#1c232e",
        mesh: {
          DEFAULT: "#4fd1c5",
          dim: "#2c5a56",
        },
        claim: {
          DEFAULT: "#f5b942",
          dim: "#8a6a2c",
        },
        fg: {
          DEFAULT: "#e8ecf1",
          muted: "#93a1b3",
          faint: "#5b6779",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        grid: "linear-gradient(to right, rgba(232,236,241,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(232,236,241,0.04) 1px, transparent 1px)",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
