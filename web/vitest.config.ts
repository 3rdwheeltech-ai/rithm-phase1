import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    // Playwright specs live under e2e/ and are not vitest's to run.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
