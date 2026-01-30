import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: path.resolve(__dirname, "main.jsx"),
      output: {
        entryFileNames: "sticker-configurator.js",
        assetFileNames: "sticker-configurator.[ext]"
      }
    }
  }
});
