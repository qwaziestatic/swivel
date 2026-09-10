/*
 * tests/e2e/injection.spec.ts — Phase 7 regression suite.
 *
 * Drives the REAL injection engine (target.js) against the adversarial
 * fixture through the loaded extension. The fixture reverts naive .value
 * writes and ignores bare clicks, so these tests only pass if inject.ts
 * uses the native setter + full pointer sequence.
 *
 * Preset state is seeded via the service-worker context (chrome.storage);
 * run events are collected over a real Port from the panel page, exactly
 * like the panel does.
 */

import { test, expect, panelUrl } from "./fixtures";

const STATE_KEY = "swivel:workflowState"; // must match src/background/index.ts

const PAYLOAD = {
  ticket_title: "Login 500 on submit",
  customer_id: "ACME-9",
  priority: "high",
  summary: "Users hit a 500 when submitting the login form.",
  action_items: ["Repro on staging"],
  source_url: "http://localhost:4599/",
};

const READY_STATE = {
  status: "ready",
  extracted: { sourceUrl: "http://localhost:4599/", subject: "x", sender: null, bodyText: "x" },
  payload: PAYLOAD,
  sourceTabId: null,
  targetTabId: null,
  runId: null,
  lastError: null,
};

/** Seed the hub's workflow state from the worker context. */
async function seedReady(worker: import("@playwright/test").Worker) {
  await worker.evaluate(
    async ({ key, state }) => {
      await chrome.storage.session.set({ [key]: state });
    },
    { key: STATE_KEY, state: READY_STATE }
  );
}

/** Open the panel and start collecting Port messages into window.__ev. */
async function openPanelWithCollector(context: import("@playwright/test").BrowserContext, extensionId: string) {
  const panel = await context.newPage();
  await panel.goto(panelUrl(extensionId));
  await panel.waitForLoadState("domcontentloaded");
  await panel.evaluate(() => {
    (window as unknown as { __ev: unknown[] }).__ev = [];
    const port = chrome.runtime.connect({ name: "swivel-panel" });
    port.onMessage.addListener((m) => (window as unknown as { __ev: unknown[] }).__ev.push(m));
  });
  return panel;
}

type Ev = {
  type: string;
  errorCode?: string;
  readBack?: Record<string, string>;
  outcome?: { dryRun: boolean; submitted: boolean; highlighted: number };
  stepIndex?: number;
  status?: string;
  detail?: string;
};
async function events(panel: import("@playwright/test").Page): Promise<Ev[]> {
  return panel.evaluate(() => (window as unknown as { __ev: Ev[] }).__ev);
}
async function waitForEvent(panel: import("@playwright/test").Page, type: string) {
  await expect
    .poll(async () => (await events(panel)).some((e) => e.type === type), { timeout: 15_000 })
    .toBe(true);
}

test("full recipe run fills via native setters, works the combobox, submits, reads back", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');

  const panel = await openPanelWithCollector(context, extensionId);
  await seedReady(worker);

  await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "AUTOMATE_TO_TARGET",
      recipeId: "fixture-create-ticket",
      dryRun: false,
    })
  );

  // The fixture's success screen is built from its controlled-input MODEL,
  // not from el.value — so these assertions PROVE the native-setter path was
  // used. A naive .value write would have been reverted and these would be
  // empty.
  await fixture.waitForSelector('[data-testid="success-screen"]', { timeout: 15_000 });
  await expect(fixture.locator('[data-testid="submitted-title"]')).toHaveText(PAYLOAD.ticket_title);
  await expect(fixture.locator('[data-testid="submitted-customer"]')).toHaveText("ACME-9");
  await expect(fixture.locator('[data-testid="submitted-priority"]')).toHaveText("high"); // combobox worked
  await expect(fixture.locator('[data-testid="submitted-description"]')).toHaveText(PAYLOAD.summary);
  await expect(fixture.locator('[data-testid="ticket-id"]')).toContainText("FIX-");

  // The run reported DONE with the read-back ticket id AND url.
  await waitForEvent(panel, "AUTOMATION_DONE");
  const done = (await events(panel)).find((e) => e.type === "AUTOMATION_DONE")!;
  expect(done.readBack?.issueKey).toMatch(/^FIX-\d+$/);
  expect(done.readBack?.issueUrl).toContain("/browse/FIX-");
});

test("the executor refuses a step that targets a Send control (Send-denial law)", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');
  const panel = await openPanelWithCollector(context, extensionId);

  // A hostile recipe targets the decoy Send by testid — the selector string
  // gives nothing away, so ONLY the element-level guard can catch it.
  await worker.evaluate(
    async (key) => {
      const [tab] = await chrome.tabs.query({ url: "http://localhost:4599/*" });
      await chrome.storage.session.set({
        [key]: { status: "executing", extracted: null, payload: null, sourceTabId: null, targetTabId: tab.id, runId: "hostile:1", runSteps: [], lastError: null },
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["target.js"] });
      await chrome.tabs.sendMessage(tab.id!, {
        type: "RUN_RECIPE",
        runId: "hostile:1",
        dryRun: false,
        payload: { ticket_title: "T", customer_id: null, priority: "low", summary: "S", action_items: [], source_url: "" },
        steps: [{ type: "click", selector: '[data-testid="decoy-send"]', description: "click send" }],
      });
    },
    "swivel:workflowState"
  );

  await waitForEvent(panel, "AUTOMATION_ERROR");
  const err = (await events(panel)).find((e) => e.type === "AUTOMATION_ERROR")!;
  expect(err.errorCode).toBe("SEND_DENIED");
});

test("dry-run highlights but changes nothing and never submits", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');

  const panel = await openPanelWithCollector(context, extensionId);
  await seedReady(worker);

  await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "AUTOMATE_TO_TARGET",
      recipeId: "fixture-create-ticket",
      dryRun: true,
    })
  );

  await waitForEvent(panel, "AUTOMATION_DONE");

  // Nothing was filled, selected, or submitted.
  await expect(fixture.locator('[data-testid="title-input"]')).toHaveValue("");
  await expect(fixture.locator('[data-testid="customer-input"]')).toHaveValue("");
  await expect(fixture.locator('[data-testid="priority-combobox"]')).toHaveText("Select priority…");
  expect(await fixture.locator('[data-testid="success-screen"]').count()).toBe(0);

  // Dry-run skipped the readBack (it's post-submit), so nothing was read back.
  const done = (await events(panel)).find((e) => e.type === "AUTOMATION_DONE")!;
  expect(done.readBack).toEqual({});

  // THE GATE-6 ASSERTION, at the source. The panel told a user "Ticket
  // created" for a dry run because the executor's DONE said nothing about
  // what the run did. It must now report, in the wire message itself, that
  // this was a dry run and that nothing was submitted.
  expect(done.outcome, "AUTOMATION_DONE must carry an outcome").toBeTruthy();
  expect(done.outcome!.dryRun).toBe(true);
  expect(done.outcome!.submitted).toBe(false);
  expect(done.outcome!.highlighted).toBeGreaterThan(0);
});

test("a broken selector fails the step with a typed error and submits nothing", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');
  const panel = await openPanelWithCollector(context, extensionId);

  // Directly dispatch a recipe whose 2nd step targets a nonexistent element,
  // AFTER a real fill — proving the run aborts and never reaches submit. Seed
  // the hub into "executing" for this tab+runId so the relay forwards the run
  // events (production would do this via dispatchRun).
  await worker.evaluate(
    async (key) => {
      const [tab] = await chrome.tabs.query({ url: "http://localhost:4599/*" });
      await chrome.storage.session.set({
        [key]: { status: "executing", extracted: null, payload: null, sourceTabId: null, targetTabId: tab.id, runId: "broken:1", runSteps: [], lastError: null },
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["target.js"] });
      await chrome.tabs.sendMessage(tab.id!, {
        type: "RUN_RECIPE",
        runId: "broken:1",
        dryRun: false,
        payload: { ticket_title: "T", customer_id: null, priority: "low", summary: "S", action_items: [], source_url: "" },
        steps: [
          { type: "waitFor", selector: '[data-testid="ticket-form"]', description: "form" },
          { type: "fill", selector: "#nonexistent-field", payloadField: "ticket_title", description: "fill missing", timeoutMs: 800 },
          { type: "click", selector: '[data-testid="submit-button"]', description: "submit", submits: true },
        ],
      });
    },
    "swivel:workflowState"
  );

  await waitForEvent(panel, "AUTOMATION_ERROR");
  const err = (await events(panel)).find((e) => e.type === "AUTOMATION_ERROR")!;
  expect(err.errorCode).toBe("SELECTOR_NOT_FOUND");
  // The submit step (index 2) never ran — nothing was submitted.
  expect(await fixture.locator('[data-testid="success-screen"]').count()).toBe(0);
});

test("an OPTIONAL missing step is skipped and the run still completes", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');
  const panel = await openPanelWithCollector(context, extensionId);

  // Same shape as the broken-selector run above, but the missing step is
  // marked optional. This is the Jira case: a control that isn't present in
  // this variant of the UI must not abort a run that can still succeed.
  await worker.evaluate(
    async (key) => {
      const [tab] = await chrome.tabs.query({ url: "http://localhost:4599/*" });
      await chrome.storage.session.set({
        [key]: { status: "executing", extracted: null, payload: null, sourceTabId: null, targetTabId: tab.id, runId: "optional:1", runSteps: [], lastError: null, lastErrorDetail: null },
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["target.js"] });
      await chrome.tabs.sendMessage(tab.id!, {
        type: "RUN_RECIPE",
        runId: "optional:1",
        dryRun: false,
        payload: { ticket_title: "Optional test", customer_id: null, priority: "low", summary: "Body text", action_items: [], source_url: "" },
        steps: [
          { type: "waitFor", selector: '[data-testid="ticket-form"]', description: "form" },
          { type: "fill", selector: '[data-testid="title-input"]', payloadField: "ticket_title", description: "fill title" },
          // Absent from this page — optional, so the run must carry on.
          { type: "selectOption", triggerSelector: "#no-such-priority-control", payloadField: "priority", description: "priority (optional)", optional: true, timeoutMs: 800 },
          { type: "fillRichText", selector: '[data-testid="description-editor"]', payloadField: "summary", description: "fill description" },
          { type: "click", selector: '[data-testid="submit-button"]', description: "submit", submits: true },
          { type: "waitFor", selector: '[data-testid="success-screen"]', description: "success" },
        ],
      });
    },
    "swivel:workflowState"
  );

  // The run reaches DONE despite the missing optional control.
  await waitForEvent(panel, "AUTOMATION_DONE");

  // And it really submitted — with the rich text landing in the ProseMirror
  // model, not just the DOM projection.
  await expect(fixture.locator('[data-testid="success-screen"]')).toBeVisible();
  await expect(fixture.locator('[data-testid="submitted-description"]')).toHaveText("Body text");

  // The skipped step reported ok-with-a-skip, not failed.
  const steps = (await events(panel)).filter((e) => e.type === "AUTOMATION_STEP_UPDATE");
  // "skipped", NOT "ok" — a green tick for work that never happened is the
  // same false-success defect as the done view's old "Ticket created".
  const skipped = steps.find((s) => s.stepIndex === 2 && s.status === "skipped");
  expect(skipped, "optional step should report skipped").toBeTruthy();
  expect(String(skipped.detail)).toContain("skipped (optional");
  expect(steps.some((s) => s.status === "failed")).toBe(false);

  // And the run's OUTCOME says a real submit happened.
  const done = (await events(panel)).find((e) => e.type === "AUTOMATION_DONE");
  expect(done.outcome.dryRun).toBe(false);
  expect(done.outcome.submitted).toBe(true);
});

test("idempotency guard refuses a repeated runId (double-submit protection)", async ({
  context,
  worker,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto("http://localhost:4599/");
  await fixture.waitForSelector('[data-testid="ticket-form"]');
  const panel = await openPanelWithCollector(context, extensionId);

  // Same runId twice; a trivial (non-submitting) step so the first completes.
  // Seed the hub into "executing" for this tab+runId so the relay forwards
  // the RUN_DUPLICATE the executor emits for the second dispatch.
  await worker.evaluate(
    async (key) => {
      const [tab] = await chrome.tabs.query({ url: "http://localhost:4599/*" });
      await chrome.storage.session.set({
        [key]: { status: "executing", extracted: null, payload: null, sourceTabId: null, targetTabId: tab.id, runId: "dup:1", runSteps: [], lastError: null },
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["target.js"] });
      const msg = {
        type: "RUN_RECIPE",
        runId: "dup:1",
        dryRun: false,
        payload: { ticket_title: "T", customer_id: null, priority: "low", summary: "S", action_items: [], source_url: "" },
        steps: [{ type: "waitFor", selector: '[data-testid="ticket-form"]', description: "form" }],
      };
      await chrome.tabs.sendMessage(tab.id!, msg);
      // Small gap so the first run records itself before the second arrives.
      await new Promise((r) => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tab.id!, msg);
    },
    "swivel:workflowState"
  );

  await waitForEvent(panel, "AUTOMATION_ERROR");
  const err = (await events(panel)).find((e) => e.type === "AUTOMATION_ERROR")!;
  expect(err.errorCode).toBe("RUN_DUPLICATE");
});
