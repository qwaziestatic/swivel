/**
 * tests/panelSync.test.ts — the regression gate run #2 exposed.
 *
 * A successful extraction reached the hub, was logged, and was persisted —
 * and the panel rendered nothing, because the reducer silently DROPPED the
 * snapshot (idle → sourceReady was missing from the transition table) and the
 * success message was computed from a different source of truth, so the UI
 * showed "Source captured ✓" over an empty panel.
 *
 * Both halves were unit-testable the whole time. These lock them:
 *   1. the happy path from a FRESH panel actually applies,
 *   2. the applied state carries the data the render branches gate on,
 *   3. success indication and phase can never disagree (willAcceptSync),
 *   4. a snapshot from an older build (missing newer fields) still renders.
 */

import { describe, it, expect } from "vitest";
import {
  initialPanelState,
  isLegalTransition,
  panelReducer,
  willAcceptSync,
  type PanelState,
} from "../src/sidepanel/panelMachine";
import {
  INITIAL_WORKFLOW_STATE,
  type ExtractedContext,
  type WorkflowState,
} from "../src/shared/messages";

const EXTRACTED: ExtractedContext = {
  sourceUrl: "https://mail.google.com/mail/u/0/#inbox/abc123",
  subject: "Make advanced edits to your photos",
  sender: "Google Photos <noreply@google.com>",
  bodyText: "x".repeat(393),
};

/** Exactly what the hub persists + broadcasts after a good extraction. */
const SOURCE_READY: WorkflowState = {
  ...INITIAL_WORKFLOW_STATE,
  status: "source_ready",
  extracted: EXTRACTED,
  sourceTabId: 1415400738,
};

describe("successful extraction reaches the panel", () => {
  it("applies SYNC(source_ready) from a FRESH idle panel", () => {
    // THE REGRESSION. Before the fix this returned `initialPanelState`
    // unchanged — same object, phase still "idle".
    const next = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });

    expect(next.phase).toBe("sourceReady");
    expect(next).not.toBe(initialPanelState);
  });

  it("carries the extracted context the render branches gate on", () => {
    // `{state.extracted && …}` is what mounts the captured-source view, and
    // phase "sourceReady" is what mounts the Synthesize button. A transition
    // that advances the phase but drops the data would still render nothing.
    const next = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });

    expect(next.extracted).not.toBeNull();
    expect(next.extracted?.subject).toBe("Make advanced edits to your photos");
    expect(next.extracted?.bodyText).toHaveLength(393);
    expect(next.error).toBeNull();
  });

  it("declares idle → sourceReady legal", () => {
    expect(isLegalTransition("idle", "sourceReady")).toBe(true);
  });

  it("still applies when the panel DID observe the extracting phase", () => {
    const extracting = panelReducer(initialPanelState, {
      type: "SYNC",
      state: { ...INITIAL_WORKFLOW_STATE, status: "extracting" },
    });
    expect(extracting.phase).toBe("extracting");

    const next = panelReducer(extracting, { type: "SYNC", state: SOURCE_READY });
    expect(next.phase).toBe("sourceReady");
    expect(next.extracted?.subject).toBe(EXTRACTED.subject);
  });

  it("re-extracting from sourceReady applies the NEW thread (repeat safety)", () => {
    const first = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });
    const second: WorkflowState = {
      ...SOURCE_READY,
      extracted: { ...EXTRACTED, subject: "A different thread", bodyText: "yy" },
    };
    const next = panelReducer(first, { type: "SYNC", state: second });

    expect(next.phase).toBe("sourceReady");
    expect(next.extracted?.subject).toBe("A different thread");
  });
});

describe("the COMPLETE happy path, as the hub actually broadcasts it", () => {
  /**
   * The governing fact these tests encode: the hub broadcasts only SETTLED
   * statuses. It writes "extracting"/"synthesizing" without broadcasting, and
   * never writes "routing" at all. So the panel's real observed sequence
   * skips every transient — and each missing "skip" edge was a separate
   * instance of the same silent-drop bug, found one gate run at a time.
   *
   * Driving the reducer through the WHOLE flow in one test is what catches
   * the next one before a human does.
   */
  const PAYLOAD = {
    ticket_title: "Photo editing issue",
    customer_id: null,
    priority: "medium",
    summary: "User reports advanced edits failing.",
    action_items: ["Reproduce", "File bug"],
    source_url: EXTRACTED.sourceUrl,
  } as unknown as WorkflowState["payload"];

  it("walks idle → sourceReady → review → executing → done without a single drop", () => {
    let s: PanelState = initialPanelState;
    expect(s.phase).toBe("idle");

    // 1. Extraction lands (transient "extracting" never broadcast).
    s = panelReducer(s, { type: "SYNC", state: SOURCE_READY });
    expect(s.phase, "idle → sourceReady").toBe("sourceReady");
    expect(s.extracted).not.toBeNull();

    // 2. Synthesis lands (transient "synthesizing" never broadcast).
    const ready: WorkflowState = { ...SOURCE_READY, status: "ready", payload: PAYLOAD };
    s = panelReducer(s, { type: "SYNC", state: ready });
    expect(s.phase, "sourceReady → review").toBe("review");
    expect(s.payload, "the review form has nothing to render without this").not.toBeNull();

    // 3. Automate lands. dispatchRun persists "executing" directly — there is
    //    no "routing" broadcast to step through.
    const executing: WorkflowState = {
      ...ready,
      status: "executing",
      runId: "jira:123",
      targetTabId: 99,
    };
    s = panelReducer(s, { type: "SYNC", state: executing });
    expect(s.phase, "review → executing").toBe("executing");

    // 4. The run completes over the Port, not as a SYNC.
    s = panelReducer(s, {
      type: "RUN_DONE",
      runId: "jira:123",
      readBack: { issueKey: "SWIV-1" },
      outcome: { dryRun: false, submitted: true, stepsExecuted: 4, stepsSkipped: 0, highlighted: 0 },
    });
    expect(s.phase, "executing → done").toBe("done");
    expect(s.readBack?.issueKey).toBe("SWIV-1");
  });

  it("accepts every forward edge of that path individually", () => {
    const edges: ReadonlyArray<[PanelState["phase"], PanelState["phase"]]> = [
      ["idle", "sourceReady"],
      ["sourceReady", "review"],
      ["review", "executing"],
      ["executing", "done"],
    ];
    for (const [from, to] of edges) {
      expect(isLegalTransition(from, to), `${from} → ${to} must be legal`).toBe(true);
    }
  });

  it("accepts the retry edges out of error — retries land on settled statuses", () => {
    // A retry passes through a transient the hub never broadcasts, so the
    // panel sees the settled result directly from "error".
    for (const to of ["sourceReady", "review", "executing"] as const) {
      expect(isLegalTransition("error", to), `error → ${to} must be legal`).toBe(true);
    }
  });

  it("accepts re-extracting from review and from done", () => {
    expect(isLegalTransition("review", "sourceReady")).toBe(true);
    expect(isLegalTransition("done", "sourceReady")).toBe(true);
  });

  it("PROTECTS a live run: executing rejects everything but done", () => {
    // The one row that must stay narrow. A stray snapshot mid-run would blank
    // the step log the user is watching.
    for (const to of ["sourceReady", "review", "routing", "extracting"] as const) {
      expect(isLegalTransition("executing", to), `executing → ${to} must be REJECTED`).toBe(
        false
      );
    }
    expect(isLegalTransition("executing", "done")).toBe(true);
    // idle/error remain valves even mid-run (reset and failure).
    expect(isLegalTransition("executing", "idle")).toBe(true);
    expect(isLegalTransition("executing", "error")).toBe(true);
  });
});

describe("willAcceptSync — success and phase cannot disagree", () => {
  it("reports true exactly when the reducer will apply the snapshot", () => {
    // The invariant the UI now relies on to decide between "show the source"
    // and "report that the panel dropped it".
    const cases: PanelState["phase"][] = [
      "idle",
      "extracting",
      "sourceReady",
      "synthesizing",
      "review",
      "routing",
      "executing",
      "done",
      "error",
    ];

    for (const phase of cases) {
      const from: PanelState = { ...initialPanelState, phase };
      const predicted = willAcceptSync(phase, SOURCE_READY);
      const actual =
        panelReducer(from, { type: "SYNC", state: SOURCE_READY }) !== from;
      expect(
        predicted,
        `willAcceptSync disagreed with the reducer for phase "${phase}"`
      ).toBe(actual);
    }
  });

  it("accepts source_ready from idle — the case that regressed", () => {
    expect(willAcceptSync("idle", SOURCE_READY)).toBe(true);
  });

  it("still rejects a genuinely illegal jump", () => {
    // The guard must keep doing its job: executing is not reachable from idle
    // via a live broadcast (a panel opening mid-run uses REHYDRATE instead).
    const executing: WorkflowState = { ...INITIAL_WORKFLOW_STATE, status: "executing" };
    expect(willAcceptSync("idle", executing)).toBe(false);
    const from: PanelState = { ...initialPanelState, phase: "idle" };
    expect(panelReducer(from, { type: "SYNC", state: executing })).toBe(from);
  });
});

describe("a SECOND run's steps are never rejected by the first run's id", () => {
  /**
   * Gate 7, defect A. `withHubFields` never copied runId, so the panel kept
   * the id it adopted from the first step it ever saw. runId is a hash of the
   * payload, so ANY edit between runs changes it — and then every step of the
   * next run hit `state.runId !== action.runId` and was dropped. Symptom:
   * phase "executing", no steps, no error, forever.
   */
  const executingRun = (runId: string): WorkflowState => ({
    ...INITIAL_WORKFLOW_STATE,
    status: "executing",
    extracted: EXTRACTED,
    runId,
    targetTabId: 7,
  });

  it("adopts the new runId when a fresh run starts", () => {
    // Via review — a run can only start from a reviewed payload, and the
    // table correctly rejects sourceReady -> executing.
    let s = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });
    s = panelReducer(s, { type: "SYNC", state: { ...SOURCE_READY, status: "ready" } });
    s = panelReducer(s, { type: "SYNC", state: executingRun("recipe:AAA") });
    expect(s.phase).toBe("executing");
    s = panelReducer(s, {
      type: "STEP",
      runId: "recipe:AAA",
      stepIndex: 0,
      status: "ok",
      detail: "first run",
    });
    expect(s.runId).toBe("recipe:AAA");

    // Second run, DIFFERENT payload → different runId. This mirrors the real
    // gate sequence: run A FAILED (phase "error"), then run B was started.
    s = panelReducer(s, {
      type: "RUN_ERROR",
      runId: "recipe:AAA",
      errorCode: "SELECTOR_NOT_FOUND",
      detail: "a field wasn't found",
    });
    expect(s.phase).toBe("error");
    s = panelReducer(s, { type: "SYNC", state: executingRun("recipe:BBB") });
    expect(s.phase, "error → executing is a legal retry").toBe("executing");
    expect(s.runId, "the panel must adopt the new run's id").toBe("recipe:BBB");

    const after = panelReducer(s, {
      type: "STEP",
      runId: "recipe:BBB",
      stepIndex: 0,
      status: "pending",
      detail: "second run step 1",
    });
    expect(after.steps, "second run's steps must not be dropped").toHaveLength(1);
    expect(after.steps[0]!.detail).toBe("second run step 1");
  });

  it("clears the previous run's step log when a new run starts", () => {
    let s = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });
    s = panelReducer(s, { type: "SYNC", state: { ...SOURCE_READY, status: "ready" } });
    s = panelReducer(s, { type: "SYNC", state: executingRun("recipe:AAA") });
    s = panelReducer(s, { type: "STEP", runId: "recipe:AAA", stepIndex: 0, status: "failed", detail: "old" });
    expect(s.steps).toHaveLength(1);

    s = panelReducer(s, {
      type: "RUN_ERROR",
      runId: "recipe:AAA",
      errorCode: "SELECTOR_NOT_FOUND",
      detail: "x",
    });
    s = panelReducer(s, { type: "SYNC", state: { ...SOURCE_READY, status: "ready" } });
    s = panelReducer(s, { type: "SYNC", state: executingRun("recipe:BBB") });
    expect(s.steps, "a new run starts with a clean log").toHaveLength(0);
  });

  it("still rejects a step from a DIFFERENT run while one is live", () => {
    // The guard must keep working: a late step from an aborted run must not
    // pollute the live run's log.
    let s = panelReducer(initialPanelState, { type: "SYNC", state: SOURCE_READY });
    s = panelReducer(s, { type: "SYNC", state: { ...SOURCE_READY, status: "ready" } });
    s = panelReducer(s, { type: "SYNC", state: executingRun("recipe:BBB") });
    const after = panelReducer(s, {
      type: "STEP",
      runId: "recipe:STALE",
      stepIndex: 3,
      status: "ok",
      detail: "late straggler",
    });
    expect(after).toBe(s);
  });
});

describe("snapshot shape tolerance", () => {
  it("REHYDRATEs a state written by an OLDER build (missing newer fields)", () => {
    // storage.session outlives an extension reload, so a snapshot can predate
    // runSteps / lastErrorDetail. Missing fields must not break the render.
    const legacy = {
      status: "source_ready",
      extracted: EXTRACTED,
      payload: null,
      sourceTabId: 1,
      targetTabId: null,
      runId: null,
      lastError: null,
      // runSteps and lastErrorDetail absent on purpose
    } as unknown as WorkflowState;

    const next = panelReducer(initialPanelState, { type: "REHYDRATE", state: legacy });

    expect(next.phase).toBe("sourceReady");
    expect(next.extracted?.subject).toBe(EXTRACTED.subject);
    expect(next.steps).toEqual([]);
    expect(next.errorDetail).toBeNull();
  });

  it("REHYDRATE restores errorDetail alongside error", () => {
    const errored: WorkflowState = {
      ...INITIAL_WORKFLOW_STATE,
      status: "error",
      lastError: "SYNTHESIS_AUTH",
      lastErrorDetail: "HTTP 400: API key not valid",
    };
    const next = panelReducer(initialPanelState, { type: "REHYDRATE", state: errored });

    expect(next.error).toBe("SYNTHESIS_AUTH");
    expect(next.errorDetail).toBe("HTTP 400: API key not valid");
  });
});
