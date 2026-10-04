import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env.FORGE_PORT ?? 4317);

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
