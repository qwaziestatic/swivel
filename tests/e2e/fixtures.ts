/*
 * tests/e2e/fixtures.ts — the load-the-real-extension harness.
 *
 * This is the load-bearing part of Phase 6: e2e tests must exercise the
 * ACTUALLY-LOADED extension, not a fixture page opened directly. So we:
 *   1. launchPersistentContext with --load-extension pointing at the
 *      DEV-ONLY dist-test/ build (never the shippable dist/).
 *   2. Resolve the extension id from the LIVE service worker's URL — proof
 *      the worker booted — and hand tests a chrome-extension://<id>/ origin.
 *   3. Expose the worker so tests can seed chrome.storage via the extension
 *      context where they need preset state.
 *
 * MV3 note: extensions load in Chromium's NEW headless mode. We pass
 * --headless=new explicitly and set headless:false so Playwright doesn't add
 * the old --headless flag (which cannot load extensions). Override with
 * SWIVEL_HEADED=1 to watch a run.
 *
 * Browser: MUST be Playwright's Chromium (Chrome for Testing), NOT stable
 * Chrome/Edge. Recent stable Chrome DISABLED the --load-extension flag for
 * security, so `channel: "chrome"` silently loads NO extension. Chrome for
 * Testing still honors it — hence the default channel "chromium" and the
 * `npx playwright install chromium` requirement. Override with
 * SWIVEL_CHANNEL only if you have a channel that permits --load-extension.
 */

import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-test");
const HEADED = process.env.SWIVEL_HEADED === "1";
const CHANNEL = process.env.SWIVEL_CHANNEL ?? "chromium";

export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const args = [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ];
    if (!HEADED) args.push("--headless=new");

    const context = await chromium.launchPersistentContext("", {
      channel: CHANNEL, // installed browser (default "chrome") — no download
      headless: false, // real headless is requested via --headless=new above
      args,
    });
    await use(context);
    await context.close();
  },

  worker: async ({ context }, use) => {
    // The MV3 service worker registers on load; wait for it if it hasn't
    // appeared yet. Its presence is our proof the extension actually booted.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw);
  },

  extensionId: async ({ worker }, use) => {
    // chrome-extension://<id>/background.js  → host is the id.
    const id = new URL(worker.url()).host;
    await use(id);
  },
});

export const expect = test.expect;

/** Panel URL for a resolved extension id. */
export function panelUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/sidepanel.html`;
}
