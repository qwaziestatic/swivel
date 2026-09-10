import { defineConfig } from "vite";

/**
 * Content-script build passes.
 *
 * Chrome injects content scripts as CLASSIC scripts: no ES modules, no
 * chunk imports. Each entry must therefore be one self-contained IIFE —
 * and Rollup refuses multi-entry IIFE output (it would need shared
 * chunks). So: ONE build pass per content script, selected via --mode:
 *
 *   vite build --config vite.content.config.ts --mode index    → content.js
 *   vite build --config vite.content.config.ts --mode gmail    → gmail.js
 *   vite build --config vite.content.config.ts --mode generic  → generic.js
 *
 * Shared code (messages.ts, waitForElement, cleanText) is compiled into
 * EVERY bundle that imports it. That duplication is correct and expected
 * for content scripts — they share nothing at runtime; don't fight it.
 *
 * generic.js is deliberately NOT in manifest content_scripts: the hub
 * injects it on demand via chrome.scripting.executeScript({ files }),
 * which only requires the file to exist in the package.
 */
const ENTRIES: Record<string, { input: string; output: string }> = {
  target: { input: "src/content/target.ts", output: "target.js" },
  gmail: { input: "src/content/gmail.ts", output: "gmail.js" },
  generic: { input: "src/content/generic.ts", output: "generic.js" },
};

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode];
  if (!entry) {
    throw new Error(
      `Unknown content entry "${mode}" — use --mode ${Object.keys(ENTRIES).join("|")}`
    );
  }
  return {
    build: {
      outDir: "dist",
      // dist/ is cleaned once by `npm run clean`; every pass after that
      // must be additive or passes would delete each other's output.
      emptyOutDir: false,
      rollupOptions: {
        input: entry.input,
        output: {
          format: "iife" as const,
          entryFileNames: entry.output,
          inlineDynamicImports: true,
        },
      },
    },
  };
});
