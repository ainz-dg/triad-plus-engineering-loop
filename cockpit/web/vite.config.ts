import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Output goes to ../dist, which ships in the triad-plus npm package and is
// served by cockpit/server/static.mjs under a strict CSP (no inline script or
// style, no external origins). Keep the build free of inline code.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    reportCompressedSize: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    environmentOptions: { jsdom: { url: "http://127.0.0.1/" } },
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 20000,
    server: { deps: { inline: [] } },
  },
});
