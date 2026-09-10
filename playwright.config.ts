import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Swivel's MV3 e2e suite.
 *
 * The extension is loaded via a per-test persistent-context fixture (see
 * tests/e2e/fixtures.ts) — NOT here — because extensions require
 * launchPersistentContext with --load-extension, which the default
 * `browser`/`context` fixtures can't express. Tests drive the panel through
 * the actually-loaded extension (chrome-extension://<id>/…), resolving the
 * id from the live service worker.
 *
 * The fixture server (npm run fixture, port 4599) is started automatically.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one persistent Chromium at a time keeps extension state sane
  reporter: [["list"]],
  webServer: {
    command: "npm run fixture",
    url: "http://localhost:4599",
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
