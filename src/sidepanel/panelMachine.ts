/**
 * src/sidepanel/panelMachine.ts — the side panel's state machine.
 *
 * The panel is a DUMB VIEW of hub state (Charter Law 3 / Phase 4): it holds
 * no business logic. This reducer is the whole of its logic, and it is a
 * PURE function — same inputs, same output, no chrome.*, no side effects —
 * so it is exhaustively unit-testable without jsdom (panelMachine.test.ts).
 *
 * TWO CLASSES OF INPUT, deliberately distinct:
 *
 *  1. REHYDRATE — fired once on mount from the GET_STATE read of
 *     storage.session. This ESTABLISHES initial truth, so it is applied
 *     unconditionally: the panel may have been closed for minutes and the
 *     workflow moved on without it. Not a transition — a load.
 *
 *  2. SYNC — every runtime STATE_SNAPSHOT broadcast. This IS a transition,
 *     so it is transition-guarded: an illegal jump (e.g. done → executing,
 *     or a stale "synthesizing" arriving after "ready") is REJECTED, and
 *     the current state is preserved. This is what protects the view from
 *     out-of-order or duplicated broadcasts.
 *
 *  3. Streaming run events (STEP / RUN_DONE / RUN_ERROR) arrive over the
 *     Port during execution. They are accepted only while executing and
 *     only for the active runId; anything else (a late step from an
 *     aborted run, a wrong runId) is rejected.
 */

import type {
  ExtractedContext,
  RunOutcome,
  SwivelPayload,
  WorkflowState,
  WorkflowStatus,
} from "../shared/messages";

export type PanelPhase =
  | "idle"
  | "extracting"
  | "sourceReady"
  | "synthesizing"
  | "review"
  | "routing"
  | "executing"
  | "done"
  | "error";

/**
 * "skipped" is distinct from "ok" ON PURPOSE (Gate 6 audit). A dry-run submit
 * skip and an absent optional step both used to report "ok", so the step log
 * showed a green tick for work that never happened — the same "success text
 * not backed by what executed" defect as the done view's headline.
 */
export type StepStatus = "pending" | "ok" | "failed" | "skipped";

export interface StepView {
  stepIndex: number;
  status: StepStatus;
  detail: string | null;
}

export interface PanelState {
  phase: PanelPhase;
  extracted: ExtractedContext | null;
  payload: SwivelPayload | null;
  runId: string | null;
  steps: StepView[];
  readBack: Record<string, string> | null;
  /** What the finished run actually did (Gate 6). Null until a run ends. */
  runOutcome: RunOutcome | null;
  /** Is the IN-PROGRESS run a dry run? From hub state, not a local flag. */
  runDryRun: boolean | null;
  error: string | null;
  /** Secondary operator detail for `error` (HTTP status, API body, failing
   *  selector). Rendered UNDER helpFor(error), never instead of it. */
  errorDetail: string | null;
}

export const initialPanelState: PanelState = {
  phase: "idle",
  extracted: null,
  payload: null,
  runId: null,
  steps: [],
  readBack: null,
  runOutcome: null,
  runDryRun: null,
  error: null,
  errorDetail: null,
};

export type PanelAction =
  | { type: "REHYDRATE"; state: WorkflowState }
  | { type: "SYNC"; state: WorkflowState }
  | {
      type: "STEP";
      runId: string;
      stepIndex: number;
      status: StepStatus;
      detail: string | null;
    }
  | {
      type: "RUN_DONE";
      runId: string;
      readBack: Record<string, string>;
      /** What the run actually did. Null only from a pre-Gate-6 executor. */
      outcome: RunOutcome | null;
    }
  | { type: "RUN_ERROR"; runId: string | null; errorCode: string; detail: string };

/** Hub workflow status → panel phase. The hub owns "ready" (a validated
 *  payload exists); the panel presents that as the editable "review" screen. */
export function mapStatus(status: WorkflowStatus): PanelPhase {
  switch (status) {
    case "idle":
      return "idle";
    case "extracting":
      return "extracting";
    case "source_ready":
      return "sourceReady";
    case "synthesizing":
      return "synthesizing";
    case "ready":
      return "review";
    case "routing":
      return "routing";
    case "executing":
      return "executing";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

/**
 * Legal successor phases for a SYNC transition. "idle" and "error" are
 * always reachable (a reset or a failure can happen from anywhere), so they
 * are handled in isLegalTransition rather than repeated in every row.
 *
 * THE GOVERNING FACT, learned the hard way across two gate runs: THE HUB
 * BROADCASTS ONLY SETTLED STATUSES. It writes "extracting" and "synthesizing"
 * with setState and no broadcast, and it never writes "routing" at all
 * (Phase 7 replaced that path — dispatchRun goes straight to "executing").
 *
 * So the panel's real observed sequence is:
 *     idle → sourceReady → review → executing → done(Port)
 * NOT the idealised one this table was originally written against. Every edge
 * that "skips a transient" is therefore a LEGAL edge, and each one that was
 * missing produced the identical bug: a successful operation, a snapshot
 * silently dropped by the reducer, and a view that never mounted.
 *
 * The phases "extracting", "synthesizing" and "routing" are kept as rows
 * because REHYDRATE can still land on them, but they are not reachable via
 * SYNC in the current hub.
 *
 * When adding a status broadcast to the hub, add its edges here AND a case to
 * the happy-path test — the table is not self-evident from the hub's code.
 */
const PHASE_TRANSITIONS: Record<PanelPhase, readonly PanelPhase[]> = {
  // idle → sourceReady is LEGAL and its absence was a real bug (gate run #2).
  //
  // The panel does not dispatch an optimistic "extracting" phase, and the hub
  // does not broadcast one either — it persists status "extracting" and goes
  // straight to work. So the FIRST snapshot a fresh idle panel ever sees for
  // a successful extraction is source_ready. Requiring it to pass through
  // "extracting" meant that snapshot was rejected, `extracted` was never
  // copied into panel state, and every render branch gated on it stayed
  // unmounted — while the hub logged a perfectly successful extraction.
  //
  // The keyboard command makes this reachable by design, not just by race:
  // it extracts without the panel participating at all, so a panel sitting
  // at idle legitimately receives source_ready out of nowhere.
  idle: ["extracting", "sourceReady"],
  extracting: ["sourceReady"],
  // sourceReady → review: the same defect as idle → sourceReady, one step
  // later. The hub sets "synthesizing" without broadcasting it, so a panel at
  // sourceReady goes straight to a "ready" snapshot.
  sourceReady: ["extracting", "synthesizing", "review"],
  synthesizing: ["review", "sourceReady"],
  // review → executing: the SAME defect again, one step further. dispatchRun
  // persists "executing" directly — there is no intermediate broadcast — so a
  // panel at review receives "executing" as its next snapshot. Without this
  // edge, fixing sourceReady → review would simply have moved the failure to
  // the Automate button.
  // review → sourceReady: re-extracting from the review screen.
  review: ["extracting", "synthesizing", "sourceReady", "routing", "executing"],
  routing: ["executing", "review", "sourceReady", "extracting"],
  // executing is DELIBERATELY narrow — this is the one row that should reject.
  // A live run's step log lives in panel state; a stray or stale snapshot
  // (e.g. an extraction the user kicked off in another tab) must not blank it.
  // "done" arrives over the Port, not as a SYNC.
  executing: ["done"],
  done: ["extracting", "sourceReady"],
  // error is a retry springboard: every retry lands on a SETTLED status,
  // because the transient one it passes through is never broadcast.
  error: ["extracting", "synthesizing", "sourceReady", "review", "routing", "executing"],
};

/**
 * Would a SYNC carrying `hub` be ACCEPTED from `from`?
 *
 * Exported so the UI can detect a silently-dropped snapshot instead of
 * reporting success that never rendered (gate run #2, item d). A rejected
 * SYNC is invisible by design — the reducer returns the previous state — so
 * without this the caller cannot tell "applied" from "dropped".
 */
/**
 * What the done view is allowed to say about a finished run.
 *
 * THE RULE (Gate 6, stop-class): completion is NOT creation. This is the one
 * place that decides, it decides from the executor's RunOutcome, and it is
 * pure so the decision is testable without a browser. The done view renders
 * this and nothing else — there is no second path to a success string.
 *
 * `claimsCreation` exists so a test can assert the property directly rather
 * than string-matching UI copy: it must be false for every dry run, and false
 * for any run whose submit step did not execute.
 */
export interface RunReport {
  headline: string;
  detail: string;
  tone: "created" | "neutral" | "warning";
  /** True only when a ticket genuinely exists in the target system. */
  claimsCreation: boolean;
  /** Offer "Draft reply" only for a real, identified ticket. */
  canDraftReply: boolean;
}

export function describeRunOutcome(
  outcome: RunOutcome | null,
  readBack: Record<string, string> | null
): RunReport {
  const issueKey = readBack?.issueKey ?? "";
  const issueUrl = readBack?.issueUrl ?? "";
  const identified = issueKey !== "" || issueUrl !== "";

  // No outcome record: a run from an older build, or a state we cannot
  // account for. Say exactly that — never assume success.
  if (!outcome) {
    return {
      headline: "Run finished",
      detail:
        "Swivel couldn't determine what this run did, so it is not claiming anything was created. Check the target before retrying.",
      tone: "warning",
      claimsCreation: false,
      canDraftReply: false,
    };
  }

  // DRY RUN — structurally incapable of creating anything. Checked FIRST so
  // no later branch can produce creation language for it.
  if (outcome.dryRun) {
    return {
      headline: "Dry run complete — nothing was submitted",
      detail:
        `${outcome.highlighted} field${outcome.highlighted === 1 ? "" : "s"} highlighted on the target ` +
        `(the outline fades after ~1.5s). No ticket was created. Turn off Dry run to create it for real.`,
      tone: "neutral",
      claimsCreation: false,
      canDraftReply: false,
    };
  }

  // A real run that never reached its submit step. The step log may be all
  // green — optional steps report "ok" when they skip — but nothing was
  // committed, so this must not read as success.
  if (!outcome.submitted) {
    return {
      headline: "Run finished without submitting",
      detail:
        "No step that commits data ran, so nothing was created in the target system. Check the step log above.",
      tone: "warning",
      claimsCreation: false,
      canDraftReply: false,
    };
  }

  // Submitted AND identified: the only case that may claim creation.
  if (identified) {
    return {
      headline: "Ticket created",
      detail: issueKey ? `Created ${issueKey}.` : "Created — see the link below.",
      tone: "created",
      claimsCreation: true,
      canDraftReply: true,
    };
  }

  // Submitted but the key could not be read back (post-submit steps are
  // optional now, so this is expected when Jira's success DOM has drifted).
  // The ticket very likely EXISTS — say so, and warn against a blind retry.
  return {
    headline: "Submitted — but the issue key couldn't be read back",
    detail:
      "The submit step ran, so a ticket was most likely created. Swivel couldn't read its key, so check the target before retrying — a retry could create a duplicate.",
    tone: "warning",
    claimsCreation: true,
    canDraftReply: false,
  };
}

export function willAcceptSync(from: PanelPhase, hub: WorkflowState): boolean {
  return isLegalTransition(from, mapStatus(hub.status));
}

export function isLegalTransition(from: PanelPhase, to: PanelPhase): boolean {
  // Self-transition (a repeated broadcast of the same status) is always
  // fine; idle and error are always reachable as reset / failure valves.
  if (to === from || to === "idle" || to === "error") return true;
  return PHASE_TRANSITIONS[from].includes(to);
}

/** Copy the hub-owned fields (extracted, payload, error) into panel state. */
function withHubFields(state: PanelState, hub: WorkflowState, phase: PanelPhase): PanelState {
  const enteringExecuting = phase === "executing" && state.phase !== "executing";
  return {
    ...state,
    phase,
    extracted: hub.extracted,
    payload: hub.payload,
    error: hub.status === "error" ? hub.lastError : null,
    errorDetail: hub.status === "error" ? hub.lastErrorDetail : null,
    // A fresh run clears any prior run's log; otherwise preserve it (so the
    // done/error screens still show what happened).
    steps: enteringExecuting ? [] : state.steps,
    readBack: enteringExecuting ? null : state.readBack,
    runOutcome: enteringExecuting ? null : state.runOutcome,
    // ADOPT THE NEW RUN'S ID (Gate 7). This was never copied, so the panel
    // kept the runId it adopted from the FIRST step it ever saw. A later run
    // with a different runId — any edit to the payload changes it, since the
    // id is a hash of the payload — had every one of its steps rejected by
    // the STEP guard below. Symptom: phase "executing", no steps, forever.
    runId: enteringExecuting ? hub.runId : state.runId,
    runDryRun: hub.runDryRun ?? null,
  };
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    // Unconditional load — establishes initial truth from storage.session.
    case "REHYDRATE": {
      const phase = mapStatus(action.state.status);
      return {
        ...initialPanelState,
        phase,
        extracted: action.state.extracted,
        payload: action.state.payload,
        // Adopt the hub's runId so a panel that reopens mid-run accepts the
        // in-flight run's step events (they're keyed by runId), and restore
        // the persisted step log so the run view isn't blank after a reload
        // or worker death (Phase 8).
        runId: action.state.runId,
        // Tolerate a state persisted by an OLDER build: storage.session
        // survives an extension reload, so a snapshot written before
        // runSteps/lastErrorDetail existed comes back missing them.
        steps: action.state.runSteps ?? [],
        runDryRun: action.state.runDryRun ?? null,
        error: action.state.status === "error" ? action.state.lastError : null,
        errorDetail: action.state.status === "error" ? (action.state.lastErrorDetail ?? null) : null,
      };
    }

    // Transition-guarded live update.
    case "SYNC": {
      const target = mapStatus(action.state.status);
      if (!isLegalTransition(state.phase, target)) return state; // reject
      return withHubFields(state, action.state, target);
    }

    // Streaming run events — only while executing, only for the active run.
    case "STEP": {
      if (state.phase !== "executing") return state; // reject stale step
      // Adopt the runId on the first step; reject steps from any other run.
      if (state.runId !== null && state.runId !== action.runId) return state;
      const runId = state.runId ?? action.runId;
      const existing = state.steps.findIndex((s) => s.stepIndex === action.stepIndex);
      const next: StepView = {
        stepIndex: action.stepIndex,
        status: action.status,
        detail: action.detail,
      };
      const steps =
        existing >= 0
          ? state.steps.map((s, i) => (i === existing ? next : s))
          : [...state.steps, next].sort((a, b) => a.stepIndex - b.stepIndex);
      return { ...state, runId, steps };
    }

    case "RUN_DONE": {
      if (state.phase !== "executing") return state;
      if (state.runId !== null && state.runId !== action.runId) return state;
      // Store the executor's facts. The done view derives EVERY word it says
      // from these (describeRunOutcome) — it has no other source.
      return {
        ...state,
        phase: "done",
        readBack: action.readBack,
        runOutcome: action.outcome,
      };
    }

    case "RUN_ERROR": {
      if (state.phase !== "executing") return state;
      if (action.runId !== null && state.runId !== null && state.runId !== action.runId) {
        return state;
      }
      // Mark the last pending step failed, if there is one, for the log.
      const steps = state.steps.map((s) =>
        s.status === "pending" ? { ...s, status: "failed" as const } : s
      );
      return { ...state, phase: "error", error: action.errorCode, steps };
    }
  }
}
