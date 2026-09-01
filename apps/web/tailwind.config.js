/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Black and white, deliberately — no hue anywhere in the base
        // palette. Every state that used to be a color (which agent, which
        // severity, independent vs. circular) is now carried by weight,
        // fill, border, and icon instead. High contrast reads as "premium
        // trading terminal"; a rainbow of accent hues reads as sci-fi.
        void: "#0a0a0a",
        panel: "#111111",
        panel2: "#161616",
        hair: "#262626",
        hair2: "#363636",
        dim: "#8a8a8a",
        mid: "#b8b8b8",
        bright: "#f5f5f5",

        // The one deliberate exception: independent-vs-circular evidence is
        // this product's actual intellectual claim, not decoration, so it
        // keeps a real visual distinction — but as a tint/fill difference on
        // a still-monochrome base (warm white vs. nothing), not a hue.
        indep: "#f5f5f5",
        circ: "#8a8a8a",

        // Agents are distinguished by label + a filled-vs-outlined dot, not
        // by color — see AGENT_COLOR in ui.tsx, which now maps every role to
        // the same white.
        bull: "#f5f5f5",
        bear: "#f5f5f5",
        forensics: "#f5f5f5",
        adversarial: "#f5f5f5",
        risk: "#f5f5f5",
        judge: "#f5f5f5",
        trader: "#f5f5f5",

        // Severity keeps the one other real semantic distinction (a fatal
        // finding is not the same as a minor one) but expressed as fill
        // weight on white rather than a stoplight.
        fatal: "#ffffff",
        material: "#d4d4d4",
        minor: "#8a8a8a",
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
        // Used for both true micro-labels (uppercase mono tags) AND a lot of
        // actual body content (evidence rows, debate claims, verdict text) —
        // the single biggest source of "congested": tight line-height on
        // wrapped sentences reads as cramped even when the font itself is
        // legible. Bumped size and, more importantly, line-height.
        "2xs": ["11.5px", { lineHeight: "1.5", letterSpacing: "0.06em" }],
      },
      spacing: {
        4.5: "1.125rem",
        18: "4.5rem",
      },
      boxShadow: {
        panel: "0 0 0 1px #262626, 0 18px 48px -28px rgba(0,0,0,0.95)",
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
