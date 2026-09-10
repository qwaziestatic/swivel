/*
 * tests/e2e/resilience.spec.ts — Phase 8 lifecycle resilience.
 *
 * Verifies, through the loaded extension:
 *   - client-side (pushState) navigation of the target mid-run aborts the
 *     run cleanly with NAVIGATION_INTERRUPTED and submits nothing;
 *   - a panel reload mid-run (stand-in for worker death / port disconnect —
 *     sanctioned by the phase brief) restores the persisted step log and the
 *     run still completes exactly once;
 *   - a second automate while a run is live is rejected with RUN_IN_PROGRESS
 *     before any content-script involvement, so a double-click = one run.
 */

import { test, expect, panelUrl } from "./fixtures";

const STATE_KEY = "swivel:workflowState";
const PAYLOAD = {
  ticket_title: "Login 500 on submit",
  customer_id: "ACME-9",
  priority: "high",
  summary: "Users hit a 500 when submitting the login form.",
  action_items: [] as string[],
  source_url: "http://localhost:4599/",
};
const READY_STATE = {
  status: "ready",
  extracted: { sourceUrl: "http://localhost:4599/", subject: "x", sender: null, bodyText: "x" },
  payload: PAYLOAD,
  sourceTabId: null,
  targetTabId: null,
  runId: null,
  runSteps: [] as unknown[],
  lastError: null,
};

async function seedReady(worker: import("@playwright/test").Worker) {
  await worker.evaluate(
    async ({ key, state }) => {
      await chrome.storage.session.set({ [key]: state });
    },
    { key: STATE_KEY, state: READY_STATE }
  );
}

async function attachCollector(panel: import("@playwright/test").Page) {
  await panel.evaluate(() => {
    (window as unknown as { __ev: unknown[] }).__ev = [];
    const port = chrome.runtime.connect({ name: "swivel-panel" });
    port.onMessage.addListener((m) => (window as unknown as { __ev: unknown[] }).__ev.push(m));
  });
}
type Ev = { type: string; errorCode?: string };
async function events(panel: import("@playwright/test").Page): Promise<Ev[]> {
  return panel.evaluate(() => (window as unknown as { __ev: Ev[] }).__ev);
}
async function automate(panel: import("@playwright/test").Page, dryRun = false) {
  return panel.evaluate(
    (dry) =>
      chrome.runtime.sendMessage({
        type: "AUTOMATE_TO_TARGET",
        recipeId: "fixture-create-ticket",
        dryRun: dry,
      }),
    dryRun
  );
}

test("pushState navigation of the target mid-run aborts cleanly, submits nothing", async ({
  context,
  worker,
  extensionId,
}) => {
  // Long render delay so the run is parked on `waitFor(form)` when we navigate.
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/?delay=4000");

  const panel = await context.newPage();
  await panel.goto(panelUrl(extensionId));
  await panel.waitForLoadState("domcontentloaded");
  await attachCollector(panel);
  await seedReady(worker);

  await automate(panel); // run starts, parks on waitFor(ticket-form)
  await fixture.evaluate(() => history.pushState({}, "", "/other")); // client-side nav

  await expect
    .poll(async () => (await events(panel)).find((e) => e.type === "AUTOMATION_ERROR")?.errorCode, {
      timeout: 10_000,
    })
    .toBe("NAVIGATION_INTERRUPTED");

  // Nothing was submitted (no half-filled ghost state).
  expect(await fixture.locator('[data-testid="success-screen"]').count()).toBe(0);
});

test("panel reload mid-run restores the step log and the run still completes once", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/?delay=2500"); // form appears at 2.5s

  const panel = await context.newPage();
  await panel.goto(panelUrl(extensionId));
  await panel.waitForLoadState("domcontentloaded");
  await seedReady(worker);

  await automate(panel); // run starts; step 0 (waitFor form) is pending & persisted
  await panel.waitForTimeout(800);

  // Reload the panel — disconnects its Port and drops all in-memory state.
  await panel.reload();
  await panel.waitForLoadState("domcontentloaded");

  // The rehydrated panel shows the persisted step log (proves it survived).
  await expect(panel.getByText(/Step 1/)).toBeVisible({ timeout: 10_000 });

  // The run — which lives in the content script — completes exactly once.
  await fixture.waitForSelector('[data-testid="success-screen"]', { timeout: 15_000 });
  await expect(fixture.locator('[data-testid="submitted-title"]')).toHaveText(PAYLOAD.ticket_title);
  expect(await fixture.locator('[data-testid="success-screen"]').count()).toBe(1);
});

test("a second automate while a run is live is rejected (double-click = one run)", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/?delay=1500");

  const panel = await context.newPage();
  await panel.goto(panelUrl(extensionId));
  await panel.waitForLoadState("domcontentloaded");
  await seedReady(worker);

  const first = (await automate(panel)) as { type: string };
  const second = (await automate(panel)) as { type: string; errorCode?: string };

  expect(first.type).toBe("STATE_SNAPSHOT"); // run started
  expect(second.type).toBe("AUTOMATION_ERROR");
  expect(second.errorCode).toBe("RUN_IN_PROGRESS"); // rejected before any injection

  // The single run completes and there is exactly one success screen.
  await fixture.waitForSelector('[data-testid="success-screen"]', { timeout: 15_000 });
  await expect(fixture.locator('[data-testid="submitted-title"]')).toHaveText(PAYLOAD.ticket_title);
  expect(await fixture.locator('[data-testid="success-screen"]').count()).toBe(1);
});
