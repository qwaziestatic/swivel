import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Main build pass: the side panel (React) and the background service worker.
 *
 * Both entries are ES modules, so they can share one Rollup graph:
 * - the manifest declares the worker with "type": "module", which lets
 *   background.js use real `import` statements for any shared chunks
 *   (e.g., src/shared/messages.ts) that Rollup splits out.
 * - the side panel is an ordinary HTML entry; Vite rewrites its asset URLs.
 *
 * Content scripts are NOT in this pass. Chrome injects content scripts as
 * classic scripts — they cannot be ES modules and cannot import chunks —
 * so they get their own build pass (vite.content.config.ts) that produces
 * a single self-contained IIFE file.
 *
 * Dev loop: `npm run watch` keeps both passes rebuilding on save; you then
 * click Reload on the extension card in chrome://extensions (and reload the
 * target page if a content script changed). No HMR — MV3 CSP and the
 * worker lifecycle make HMR more trouble than it is worth.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    // Never empty dist/ from a build pass: in `npm run watch` FOUR watchers
    // (app + three content scripts) share this outDir, and `vite build
    // --watch` re-empties on EVERY rebuild — an app edit would silently
    // delete gmail.js/content.js/generic.js until their (unchanged, hence
    // idle) watchers ran again. `npm run clean` owns wiping dist/ instead.
    emptyOutDir: false,
    rollupOptions: {
      input: {
        // Relative paths resolve against the project root — keeps the
        // config free of Node globals so it typechecks under the same
        // strict browser-targeted tsconfig as the app code.
        sidepanel: "sidepanel.html",
        background: "src/background/index.ts",
      },
      output: {
        // The manifest points at a fixed "background.js", so that entry must
        // have a stable, un-hashed name at the dist root. Panel assets keep
        // hashed names since sidepanel.html references are rewritten anyway.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
