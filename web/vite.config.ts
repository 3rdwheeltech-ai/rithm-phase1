import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      // Music generation proxy (gen-proxy). The blocking /generate call can take
      // minutes, so timeouts are raised well above vite's defaults.
      "/gen": {
        target: "http://localhost:8090",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gen/, ""),
        timeout: 600000,
        proxyTimeout: 600000,
      },
    },
  },
});
