import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2023",
    sourcemap: true
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    css: true
  }
});
