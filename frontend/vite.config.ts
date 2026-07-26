import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API remains same-origin in every deployed environment. Development uses
// a local reverse proxy so Django's session and CSRF cookies behave the same.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8002",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
