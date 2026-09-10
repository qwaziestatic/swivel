/**
 * src/content/target.ts — the injection executor (target.js).
 *
 * Manifest-registered for *.atlassian.net; injected on demand
 * (chrome.scripting) onto other recipe domains such as the local fixture.
 * Runs a recipe's steps sequentially against the target SPA, streaming
 * per-step progress to the hub, which relays it to the panel.
 *
 * LAWS this file enforces:
 *  - Every DOM read goes through waitForElement (SPA-defensive, Charter
 *    Law 4). Every DOM WRITE goes through inject.ts (native setters /
 *    execCommand / full pointer clicks, Charter Law 5).
 *  - ONE AbortController per run: the first failing step aborts it, which
 *    cancels every still-pending waitForElement so the run stops cleanly
 *    instead of racing on.
 *  - Idempotency (Charter: double-submit is the worst failure): a real run
 *    is keyed by runId (hash(payload)+recipeId, computed hub-side). The
 *    executor refuses a runId already in progress or completed — guarded by
 *    a page-scoped Set (atomic against a double-click on one page) AND a
 *    storage.session record (survives content-script re-injection).
 *  - Dry-run NEVER submits: the submit-marked step and everything after it
 *    are hard-skipped; earlier steps are looked up and highlighted, not
 *    acted on.
 */

import {
  isSwivelMessage,
  type RunRecipeMessage,
  type RunOutcome,
  type SwivelMessage,
  type SwivelPayload,
} from "../shared/messages";
import type { AutomationStep, PayloadField } from "../shared/recipes";
import {
  TimeoutError,
  WaitAbortedError,
  waitForElement,
  waitForElementGone,
} from "./lib/waitForElement";
import { highlight, insertRichText, realisticClick, setNativeValue } from "./lib/inject";
import { isSendElement, looksLikeSendSelector } from "./lib/sendGuard";

declare global {
  interface Window {
    __swivelTargetLoaded?: boolean;
    /** Removes THIS context's message listener. Set by every injection so the
     *  next one can replace a listener that may be dead (see wiring below). */
    __swivelTargetCleanup?: () => void;
  }
}

/** Typed step failure with a machine code and an optional user-facing hint. */
class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "StepError";
  }
}

// --- Idempotency ------------------------------------------------------------
const seenRuns = new Set<string>();
const runKey = (runId: string) => `swivel:run:${runId}`;

async function storageHasRun(runId: string): Promise<boolean> {
  try {
    const s = await chrome.storage.session.get(runKey(runId));
    return s[runKey(runId)] !== undefined;
  } catch {
    // storage.session may be inaccessible if the worker hasn't raised the
    // access level yet; fall back to the page-scoped guard only.
    return false;
  }
}
async function storageMarkRun(runId: string, status: string): Promise<void> {
  try {
    await chrome.storage.session.set({ [runKey(runId)]: status });
  } catch {
    /* page-scoped Set still guards this page */
  }
}

// --- Reporting --------------------------------------------------------------
function report(message: SwivelMessage): void {
  // Fire-and-forget to the hub; it relays to the panel. A rejection just
  // means the worker is momentarily down — the run continues regardless.
  void chrome.runtime.sendMessage(message).catch(() => {});
}

function payloadValue(payload: SwivelPayload, field: PayloadField): string {
  const v = payload[field];
  return v == null ? "" : String(v);
}

function selectorOf(step: AutomationStep): string {
  if ("selector" in step) return step.selector;
  if ("triggerSelector" in step) return step.triggerSelector;
  return "(n/a)";
}

/** Map any thrown error into a typed {code, detail, hint} for reporting. */
function classify(err: unknown): { code: string; detail: string; hint?: string } {
  if (err instanceof TimeoutError) {
    return {
      code: "SELECTOR_NOT_FOUND",
      detail: err.message,
      hint: "selector not found — recipe may be stale",
    };
  }
  if (err instanceof WaitAbortedError) {
    return { code: "ABORTED", detail: "run aborted before this step completed" };
  }
  if (err instanceof StepError) {
    return { code: err.code, detail: err.message, hint: err.hint };
  }
  return { code: "STEP_FAILED", detail: err instanceof Error ? err.message : String(err) };
}

/**
 * THE SEND-DENIAL LAW, enforced (Charter). No step — from any recipe,
 * shipped or user-edited — may activate a Send control. Checked against both
 * the selector string and (when resolved) the live element. Throws
 * SEND_DENIED, which aborts the run. Drafting is automated; sending is human.
 */
function assertNoSend(step: AutomationStep, el?: Element): void {
  const selectors: string[] = [];
  if ("selector" in step) selectors.push(step.selector);
  if ("triggerSelector" in step) selectors.push(step.triggerSelector);
  for (const s of selectors) {
    if (looksLikeSendSelector(s)) {
      throw new StepError(
        "SEND_DENIED",
        `refusing a step that targets a Send control ("${s}")`,
        "sending is a human action, permanently"
      );
    }
  }
  if (el && isSendElement(el)) {
    throw new StepError(
      "SEND_DENIED",
      "refusing to activate a Send control",
      "sending is a human action, permanently"
    );
  }
}

// --- Step execution ---------------------------------------------------------
async function executeStep(
  step: AutomationStep,
  payload: SwivelPayload,
  dryRun: boolean,
  signal: AbortSignal,
  runResult: Record<string, string>
): Promise<void> {
  const timeoutMs = step.timeoutMs ?? 10_000;
  assertNoSend(step); // selector-level check before we even resolve anything

  switch (step.type) {
    case "waitFor":
      await waitForElement(step.selector, { timeoutMs, signal });
      return;

    case "waitForGone":
      await waitForElementGone(step.selector, { timeoutMs, signal });
      return;

    case "click": {
      const el = await waitForElement(step.selector, { timeoutMs, signal });
      assertNoSend(step, el); // element-level check — catches Send-by-class
      if (dryRun) return void highlight(el);
      realisticClick(el);
      return;
    }

    case "fill": {
      const el = await waitForElement<HTMLInputElement | HTMLTextAreaElement>(step.selector, {
        timeoutMs,
        signal,
      });
      if (dryRun) return void highlight(el);
      setNativeValue(el, payloadValue(payload, step.payloadField));
      return;
    }

    case "fillRichText": {
      const el = await waitForElement<HTMLElement>(step.selector, { timeoutMs, signal });
      if (dryRun) return void highlight(el);
      insertRichText(el, payloadValue(payload, step.payloadField));
      return;
    }

    case "selectOption": {
      const trigger = await waitForElement<HTMLElement>(step.triggerSelector, { timeoutMs, signal });
      assertNoSend(step, trigger);
      if (dryRun) return void highlight(trigger);
      // Open the listbox with a real pointer sequence, pick by trimmed text.
      realisticClick(trigger);
      const listbox = await waitForElement('[role="listbox"]', { timeoutMs, signal });
      const wanted = (step.optionText ?? payloadValue(payload, step.payloadField!)).trim();
      const option = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (o) => o.textContent?.trim() === wanted
      );
      if (!option) {
        throw new StepError(
          "OPTION_NOT_FOUND",
          `option "${wanted}" not present in the listbox`,
          "the option text may not match the payload value"
        );
      }
      realisticClick(option);
      await waitForElementGone('[role="listbox"]', { timeoutMs, signal });
      return;
    }

    case "readBack": {
      const el = await waitForElement(step.selector, { timeoutMs, signal });
      const value = step.attribute
        ? (el.getAttribute(step.attribute) ?? "")
        : (el.textContent?.trim() ?? "");
      runResult[step.saveAs] = value;
      return;
    }
  }
}

// The run currently executing on THIS page, so an external ABORT_RUN (sent
// by the hub when the target SPA navigates mid-run) can cancel it. There is
// no module-scope assumption about the current DOM — the run reads the live
// document through waitForElement on every step.
let activeRun: { runId: string; controller: AbortController } | null = null;

// --- Run driver -------------------------------------------------------------
async function runRecipe(msg: RunRecipeMessage): Promise<void> {
  const { runId, steps, payload, dryRun } = msg;

  // Idempotency guard for REAL runs only — a dry run submits nothing, so a
  // dry-run then a real run (same runId) must be allowed.
  if (!dryRun) {
    if (seenRuns.has(runId)) return reportDuplicate(runId);
    seenRuns.add(runId); // atomic: blocks a concurrent double-click on this page
    if (await storageHasRun(runId)) return reportDuplicate(runId);
    await storageMarkRun(runId, "in-progress");
  }

  const controller = new AbortController();
  activeRun = { runId, controller };
  const runResult: Record<string, string> = {};
  let reachedSubmit = false;

  // Facts about what this run ACTUALLY did (Gate 6). The executor is the only
  // component that knows; everything the UI later says about the run must be
  // derived from these, never from "the run ended".
  const outcome: RunOutcome = {
    dryRun,
    submitted: false,
    stepsExecuted: 0,
    stepsSkipped: 0,
    highlighted: 0,
  };

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;

      // Dry-run stops at the submit boundary: skip the submit and everything
      // after it (post-submit waits/readbacks can't succeed without a submit).
      if (dryRun && (reachedSubmit || (step.type === "click" && step.submits))) {
        reachedSubmit = true;
        outcome.stepsSkipped += 1;
        report({ type: "AUTOMATION_STEP_UPDATE", runId, stepIndex: i, status: "skipped", detail: `not submitted (dry run): ${step.description}` });
        continue;
      }

      report({ type: "AUTOMATION_STEP_UPDATE", runId, stepIndex: i, status: "pending", detail: step.description });
      try {
        await executeStep(step, payload, dryRun, controller.signal, runResult);
        outcome.stepsExecuted += 1;
        if (dryRun) outcome.highlighted += 1;
        // The ONLY place `submitted` can become true: a step that commits data
        // actually ran to completion. Unreachable in a dry run, which skips
        // every `submits` step above before executeStep is called.
        if (step.type === "click" && step.submits) outcome.submitted = true;
        report({ type: "AUTOMATION_STEP_UPDATE", runId, stepIndex: i, status: "ok", detail: step.description });
      } catch (err) {
        const { code, detail, hint } = classify(err);

        // OPTIONAL STEPS (Gate 5): a step marked optional may be absent from
        // this variant of the target UI, or may be a post-submit read-back
        // whose failure must not retract a create that already happened.
        //
        // SCOPE IS DELIBERATELY NARROW — only "the element isn't there".
        // SEND_DENIED must ALWAYS abort (the Send-denial law is absolute and
        // no recipe flag may weaken it), and ABORTED / NAVIGATION_INTERRUPTED
        // mean the run is already over. Note we do NOT abort the controller
        // here: the remaining steps still need their waits alive.
        const isMissingElement = code === "SELECTOR_NOT_FOUND" || code === "OPTION_NOT_FOUND";
        if (step.optional && isMissingElement) {
          outcome.stepsSkipped += 1;
          console.warn(`[swivel:target] optional step ${i + 1} skipped: ${detail}`);
          report({
            type: "AUTOMATION_STEP_UPDATE",
            runId,
            stepIndex: i,
            status: "skipped",
            detail: `skipped (optional, not present): ${step.description}`,
          });
          continue;
        }

        controller.abort(); // cancel every still-pending wait in this run
        report({ type: "AUTOMATION_STEP_UPDATE", runId, stepIndex: i, status: "failed", detail });
        report({
          type: "AUTOMATION_ERROR",
          runId,
          errorCode: code,
          detail: `Step ${i + 1} (${step.description}) [${selectorOf(step)}]: ${detail}${hint ? ` — ${hint}` : ""}`,
        });
        if (!dryRun) await storageMarkRun(runId, "failed");
        return;
      }
    }

    if (!dryRun) await storageMarkRun(runId, "done");
    console.log(
      `[swivel:target] run ${runId} finished — dryRun=${outcome.dryRun} ` +
        `submitted=${outcome.submitted} executed=${outcome.stepsExecuted} skipped=${outcome.stepsSkipped}`
    );
    report({ type: "AUTOMATION_DONE", runId, readBack: runResult, outcome });
  } finally {
    if (activeRun?.runId === runId) activeRun = null;
  }
}

function reportDuplicate(runId: string): void {
  report({
    type: "AUTOMATION_ERROR",
    runId,
    errorCode: "RUN_DUPLICATE",
    detail: "This exact payload was already submitted to this target — refusing to run again.",
  });
}

// --- Message wiring ---------------------------------------------------------
//
// RE-REGISTER, DON'T SKIP (Gate 7, defect A-a). This used to be
// `if (!window.__swivelTargetLoaded) { …addListener… }`, which had a silent
// failure mode: the flag lives on the ISOLATED WORLD's window, which outlives
// an individual content-script context. If the previous listener is dead —
// the extension was reloaded, so its context is invalidated — the flag is
// still true, so a fresh injection registered NOTHING. The tab then looks
// injected, accepts the injection without error, and answers no messages.
// "Works once, then silence."
//
// The fix is a cleanup hook instead of a boolean: every injection removes the
// previous listener (dead or alive) and installs its own. That is idempotent
// — exactly one live listener per tab, so no double-execution of a recipe —
// while never leaving a tab with zero.
if (window.__swivelTargetCleanup) {
  try {
    window.__swivelTargetCleanup();
  } catch {
    // Previous context already invalidated — nothing to remove.
  }
}

{
  window.__swivelTargetLoaded = true;

  const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: SwivelMessage) => void
    ): boolean | undefined => {
      if (!isSwivelMessage(message)) return undefined;

      if (message.type === "PING") {
        sendResponse({ type: "PONG", hops: [...message.hops, `target(${location.hostname})`] });
        return undefined;
      }

      if (message.type === "RUN_RECIPE") {
        // Run asynchronously; progress streams via separate messages, so we
        // don't hold the response channel open.
        void runRecipe(message);
        return undefined;
      }

      if (message.type === "TEST_SELECTORS") {
        // Recipe-staleness check (Phase 10): resolve each selector, act on
        // NOTHING. A short timeout keeps it snappy; a miss just means the
        // selector no longer resolves on this page.
        (async () => {
          const results = await Promise.all(
            message.selectors.map(async (selector) => {
              try {
                await waitForElement(selector, { timeoutMs: 1500 });
                return { selector, resolved: true };
              } catch {
                return { selector, resolved: false };
              }
            })
          );
          sendResponse({ type: "TEST_SELECTORS_RESULT", results });
        })();
        return true;
      }

      if (message.type === "ABORT_RUN") {
        // The hub detected the target navigated mid-run. Cancel the active
        // run's pending waits; the executor's loop reports the abort, which
        // the hub drops (terminal-first-wins) in favor of its own reason.
        if (activeRun && activeRun.runId === message.runId) {
          activeRun.controller.abort();
        }
        return undefined;
      }

      return undefined;
  };

  chrome.runtime.onMessage.addListener(listener);
  window.__swivelTargetCleanup = () => chrome.runtime.onMessage.removeListener(listener);

  console.log("[swivel:target] executor listener registered on", location.hostname);
}
