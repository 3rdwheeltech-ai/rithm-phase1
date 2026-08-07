import type { Config } from "tailwindcss";

/**
 * "Control Room" — the design tokens for the Liquid Glass UI.
 *
 * The palette comes from the product's own subject: a studio. Graphite room,
 * a signal-teal LED for anything live, tube amber for warmth and warnings.
 *
 * Colours are declared as `rgb(...)` triples rather than hex so Tailwind's
 * opacity modifiers (`bg-signal/15`, `border-signal/25`) compose correctly.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        room: {
          DEFAULT: "rgb(7 9 12)", // #07090C — the room itself
          raised: "rgb(12 16 20)", // #0C1014 — opaque content plane
          sunken: "rgb(5 7 8)", // recessed wells (inputs, tracks)
        },
        signal: {
          DEFAULT: "rgb(52 227 200)", // #34E3C8 — live / active / playing
          dim: "rgb(31 168 148)", // #1FA894 — pressed, borders
          bright: "rgb(125 243 226)", // #7DF3E2 — highlights, icons on dark
        },
        amber: {
          DEFAULT: "rgb(255 180 84)", // #FFB454 — record, warm accent
          dim: "rgb(201 138 58)",
        },
        danger: {
          DEFAULT: "rgb(255 107 107)", // #FF6B6B
          dim: "rgb(199 78 78)",
        },
        ink: {
          DEFAULT: "rgb(236 239 242)", // #ECEFF2
          // Kept at these names because the app references them widely. The
          // faint value is raised from the old 0.42 — that failed WCAG AA over
          // translucent glass.
          muted: "rgba(236, 239, 242, 0.62)",
          faint: "rgba(236, 239, 242, 0.52)",
        },

        // Alias kept because `bg-void` reads better than `bg-room` on the body.
        void: "rgb(7 9 12)",
      },

      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "-apple-system", "sans-serif"],
        display: ['"Archivo"', "system-ui", "sans-serif"],
        // Timecode, BPM, elapsed, counters — a console reads its numbers in mono.
        mono: ['"Geist Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },

      /**
       * A real scale, replacing the ~15 one-off `text-[13.5px]` values that were
       * scattered through the app. Line heights and tracking are baked in so
       * headings tighten as they grow, the way a type system should.
       */
      fontSize: {
        "2xs": ["11px", { lineHeight: "15px", letterSpacing: "0.01em" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["14.5px", { lineHeight: "21px" }],
        md: ["16px", { lineHeight: "24px" }],
        lg: ["18px", { lineHeight: "25px", letterSpacing: "-0.01em" }],
        xl: ["22px", { lineHeight: "28px", letterSpacing: "-0.02em" }],
        "2xl": ["28px", { lineHeight: "34px", letterSpacing: "-0.022em" }],
        "3xl": ["36px", { lineHeight: "42px", letterSpacing: "-0.025em" }],
      },

      letterSpacing: {
        wordmark: "0.28em",
        eyebrow: "0.18em",
      },

      /**
       * Larger and softer than before (card was 16px). Liquid Glass leans on
       * generous radii, and the concentric-radius rule in index.css derives
       * inner corners from these.
       */
      borderRadius: {
        sheet: "28px",
        card: "20px",
        el: "12px",
        control: "10px",
      },

      spacing: {
        "safe-b": "env(safe-area-inset-bottom)",
        "safe-t": "env(safe-area-inset-top)",
      },

      transitionTimingFunction: {
        // Apple's sheet curve — for anything that moves or morphs.
        sheet: "cubic-bezier(0.32, 0.72, 0, 1)",
        // For things arriving on screen.
        entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
      },

      screens: {
        xs: "400px",
      },

      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(14px) scale(0.985)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        rise: "rise 0.6s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 0.5s ease both",
      },
    },
  },
  plugins: [],
} satisfies Config;
