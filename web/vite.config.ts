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
    rollupOptions: {
      output: {
        /*
          RENAME THE SDK'S CHUNK. Do not move it.

          Vite already splits `@anam-ai/js-sdk` out on its own, because
          `lib/anam/session.ts` is the single place that imports it and does so
          dynamically — that part needs no help. What it does NOT do is name
          the chunk usefully: the package's entry file is `index.js`, so the
          emitted chunk is `index-<hash>.js`, indistinguishable at a glance
          from the app's own entry chunk. That defeats the release check that
          voice was kept out of the entry:

            grep -c anam dist/assets/index-*.js   # expect 0
            ls dist/assets | grep -i anam         # expect exactly one chunk

          `chunkFileNames` renames; `manualChunks` would RESHAPE. The
          distinction is not pedantic — it was tried, and forcing the package
          into a named group pulled a shared Rollup interop helper in with it,
          which left the ENTRY chunk carrying a static
          `import ... from "./anam-*.js"`. The SDK would then have loaded on
          every page view: precisely the thing the dynamic import exists to
          prevent, arrived at by trying to label it.
        */
        chunkFileNames: (chunk) =>
          // `moduleIds`, not `modules`: names are resolved before `modules` is
          // populated, and reading it there throws during the render pass.
          chunk.moduleIds.some((id) => id.includes("@anam-ai/js-sdk"))
            ? "assets/anam-[hash].js"
            : "assets/[name]-[hash].js",
      },
    },
  },
});
