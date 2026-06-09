import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#06060e",
        brand: {
          DEFAULT: "rgb(108 92 231)",
          soft: "rgb(162 150 255)",
        },
        ink: {
          DEFAULT: "#eaeaec",
          muted: "rgba(234, 234, 236, 0.48)",
          faint: "rgba(234, 234, 236, 0.26)",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "-apple-system", "sans-serif"],
        display: ['"Audiowide"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "22px",
        el: "12px",
      },
      letterSpacing: {
        wordmark: "0.28em",
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
