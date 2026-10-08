import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` produces a single self-contained dist/index.html that opens
// straight from disk (file://) — handy for sharing the game as one file.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: "es2022", assetsInlineLimit: Infinity },
});
