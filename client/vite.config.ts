import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    license: { fileName: "THIRD-PARTY-LICENSES.md" },
  },
  server: {
    port: 6173,
    proxy: {
      "/api": "http://127.0.0.1:6174",
    },
  },
});
