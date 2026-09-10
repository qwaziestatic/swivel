/*
 * tests/e2e/smoke.spec.ts — Phase 6 smoke suite.
 *
 * Proves two things end-to-end through the LOADED extension:
 *   1. The extension boots (service worker runs, id resolvable).
 *   2. A full extract round-trip: panel → hub → generic.js injected on the
 *      fixture page → hub → panel, with cleanText applied. This is the real
 *      message pipeline, not a fixture page poked directly.
 */

import { test, expect, panelUrl } from "./fixtures";

test("extension boots and resolves a valid id", async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/); // chrome extension ids are 32 a–p chars
});

test("the fixture form renders after its deliberate delay", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("http://localhost:4599/");
  // Not present immediately…
  expect(await page.locator('[data-testid="ticket-form"]').count()).toBe(0);
  // …but appears within the delay window.
  await expect(page.locator('[data-testid="ticket-form"]')).toBeVisible({ timeout: 3000 });
});

test("extract round-trip: panel → hub → injected content script → back", async ({
  context,
  extensionId,
}) => {
  // 1. Open the fixture and let its delayed form render.
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');

  // 2. Open the panel as a tab (the harness model for driving the UI).
  const panel = await context.newPage();
  await panel.goto(panelUrl(extensionId));
  await panel.waitForLoadState("domcontentloaded");

  // 3. Make the FIXTURE the active tab — the hub extracts from the active
  //    tab, and the dev manifest's localhost host permission lets it inject
  //    generic.js there without a user gesture. Then trigger extraction from
  //    the panel's extension context.
  await fixture.bringToFront();
  const result = await panel.evaluate(async () => {
    // Runs in the chrome-extension:// page context, so chrome.* is available.
    return (await chrome.runtime.sendMessage({ type: "EXTRACT_REQUEST" })) as {
      type: string;
      state: { status: string; extracted: { bodyText: string; subject: string | null } | null };
    };
  });

  // 4. Assert the pipeline produced cleaned source text from the fixture.
  expect(result.type).toBe("STATE_SNAPSHOT");
  expect(result.state.status).toBe("source_ready");
  expect(result.state.extracted?.bodyText).toContain("adversarial regression target");
  expect(result.state.extracted?.subject).toContain("Swivel Fixture");
});
