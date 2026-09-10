import { describe, expect, it } from "vitest";
import {
  initialPanelState,
  isLegalTransition,
  mapStatus,
  panelReducer,
  type PanelPhase,
  type PanelState,
} from "../src/sidepanel/panelMachine";
import {
  INITIAL_WORKFLOW_STATE,
  type SwivelPayload,
  type WorkflowState,
  type WorkflowStatus,
} from "../src/shared/messages";

const PAYLOAD: SwivelPayload = {
  ticket_title: "T",
  customer_id: null,
  priority: "medium",
  summary: "S",
  action_items: [],
  source_url: "https://mail.google.com/x",
};

function hub(patch: Partial<WorkflowState>): WorkflowState {
  return { ...INITIAL_WORKFLOW_STATE, ...patch };
}

/** Put the machine directly into a phase for transition tests. */
function at(phase: PanelPhase, patch: Partial<PanelState> = {}): PanelState {
  return { ...initialPanelState, phase, ...patch };
}

describe("mapStatus", () => {
  const cases: [WorkflowStatus, PanelPhase][] = [
    ["idle", "idle"],
    ["extracting", "extracting"],
    ["source_ready", "sourceReady"],
    ["synthesizing", "synthesizing"],
    ["ready", "review"],
    ["routing", "routing"],
    ["executing", "executing"],
    ["done", "done"],
    ["error", "error"],
  ];
  it.each(cases)("maps hub %s → panel %s", (status, phase) => {
    expect(mapStatus(status)).toBe(phase);
  });
});

describe("isLegalTransition", () => {
  it("allows self-transition from every phase", () => {
    const phases: PanelPhase[] = [
      "idle", "extracting", "sourceReady", "synthesizing",
      "review", "routing", "executing", "done", "error",
    ];
    for (const p of phases) expect(isLegalTransition(p, p)).toBe(true);
  });

  it("allows idle and error as targets from anywhere (reset / failure valves)", () => {
    expect(isLegalTransition("executing", "error")).toBe(true);
    expect(isLegalTransition("done", "idle")).toBe(true);
    expect(isLegalTransition("review", "idle")).toBe(true);
  });

  it("allows the happy-path chain", () => {
    expect(isLegalTransition("idle", "extracting")).toBe(true);
    expect(isLegalTransition("extracting", "sourceReady")).toBe(true);
    expect(isLegalTransition("sourceReady", "synthesizing")).toBe(true);
    expect(isLegalTransition("synthesizing", "review")).toBe(true);
    expect(isLegalTransition("review", "routing")).toBe(true);
    expect(isLegalTransition("routing", "executing")).toBe(true);
    expect(isLegalTransition("executing", "done")).toBe(true);
  });

  it("rejects nonsensical jumps", () => {
    expect(isLegalTransition("idle", "executing")).toBe(false);
    expect(isLegalTransition("done", "executing")).toBe(false);
    expect(isLegalTransition("idle", "review")).toBe(false);
    expect(isLegalTransition("extracting", "routing")).toBe(false);
  });

  it("allows re-extract / re-synthesize from stable phases", () => {
    expect(isLegalTransition("review", "extracting")).toBe(true);
    expect(isLegalTransition("review", "synthesizing")).toBe(true);
    expect(isLegalTransition("done", "extracting")).toBe(true);
    expect(isLegalTransition("error", "synthesizing")).toBe(true);
  });
});

describe("panelReducer — REHYDRATE (unconditional load)", () => {
  it("sets phase and fields from persisted state, even across a 'jump'", () => {
    // Panel was closed while a run was executing — rehydrate must land there
    // directly, no transition guard.
    const next = panelReducer(
      initialPanelState,
      { type: "REHYDRATE", state: hub({ status: "executing", payload: PAYLOAD }) }
    );
    expect(next.phase).toBe("executing");
    expect(next.payload).toEqual(PAYLOAD);
  });

  it("restores the persisted step log so a reopened panel isn't blank", () => {
    const next = panelReducer(initialPanelState, {
      type: "REHYDRATE",
      state: hub({
        status: "executing",
        payload: PAYLOAD,
        runId: "r9",
        runSteps: [
          { stepIndex: 0, status: "ok", detail: "filled title" },
          { stepIndex: 1, status: "pending", detail: "filling summary" },
        ],
      }),
    });
    expect(next.phase).toBe("executing");
    expect(next.runId).toBe("r9");
    expect(next.steps).toHaveLength(2);
    expect(next.steps[1]?.status).toBe("pending");
  });

  it("carries the error code only when status is error", () => {
    const err = panelReducer(initialPanelState, {
      type: "REHYDRATE",
      state: hub({ status: "error", lastError: "SYNTHESIS_AUTH" }),
    });
    expect(err.phase).toBe("error");
    expect(err.error).toBe("SYNTHESIS_AUTH");

    const ok = panelReducer(initialPanelState, {
      type: "REHYDRATE",
      state: hub({ status: "ready", payload: PAYLOAD, lastError: "stale" }),
    });
    expect(ok.error).toBeNull();
  });
});

describe("panelReducer — SYNC (transition-guarded)", () => {
  it("accepts a legal transition and copies hub fields", () => {
    const next = panelReducer(
      at("synthesizing"),
      { type: "SYNC", state: hub({ status: "ready", payload: PAYLOAD }) }
    );
    expect(next.phase).toBe("review");
    expect(next.payload).toEqual(PAYLOAD);
  });

  it("REJECTS an illegal transition (state unchanged)", () => {
    const start = at("idle");
    const next = panelReducer(start, {
      type: "SYNC",
      state: hub({ status: "executing" }),
    });
    expect(next).toBe(start); // identity — nothing changed
  });

  it("rejects a stale 'synthesizing' arriving after 'review' is a legal back-edge", () => {
    // review → synthesizing is legal (re-synthesize), so this is accepted.
    const next = panelReducer(at("review", { payload: PAYLOAD }), {
      type: "SYNC",
      state: hub({ status: "synthesizing" }),
    });
    expect(next.phase).toBe("synthesizing");
  });

  it("resets the step log when entering executing fresh", () => {
    const start = at("routing", { steps: [{ stepIndex: 0, status: "ok", detail: null }] });
    const next = panelReducer(start, { type: "SYNC", state: hub({ status: "executing" }) });
    expect(next.phase).toBe("executing");
    expect(next.steps).toEqual([]);
  });
});

describe("panelReducer — STEP", () => {
  it("is rejected outside executing (stale step from an aborted run)", () => {
    const start = at("idle");
    const next = panelReducer(start, {
      type: "STEP",
      runId: "r1",
      stepIndex: 0,
      status: "ok",
      detail: null,
    });
    expect(next).toBe(start);
  });

  it("adopts the runId on the first step and appends", () => {
    const next = panelReducer(at("executing"), {
      type: "STEP",
      runId: "r1",
      stepIndex: 0,
      status: "pending",
      detail: "click submit",
    });
    expect(next.runId).toBe("r1");
    expect(next.steps).toHaveLength(1);
    expect(next.steps[0]?.detail).toBe("click submit");
  });

  it("rejects a step from a different runId", () => {
    const start = at("executing", { runId: "r1" });
    const next = panelReducer(start, {
      type: "STEP",
      runId: "r2",
      stepIndex: 0,
      status: "ok",
      detail: null,
    });
    expect(next).toBe(start);
  });

  it("updates a step in place by stepIndex (pending → ok)", () => {
    let s = at("executing");
    s = panelReducer(s, { type: "STEP", runId: "r1", stepIndex: 0, status: "pending", detail: "x" });
    s = panelReducer(s, { type: "STEP", runId: "r1", stepIndex: 0, status: "ok", detail: "x" });
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]?.status).toBe("ok");
  });

  it("keeps steps sorted by index regardless of arrival order", () => {
    let s = at("executing");
    s = panelReducer(s, { type: "STEP", runId: "r1", stepIndex: 2, status: "ok", detail: null });
    s = panelReducer(s, { type: "STEP", runId: "r1", stepIndex: 0, status: "ok", detail: null });
    expect(s.steps.map((x) => x.stepIndex)).toEqual([0, 2]);
  });
});

describe("panelReducer — RUN_DONE / RUN_ERROR", () => {
  it("RUN_DONE moves executing → done and stores readBack", () => {
    const next = panelReducer(at("executing", { runId: "r1" }), {
      type: "RUN_DONE",
      runId: "r1",
      readBack: { issueKey: "ABC-1", issueUrl: "https://x/ABC-1" },
    });
    expect(next.phase).toBe("done");
    expect(next.readBack?.issueKey).toBe("ABC-1");
  });

  it("RUN_DONE is rejected outside executing", () => {
    const start = at("review");
    expect(panelReducer(start, { type: "RUN_DONE", runId: "r1", readBack: {} })).toBe(start);
  });

  it("RUN_ERROR moves executing → error and fails any pending step", () => {
    const start = at("executing", {
      runId: "r1",
      steps: [
        { stepIndex: 0, status: "ok", detail: null },
        { stepIndex: 1, status: "pending", detail: null },
      ],
    });
    const next = panelReducer(start, {
      type: "RUN_ERROR",
      runId: "r1",
      errorCode: "SELECTOR_NOT_FOUND",
      detail: "recipe may be stale",
    });
    expect(next.phase).toBe("error");
    expect(next.error).toBe("SELECTOR_NOT_FOUND");
    expect(next.steps[1]?.status).toBe("failed");
    expect(next.steps[0]?.status).toBe("ok");
  });

  it("RUN_ERROR from a mismatched runId is rejected", () => {
    const start = at("executing", { runId: "r1" });
    const next = panelReducer(start, {
      type: "RUN_ERROR",
      runId: "r2",
      errorCode: "X",
      detail: "",
    });
    expect(next).toBe(start);
  });
});
