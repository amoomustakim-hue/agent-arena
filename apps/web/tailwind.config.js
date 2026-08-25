/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // The war room is built on one near-black ground with layered panels,
        // so density never turns into mush.
        void: "#05070b",
        panel: "#0a0e15",
        panel2: "#0e141d",
        hair: "#1b2431",
        hair2: "#273347",
        dim: "#5d6b80",
        mid: "#8c9bb0",
        bright: "#dce6f2",

        // Evidence: the product's intellectual core, encoded as two colours.
        indep: "#2ee6a8", // independent — can justify disagreeing with the market
        circ: "#ff9d3d", // circular — this is what the market already thinks

        bull: "#3ddc84",
        bear: "#ff5d6c",
        forensics: "#7aa2ff",
        adversarial: "#c07bff",
        risk: "#ffd23f",
        judge: "#4fe3e3",
        trader: "#94a3b8",

        fatal: "#ff3b4e",
        material: "#ffb020",
        minor: "#6b7d94",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "JetBrains Mono",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "13px", letterSpacing: "0.08em" }],
      },
      boxShadow: {
        panel: "0 0 0 1px #1b2431, 0 18px 48px -28px rgba(0,0,0,0.95)",
        glow: "0 0 24px -6px currentColor",
      },
      keyframes: {
        pulseRec: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.25" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(300%)" },
        },
      },
      animation: {
        rec: "pulseRec 1.6s ease-in-out infinite",
        sweep: "sweep 2.6s linear infinite",
      },
    },
  },
  plugins: [],
};
