/* eslint-env node */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dev server mirrors CloudFront's shape: the SPA sees a relative `/api/v1`
 * here exactly as it does in production, so there is no build-time branch and
 * no "works in dev only" class of bug.
 *
 * Point VITE_DEV_API_TARGET at the ALB to develop against deployed
 * infrastructure. If you find yourself setting an absolute API base and hitting
 * CORS, you have gone off the path — the answer is this proxy, not a CORS entry.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    // Maps go to Sentry, not into the public bundle (deploy-web.yml excludes
    // them from the sync as a second line of defence).
    sourcemap: false,
  },
});
