/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In dev the browser talks to Vite, which forwards /api to Express, so there is
    // no cross-origin request. The server still has an explicit CORS allowlist for other setups.
    proxy: { "/api": "http://localhost:3001" },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], globals: true, css: false },
});
