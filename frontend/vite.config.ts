import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API base is injected at build time via VITE_API_BASE. In dev we proxy
// /api to the FastAPI backend so the app and API share an origin locally.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
