/**
 * src/shared/messages.ts
 *
 * THE message contract. Every message that crosses a component boundary
 * (side panel ⇄ hub ⇄ content scripts) is a member of the SwivelMessage
 * discriminated union below. No untyped message objects, ever (Charter
 * Law 3): the hub switches on `type` and TypeScript narrows the payload,
 * so a malformed message is a compile error instead of a runtime mystery.
 *
 * SECURITY MODEL, in one place:
 * - Content scripts run inside untrusted pages. Anything arriving FROM a
 *   content script is untrusted input: the hub validates sender identity
 *   (sender.id === chrome.runtime.id) and treats field values as data,
 *   never as code or selectors to execute blindly.
 * - Messages routed TO a tab are readable by that tab's world. Therefore
 *   no message type in this union may ever carry the Gemini API key —
 *   the key lives in chrome.storage.local and is read only inside the
 *   service worker (Charter Law 2). Keeping the union closed makes that
 *   auditable: if it's not a field here, it can't be sent.
 */

// Type-only import: pulls the AutomationStep TYPE for RUN_RECIPE without a
// runtime dependency on recipes.ts (which imports zod). `import type` is
// fully erased at compile time, so no content-script bundle that imports
// messages.ts drags zod in through this line.
import type { AutomationStep } from "./recipes";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Priority values the LLM is allowed to emit (schema-enforced in Phase 3). */
export type SwivelPriority = "low" | "medium" | "high" | "urgent";

/**
 * The structured payload Swivel moves between tabs. Produced by Gemini in
 * the worker (Phase 3), reviewed/edited in the side panel (Phase 4),
 * consumed by the injection engine on the target tab (Phase 6).
 */
export interface SwivelPayload {
  ticket_title: string;
  /** Nullable: many source emails simply don't contain a customer id. */
  customer_id: string | null;
  priority: SwivelPriority;
  summary: string;
  action_items: string[];
  /** Where the context came from — used for traceability and loop closure. */
  source_url: string;
}

/** Raw material captured from the source tab, before AI synthesis. */
export interface ExtractedContext {
  sourceUrl: string;
  /** Email subject from Gmail; document.title from the generic extractor. */
  subject: string | null;
  /** "Name <email>" from Gmail; null from the generic extractor. */
  sender: string | null;
  bodyText: string;
}

const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_SUBJECT_LENGTH = 1000;
const MAX_SENDER_LENGTH = 1000;
const MAX_BODY_LENGTH = 100_000;

/**
 * Typed reasons extraction can fail — following the PING_FAILED pattern:
 * machine-readable code in the message, human wording owned by the panel.
 */
export type ExtractErrorCode =
  | "NO_EMAIL_OPEN" // Gmail tab is on the inbox list view, no thread open
  | "NO_ACTIVE_TAB_GRANT" // generic injection refused: user never invoked Swivel on this tab
  | "UNSUPPORTED_PAGE" // browser-internal page (chrome://, about:, …)
  | "EXTRACT_NO_RECEIVER" // no content script listening (tab predates install)
  | "GMAIL_EXTRACT_FAILED" // thread open but selectors failed (Gmail DOM drift?)
  | "GMAIL_BODY_NOT_RENDERED" // container resolved, but Gmail hadn't painted the thread yet
  | "GMAIL_SITE_ACCESS_BLOCKED" // permission held, but Chrome's site-access toggle is off
  | "EXTRACT_FAILED"; // catch-all

/**
 * ExtractedContext arrives FROM content scripts — untrusted input. The hub
 * runs this structural check before anything is persisted or forwarded.
 */
export function isExtractedContext(value: unknown): value is ExtractedContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.sourceUrl !== "string" ||
    v.sourceUrl.length > MAX_SOURCE_URL_LENGTH ||
    !/^https?:\/\//i.test(v.sourceUrl)
  ) {
    return false;
  }
  if (
    (typeof v.subject === "string" && v.subject.length > MAX_SUBJECT_LENGTH) ||
    (typeof v.sender === "string" && v.sender.length > MAX_SENDER_LENGTH) ||
    typeof v.bodyText !== "string" ||
    v.bodyText.length > MAX_BODY_LENGTH
  ) {
    return false;
  }
  return (
    (typeof v.subject === "string" || v.subject === null) &&
    (typeof v.sender === "string" || v.sender === null) &&
    typeof v.bodyText === "string"
  );
}

/** Workflow status the hub persists to chrome.storage.session. */
export type WorkflowStatus =
  | "idle"
  | "extracting"
  | "source_ready" // cleaned source text persisted, awaiting synthesis
  | "synthesizing"
  | "ready" // payload reviewed-able in the panel
  | "routing"
  | "executing"
  | "done"
  | "error";

/**
 * The single state blob the hub persists on EVERY transition. The MV3
 * worker can be killed between any two messages (Charter Law 1), so this —
 * not any in-memory variable — is the source of truth.
 */
/** One row of the run's step log, keyed by stepIndex. */
export interface RunStepRecord {
  stepIndex: number;
  status: "pending" | "ok" | "failed" | "skipped";
  detail: string | null;
}

export interface WorkflowState {
  status: WorkflowStatus;
  extracted: ExtractedContext | null;
  payload: SwivelPayload | null;
  sourceTabId: number | null;
  targetTabId: number | null;
  /** The active run's id (Phase 7). Persisted so a woken worker can relay
   *  step updates for the run it left in flight, and the panel can adopt it
   *  on rehydrate. The run itself lives in the target content script. */
  runId: string | null;
  /**
   * The current run's step log, accumulated by the hub idempotently by
   * stepIndex and PERSISTED (Phase 8). This is what makes the log survive a
   * worker death or a panel reload: on rehydrate the panel reads it back
   * instead of showing an empty run. Reset when a new run starts.
   */
  runSteps: RunStepRecord[];
  /** Whether the ACTIVE run is a dry run — set by the hub when it dispatches,
   *  so the executing view says so from hub truth and survives a rehydrate. */
  runDryRun: boolean | null;
  lastError: string | null;
  /**
   * Operator-facing detail for lastError — the HTTP status, the API's error
   * body, the failing selector. Added after the final-gate defects: the hub
   * was computing this and DISCARDING it, which is what made a Gemini
   * failure indistinguishable from every other Gemini failure.
   *
   * Rendered as secondary text under helpFor(lastError), never in place of
   * it, so the Charter's "no raw errors in the UI" rule still holds: the
   * primary message is always the curated one.
   */
  lastErrorDetail: string | null;
}

export const INITIAL_WORKFLOW_STATE: WorkflowState = {
  status: "idle",
  extracted: null,
  payload: null,
  sourceTabId: null,
  targetTabId: null,
  runId: null,
  runSteps: [],
  runDryRun: null,
  lastError: null,
  lastErrorDetail: null,
};

// ---------------------------------------------------------------------------
// Message union
// ---------------------------------------------------------------------------

/** Panel/worker → content: prove the full round-trip works (Phase 1 gate). */
export interface PingMessage {
  type: "PING";
  /** Hop log, appended at each stop so the panel can display the route. */
  hops: string[];
}

/** Content → sender: PING response. */
export interface PongMessage {
  type: "PONG";
  hops: string[];
}

/** Panel → hub: extract context from the active (source) tab. */
export interface ExtractRequestMessage {
  type: "EXTRACT_REQUEST";
}

/** Content (source tab) → hub: extraction outcome. */
export interface ExtractResultMessage {
  type: "EXTRACT_RESULT";
  ok: boolean;
  context: ExtractedContext | null;
  /** Typed reason on failure, e.g. "NO_EMAIL_OPEN" (Phase 2). */
  errorCode: string | null;
}

/** Hub → panel: extraction finished; cleaned source text is persisted. */
export interface PayloadSourceReadyMessage {
  type: "PAYLOAD_SOURCE_READY";
  extracted: ExtractedContext;
}

/** Panel → hub: run Gemini over the extracted context (Phase 3). */
export interface SynthesizeMessage {
  type: "SYNTHESIZE";
}

/** Hub → panel: validated payload is persisted and ready for review. */
export interface PayloadReadyMessage {
  type: "PAYLOAD_READY";
  payload: SwivelPayload;
}

/**
 * Panel → hub: the user edited the payload in the review form. The hub
 * re-validates (the panel is our own code, but this still crosses a trust
 * boundary) and persists to storage.session, so closing/reopening the
 * panel never loses an edit (Phase 4).
 */
export interface PayloadEditMessage {
  type: "PAYLOAD_EDIT";
  payload: SwivelPayload;
}

/**
 * Hub → target content script: execute a recipe (Phase 7). Carries the
 * already-validated steps (so the target needs neither recipes.ts nor zod)
 * and the payload whose fields the fill steps reference. runId = hash of
 * payload + recipeId; the executor refuses to re-run the same runId.
 */
export interface RunRecipeMessage {
  type: "RUN_RECIPE";
  runId: string;
  steps: AutomationStep[];
  payload: SwivelPayload;
  dryRun: boolean;
}

/**
 * Hub → target content script: stop the named run (Phase 8). Sent when the
 * hub detects the target tab client-side-navigated mid-run. The executor
 * aborts its AbortController, cancelling every pending waitForElement.
 */
export interface AbortRunMessage {
  type: "ABORT_RUN";
  runId: string;
}

/** Panel → hub: user confirmed — route the payload to a target (Phase 5). */
export interface AutomateToTargetMessage {
  type: "AUTOMATE_TO_TARGET";
  recipeId: string;
  dryRun: boolean;
  /** When set, the user already picked this tab from a candidate list, so
   *  the hub skips discovery and routes straight to it. */
  tabId?: number;
}

/** A candidate destination tab when a recipe matches more than one. */
export interface TargetCandidate {
  tabId: number;
  title: string;
  url: string;
}

/** Hub → panel: the recipe matched multiple tabs; the user must pick one. */
export interface TargetCandidatesMessage {
  type: "TARGET_CANDIDATES";
  recipeId: string;
  dryRun: boolean;
  candidates: TargetCandidate[];
}

/** Panel → hub: no target tab is open — open the recipe's canonical URL. */
export interface OpenTargetMessage {
  type: "OPEN_TARGET";
  recipeId: string;
}

/**
 * Loop closure (Phase 9). Panel → hub → Gmail content script: draft a reply
 * on the open thread containing the ticket link. gmail.ts clicks Reply and
 * inserts the template — it NEVER clicks Send (the Send-denial law).
 */
export interface DraftReplyMessage {
  type: "DRAFT_REPLY";
  issueKey: string;
  issueUrl: string;
  template: string;
}

/** Gmail content script → hub → panel: outcome of the draft. */
export interface DraftReplyDoneMessage {
  type: "DRAFT_REPLY_DONE";
  ok: boolean;
  errorCode: string | null;
}

/** Panel → hub: reset the workflow (clear run + payload), keep settings. */
export interface StartOverMessage {
  type: "START_OVER";
}

/** One selector's resolution result from the staleness checker. */
export interface SelectorTestResult {
  selector: string;
  resolved: boolean;
}

/** Panel → hub: dry-check a recipe's selectors against the open target
 *  (Phase 10 "test selectors" — the recipe-staleness early warning). */
export interface TestSelectorsRequestMessage {
  type: "TEST_SELECTORS_REQUEST";
  recipeId: string;
  /** Existing target tab chosen by the user after a multiple-tab result. */
  tabId?: number;
}

/** Hub → target content script: resolve each selector, act on none. */
export interface TestSelectorsMessage {
  type: "TEST_SELECTORS";
  selectors: string[];
}

/** Target → hub → panel: which selectors currently resolve. */
export interface TestSelectorsResultMessage {
  type: "TEST_SELECTORS_RESULT";
  results: SelectorTestResult[];
}

/**
 * Panel → hub: make ONE minimal live Gemini call and report exactly what
 * happened. Added after the final gate: a silent synthesis failure gave the
 * user no way to tell "my key is wrong" from "the extension is broken"
 * without opening the service worker devtools. This isolates that.
 *
 * The key itself is NOT a field here — the worker reads it from
 * storage.local as always (Charter Law 2 / the Phase 3 deviation).
 */
export interface TestKeyRequestMessage {
  type: "TEST_KEY_REQUEST";
}

/** Hub → panel: the outcome of the probe call. `detail` carries the HTTP
 *  status / API error body for display as secondary text. */
export interface TestKeyResultMessage {
  type: "TEST_KEY_RESULT";
  ok: boolean;
  /** Typed code when !ok — rendered through helpFor(). */
  errorCode: string | null;
  detail: string | null;
  /** The model the probe actually used, so Settings can show it. */
  model: string;
}

/** Content (target tab) → hub → panel: per-step progress (Phase 6). */
export interface AutomationStepUpdateMessage {
  type: "AUTOMATION_STEP_UPDATE";
  runId: string;
  stepIndex: number;
  status: "pending" | "ok" | "failed" | "skipped";
  detail: string | null;
}

/** Content (target tab) → hub → panel: the run finished (Phase 8 adds readback). */
/**
 * What a finished run ACTUALLY did — reported by the executor, which is the
 * only component that knows.
 *
 * WHY THIS EXISTS (Gate 6, stop-class): the panel previously received nothing
 * but "the run ended" and rendered a hardcoded "Ticket created ✓". A DRY RUN
 * ends exactly the same way — so a run that deliberately submitted nothing
 * claimed a ticket had been created in an external system. Completion is not
 * creation, and the panel cannot tell them apart by itself.
 */
export interface RunOutcome {
  /** Was this a dry run? Dry runs submit NOTHING, by construction. */
  dryRun: boolean;
  /**
   * Did a step marked `submits` actually execute AND succeed? This is the
   * ONLY basis on which anything may claim a ticket was created. False for
   * every dry run, and false for a real run that ended before the submit.
   */
  submitted: boolean;
  /** Steps that really ran (excludes dry-run and optional skips). */
  stepsExecuted: number;
  /** Steps skipped: dry-run submit-boundary skips + absent optional steps. */
  stepsSkipped: number;
  /** Elements outlined during a dry run — what the user should have seen. */
  highlighted: number;
}

export interface AutomationDoneMessage {
  type: "AUTOMATION_DONE";
  runId: string;
  readBack: Record<string, string>;
  outcome: RunOutcome;
}

/** Any component → hub → panel: the run failed with a typed reason. */
export interface AutomationErrorMessage {
  type: "AUTOMATION_ERROR";
  runId: string | null;
  errorCode: string;
  detail: string;
}

/** Panel → hub: panel (re)opened; reply with current persisted state. */
export interface GetStateMessage {
  type: "GET_STATE";
}

/** Hub → panel: current persisted workflow state. */
export interface StateSnapshotMessage {
  type: "STATE_SNAPSHOT";
  state: WorkflowState;
}

export type SwivelMessage =
  | PingMessage
  | PongMessage
  | ExtractRequestMessage
  | ExtractResultMessage
  | PayloadSourceReadyMessage
  | PayloadEditMessage
  | SynthesizeMessage
  | PayloadReadyMessage
  | RunRecipeMessage
  | AbortRunMessage
  | AutomateToTargetMessage
  | TargetCandidatesMessage
  | OpenTargetMessage
  | DraftReplyMessage
  | DraftReplyDoneMessage
  | StartOverMessage
  | TestSelectorsRequestMessage
  | TestSelectorsMessage
  | TestSelectorsResultMessage
  | TestKeyRequestMessage
  | TestKeyResultMessage
  | AutomationStepUpdateMessage
  | AutomationDoneMessage
  | AutomationErrorMessage
  | GetStateMessage
  | StateSnapshotMessage;

/**
 * Runtime type guard. chrome.runtime.onMessage delivers `unknown` from a
 * boundary we don't control; this narrows it before the hub's switch. It
 * deliberately checks only the envelope (an object with a known `type`) —
 * per-field validation of untrusted content-script data deepens in Phase 3
 * with zod.
 */
const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "PING",
  "PONG",
  "EXTRACT_REQUEST",
  "EXTRACT_RESULT",
  "PAYLOAD_SOURCE_READY",
  "PAYLOAD_EDIT",
  "SYNTHESIZE",
  "PAYLOAD_READY",
  "RUN_RECIPE",
  "ABORT_RUN",
  "AUTOMATE_TO_TARGET",
  "TARGET_CANDIDATES",
  "OPEN_TARGET",
  "DRAFT_REPLY",
  "DRAFT_REPLY_DONE",
  "START_OVER",
  "TEST_SELECTORS_REQUEST",
  "TEST_SELECTORS",
  "TEST_SELECTORS_RESULT",
  "TEST_KEY_REQUEST",
  "TEST_KEY_RESULT",
  "AUTOMATION_STEP_UPDATE",
  "AUTOMATION_DONE",
  "AUTOMATION_ERROR",
  "GET_STATE",
  "STATE_SNAPSHOT",
]);

export function isSwivelMessage(value: unknown): value is SwivelMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    MESSAGE_TYPES.has((value as { type: string }).type)
  );
}
