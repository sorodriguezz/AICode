import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing, so its own output stays visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/mods/**"] } },
  build: {
    target: "safari16",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: "es" },
});
