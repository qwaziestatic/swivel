/**
 * src/background/index.ts — the Swivel message hub (MV3 service worker).
 *
 * ROLE: every message in the system flows through here. The side panel and
 * the content scripts never talk to each other directly — the hub is the
 * only component that knows which tab is the source, which is the target,
 * and what state the workflow is in (Charter Law 3).
 *
 * LIFETIME: this worker is EPHEMERAL. Chrome kills it after ~30s of idle
 * and revives it on the next event. Any `let` up here survives only until
 * the next kill, so in-memory values are a CACHE — the truth lives in
 * chrome.storage.session, written on every state transition and re-read
 * (rehydrated) lazily on wake (Charter Law 1).
 *
 * SECURITY:
 * - Every incoming message is sender-validated: it must originate from
 *   this extension (sender.id === chrome.runtime.id). Web pages cannot
 *   reach chrome.runtime.sendMessage for us without externally_connectable
 *   (which we do not declare), but defense in depth is free.
 * - Messages FROM content scripts are untrusted input — they run inside
 *   pages we don't control. The hub validates the envelope with
 *   isSwivelMessage() and treats field values as data only.
 * - The Gemini API key (Phase 3) is read from chrome.storage.local ONLY
 *   inside this worker, used ONLY in a fetch() from this worker, and is
 *   not a field on any SwivelMessage — so it structurally cannot be
 *   routed to a tab (Charter Law 2).
 */

import {
  INITIAL_WORKFLOW_STATE,
  isExtractedContext,
  isSwivelMessage,
  type ExtractErrorCode,
  type RunStepRecord,
  type SwivelMessage,
  type SwivelPayload,
  type WorkflowState,
} from "../shared/messages";
import { cleanEmailText } from "../shared/cleanText";
import { synthesize, testApiKey } from "./gemini";
import { DEFAULT_MODEL } from "../shared/config";
import { swivelPayloadSchema, toSwivelPayload } from "../shared/payload";
import { findRecipe, type TargetRecipe } from "../shared/recipes";
import { matchesAnyPattern } from "../shared/urlMatch";
import type { TargetCandidate } from "../shared/messages";

// ---------------------------------------------------------------------------
// Side panel behavior
// ---------------------------------------------------------------------------

// Top-level (not inside onInstalled): this runs on every worker wake, which
// is exactly what we want — setPanelBehavior is cheap and idempotent, and
// relying on onInstalled alone would lose the setting if Chrome ever
// restarts the worker without a reinstall.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[hub] setPanelBehavior failed:", err));

// Allow content scripts (the target executor) to read/write storage.session
// for the run-idempotency record. "Untrusted" here means "a context that
// shares a page" — the page's own JS still cannot touch chrome.storage; only
// our content-script code can. Default is trusted-contexts-only, which would
// make target.ts's storage.session access throw.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((err) => console.error("[hub] setAccessLevel failed:", err));

// ---------------------------------------------------------------------------
// Persistent workflow state (storage.session-backed)
// ---------------------------------------------------------------------------

const STATE_KEY = "swivel:workflowState";

/**
 * In-memory cache of the persisted state. `null` means "not rehydrated
 * yet" — i.e., the worker just woke and hasn't read storage.session. Never
 * read this directly; always go through getState().
 */
let stateCache: WorkflowState | null = null;

/**
 * Statuses whose work lives INSIDE the worker (an in-flight await). If a
 * fresh worker rehydrates one of these from storage, the operation died
 * with the previous worker — the promise is gone, nothing will ever
 * resolve it. Reconciling to a clean error avoids a stuck spinner in the
 * panel and gives the user a retry (Charter: never a stuck spinner).
 *
 * "executing" is deliberately NOT here: that run lives in the target-tab
 * content script, which survives a worker death — Phase 8 handles its
 * continuity via the relay Port. The worker only relays those updates.
 */
const WORKER_TRANSIENT: ReadonlySet<string> = new Set([
  "extracting",
  "synthesizing",
  "routing",
]);

/** Rehydrate-on-wake: storage.session survives worker restarts (it lives
 *  until the browser closes), so this is how a freshly revived worker
 *  recovers mid-flow context instead of starting from scratch. */
async function getState(): Promise<WorkflowState> {
  if (stateCache !== null) return stateCache;
  const stored = await chrome.storage.session.get(STATE_KEY);
  // MERGE over INITIAL rather than casting the stored object (gate run #2,
  // item c). storage.session outlives an extension reload, so a state written
  // by an older build can be missing fields this build requires — and `as
  // WorkflowState` would simply lie about it, handing `undefined` to code
  // typed as `string | null`. The spread guarantees every field exists.
  const persisted = stored[STATE_KEY] as Partial<WorkflowState> | undefined;
  let state: WorkflowState = { ...INITIAL_WORKFLOW_STATE, ...(persisted ?? {}) };
  // This branch runs at most once per worker lifetime (stateCache was
  // null). Reaching it with a worker-transient status means we just woke
  // from a death that orphaned that operation — fail it cleanly.
  if (WORKER_TRANSIENT.has(state.status)) {
    state = { ...state, status: "error", lastError: "INTERRUPTED" };
    await chrome.storage.session.set({ [STATE_KEY]: state });
  }
  stateCache = state;
  return stateCache;
}

/** Every transition persists BEFORE the hub acts on it, so a worker death
 *  immediately after leaves storage consistent with what already happened,
 *  never ahead of it. */
async function setState(patch: Partial<WorkflowState>): Promise<WorkflowState> {
  const current = await getState();
  const next: WorkflowState = { ...current, ...patch };
  stateCache = next;
  await chrome.storage.session.set({ [STATE_KEY]: next });
  return next;
}

// Keep the in-memory cache coherent if STATE_KEY is written out of band. In
// production the hub is the sole writer, so setState already updated
// stateCache and this is a no-op (newValue equals the cache). It matters when
// another context writes the state — notably the e2e harness seeding preset
// state — so the next getState() reflects it instead of a stale cache.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[STATE_KEY];
  if (change && change.newValue !== undefined) {
    stateCache = change.newValue as WorkflowState;
  }
});

/** Idempotent step-log update: replace the row with this stepIndex, or
 *  append it, keeping the log ordered. Same (runId, stepIndex) twice is a
 *  no-op beyond the status change — safe across worker restarts. */
function upsertStep(steps: RunStepRecord[], row: RunStepRecord): RunStepRecord[] {
  const i = steps.findIndex((s) => s.stepIndex === row.stepIndex);
  if (i >= 0) {
    const next = steps.slice();
    next[i] = row;
    return next;
  }
  return [...steps, row].sort((a, b) => a.stepIndex - b.stepIndex);
}

// ---------------------------------------------------------------------------
// Tab routing helper
// ---------------------------------------------------------------------------

/**
 * Send a typed message to a specific tab's content script. This is the
 * ONLY way payload data reaches a destination tab: the hub picks the
 * tabId, so a content script can never redirect the flow to a tab of its
 * choosing. Throws with a readable error if the tab has no listener
 * (common cause: page was loaded before the extension, needs a reload).
 */
async function routeToTab(
  tabId: number,
  message: SwivelMessage
): Promise<SwivelMessage | undefined> {
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, message);
    if (response !== undefined && !isSwivelMessage(response)) {
      throw new Error(`Tab ${tabId} returned a malformed response`);
    }
    return response;
  } catch (err) {
    // chrome.tabs.sendMessage rejects with "Could not establish connection.
    // Receiving end does not exist." when no content script is listening.
    throw new Error(
      `routeToTab(${tabId}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Resolve the active tab in the currently focused window (the tab the
 *  user is looking at next to the side panel). */
async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

/** Find the exact Gmail tab we extracted from. Never fall back to another
 *  Gmail tab: drafting into a different conversation is worse than asking
 *  the user to reopen the source thread. */
async function resolveGmailTab(): Promise<number | null> {
  const { sourceTabId } = await getState();
  if (sourceTabId === null) return null;
  const tab = await chrome.tabs.get(sourceTabId).catch(() => undefined);
  return tab?.url?.startsWith("https://mail.google.com/") ? sourceTabId : null;
}

/** Fire-and-forget message to the side panel. Rejection is EXPECTED when
 *  the panel is closed ("Receiving end does not exist") — swallowed, since
 *  the panel rehydrates from storage.session on its next mount anyway. */
async function broadcastToPanel(message: SwivelMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // panel not open — state is persisted, nothing lost
  }
}

// ---------------------------------------------------------------------------
// Panel Ports (Phase 4 scaffolding for the live run step-log)
// ---------------------------------------------------------------------------

/**
 * Long-lived Ports from open side panels. During a run (Phase 6+), per-step
 * updates are pushed through these Ports for low-latency streaming; the
 * panel reconnects with backoff if the worker dies mid-run, so this set
 * churns as panels connect/disconnect. It is in-memory CACHE only — a
 * worker death drops every Port, and the panel is responsible for
 * reconnecting (Charter Law 1). Nothing durable lives here.
 *
 * NOTE: Phase 4 stands up the transport; no run pushes through it yet
 * (execution is Phase 6/7). broadcastToPorts is wired so Phase 6 only has
 * to call it. The Port name will encode the runId once runs exist
 * (Phase 6/8) — there is no runId to encode yet.
 */
const PORT_NAME = "swivel-panel";
const panelPorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  // Only accept our own panel Ports, and only from this extension. A Port
  // has no sender.tab when it originates from an extension page (the panel).
  if (port.name !== PORT_NAME) return;
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
});

/** Push a message to every connected panel Port (best-effort). Disconnected
 *  Ports throw on postMessage; we prune them rather than crash the run. */
function broadcastToPorts(message: SwivelMessage): void {
  for (const port of panelPorts) {
    try {
      port.postMessage(message);
    } catch {
      panelPorts.delete(port);
    }
  }
}

// ---------------------------------------------------------------------------
// Source extraction (Phase 2)
// ---------------------------------------------------------------------------

/** Pages Chrome will never let us script — fail fast with a specific code
 *  instead of a misleading "click the icon" instruction. */
const BROWSER_INTERNAL_URL =
  /^(chrome|chrome-extension|chrome-search|devtools|edge|about|view-source):/;

const isGmailUrl = (url: string): boolean =>
  url.startsWith("https://mail.google.com/");

/**
 * Extract from `tab`, routing by URL:
 *  - Gmail → gmail.js is already there (manifest-registered): just message it.
 *  - anything else → inject generic.js FIRST via chrome.scripting, then
 *    message it. The injection rides either a declared host permission
 *    (Atlassian/Salesforce) or the activeTab grant minted when the user
 *    invoked Swivel on this tab. If neither exists, executeScript throws —
 *    that IS the NO_ACTIVE_TAB_GRANT case, rendered by the panel as
 *    "Click the Swivel icon on this tab, then extract."
 *
 * Both extractors answer the same EXTRACT_REQUEST → EXTRACT_RESULT
 * contract, so everything after routing is one code path: validate the
 * (untrusted) context, clean it, persist it, notify the panel.
 */
/**
 * In-flight extraction, keyed by tab.
 *
 * REPEAT-EXTRACTION SAFETY (gate run #2). Extraction had no concurrency guard
 * at all, and there are three independent ways to start one: the panel
 * button, the keyboard command (which calls extractFromTab directly, without
 * the panel), and a rapid second click. Concurrent runs interleave their
 * setState calls, so the last writer wins and the persisted state can end up
 * describing a different extraction than the one the panel is told about.
 *
 * Coalescing rather than rejecting is the right shape here: extraction is
 * READ-ONLY on the page (unlike a run, which submits and therefore gets a
 * hard RUN_IN_PROGRESS refusal). A second request for the same tab is
 * harmless and should simply receive the same answer.
 *
 * In-memory only, deliberately: it is a de-dup optimisation for one worker
 * lifetime, never a correctness record. If the worker dies mid-extraction the
 * map dies with it and the next request re-extracts — which is correct, since
 * the orphaned operation will never resolve.
 */
const inFlightExtractions = new Map<number, Promise<WorkflowState>>();

async function extractFromTab(tab: chrome.tabs.Tab): Promise<WorkflowState> {
  const id = tab.id;
  if (id !== undefined) {
    const existing = inFlightExtractions.get(id);
    if (existing) {
      console.log(`[hub] extraction already in flight for tab ${id} — joining it`);
      return existing;
    }
    const run = extractFromTabUncoalesced(tab).finally(() => {
      inFlightExtractions.delete(id);
    });
    inFlightExtractions.set(id, run);
    return run;
  }
  return extractFromTabUncoalesced(tab);
}

async function extractFromTabUncoalesced(tab: chrome.tabs.Tab): Promise<WorkflowState> {
  const fail = async (
    code: ExtractErrorCode | string,
    detail: string | null = null
  ): Promise<WorkflowState> => {
    console.error(`[hub] extraction failed → ${code}${detail ? `: ${detail}` : ""}`);
    const state = await setState({
      status: "error",
      lastError: code,
      lastErrorDetail: detail,
    });
    void broadcastToPanel({ type: "STATE_SNAPSHOT", state });
    return state;
  };

  const tabId = tab.id;
  const url = tab.url ?? "";
  if (tabId === undefined) return fail("EXTRACT_FAILED", "active tab has no id");
  if (BROWSER_INTERNAL_URL.test(url)) return fail("UNSUPPORTED_PAGE", url);

  console.log(`[hub] extracting from tab ${tabId} (${url.slice(0, 80)})`);
  await setState({
    status: "extracting",
    sourceTabId: tabId,
    lastError: null,
    lastErrorDetail: null,
  });

  if (!isGmailUrl(url)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["generic.js"],
      });
    } catch (err) {
      // No host permission and no activeTab grant for this tab (user never
      // invoked Swivel here, or the tab navigated since — navigation
      // revokes the grant).
      return fail("NO_ACTIVE_TAB_GRANT", err instanceof Error ? err.message : String(err));
    }
  }

  let reply: SwivelMessage | undefined;
  try {
    reply = await routeToTab(tabId, { type: "EXTRACT_REQUEST" });
  } catch (firstErr) {
    // NO RECEIVER. On Gmail this is the common "works only after a refresh"
    // case (final-gate defect 1a): gmail.js is manifest-registered, so it
    // only exists in documents that loaded AFTER the extension did. Reloading
    // the extension orphans every content script already on the page — the
    // old context is invalidated and answers nothing.
    //
    // Rather than telling the user to reload the tab, RE-INJECT and retry
    // once. gmail.js is idempotent (module scope only registers a listener),
    // and mail.google.com is an install-time host permission, so this needs
    // no new grant.
    console.warn(
      `[hub] no receiver on tab ${tabId} — re-injecting and retrying once:`,
      firstErr instanceof Error ? firstErr.message : firstErr
    );
    const script = isGmailUrl(url) ? "gmail.js" : "generic.js";
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [script] });
    } catch (injectErr) {
      const detail = injectErr instanceof Error ? injectErr.message : String(injectErr);
      // Injection into a host we DO hold a permission for, refused: the
      // classic symptom of site access being switched off for that origin.
      if (isGmailUrl(url)) {
        return fail("GMAIL_SITE_ACCESS_BLOCKED", detail);
      }
      return fail("NO_ACTIVE_TAB_GRANT", detail);
    }
    try {
      reply = await routeToTab(tabId, { type: "EXTRACT_REQUEST" });
      console.log(`[hub] re-injection recovered tab ${tabId}`);
    } catch (secondErr) {
      return fail(
        "EXTRACT_NO_RECEIVER",
        secondErr instanceof Error ? secondErr.message : String(secondErr)
      );
    }
  }

  if (reply?.type === "EXTRACT_RESULT" && reply.ok && isExtractedContext(reply.context)) {
    const extracted = {
      ...reply.context,
      bodyText: cleanEmailText(reply.context.bodyText),
    };
    const state = await setState({
      status: "source_ready",
      extracted,
      lastError: null,
      lastErrorDetail: null,
    });
    console.log(
      `[hub] extraction ok — subject="${(extracted.subject ?? "").slice(0, 60)}", ` +
        `${extracted.bodyText.length} chars of body`
    );
    void broadcastToPanel({ type: "PAYLOAD_SOURCE_READY", extracted });
    void broadcastToPanel({ type: "STATE_SNAPSHOT", state });
    return state;
  }

  const code =
    reply?.type === "EXTRACT_RESULT" && reply.errorCode
      ? (reply.errorCode as ExtractErrorCode)
      : "EXTRACT_FAILED";
  return fail(code, `content script replied: ${JSON.stringify(reply ?? null).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Keyboard command (Phase 2)
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "swivel-extract") return;
  // A keyboard command counts as "invoking the extension", which gives us
  // both things this handler needs: (a) the user-gesture context that
  // chrome.sidePanel.open() demands, and (b) an activeTab grant on `tab`,
  // which is what lets the generic extractor inject into hosts we hold no
  // host_permissions for. sidePanel.open is called BEFORE any await —
  // gesture context does not survive across the microtask boundary.
  if (tab?.windowId !== undefined) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err) => console.error("[hub] sidePanel.open failed:", err));
  }
  void (async () => {
    const target = tab ?? (await getActiveTab());
    await extractFromTab(target);
  })();
});

// ---------------------------------------------------------------------------
// Settings (chrome.storage.local) — the API key lives here, NOWHERE else
// ---------------------------------------------------------------------------

/**
 * THREAT MODEL, stated honestly: chrome.storage.local keeps the key out of
 * web pages and out of the message union — a compromised or malicious page
 * cannot read it, and it never rides a message that could be routed to a
 * tab. It does NOT protect against the user inspecting their own extension
 * (DevTools on the worker, or reading local storage on their own machine).
 * That is acceptable: it is the user's own key on the user's own machine,
 * and there is no server to hide it behind — no-backend is the whole point.
 *
 * The panel's settings UI WRITES this key directly via chrome.storage.local
 * (the side panel is trusted extension UI). The worker READS it here. The
 * key is therefore never a field on any SwivelMessage — structurally
 * unroutable to a page, not merely un-sent (Charter Law 2).
 */
const KEY_API = "swivel:apiKey";
const KEY_MODEL = "swivel:model";

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/*";

/**
 * Is this optional origin granted?
 *
 * IMPORTANT LIMIT (final-gate defect 3): a `true` here does NOT guarantee the
 * request will be allowed. Chrome's runtime host controls let a user leave a
 * permission GRANTED while switching that site's access off in
 * chrome://extensions — permissions.contains still reports true, and the
 * request is blocked anyway. So this pre-flight catches "never granted"
 * cleanly, and the BLOCKED case is caught downstream by classifyFetchFailure
 * (granted + opaque fetch failure ⇒ almost certainly a withheld toggle).
 *
 * I could not verify Chrome's contains() behaviour under a withheld toggle
 * without a real browser, which is exactly why the two-layer approach is used
 * rather than trusting this call alone.
 */
async function hasOrigin(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (err) {
    console.warn(`[hub] permissions.contains(${origin}) threw`, err);
    return false;
  }
}

async function getApiKey(): Promise<string> {
  const stored = await chrome.storage.local.get(KEY_API);
  const key = stored[KEY_API];
  return typeof key === "string" ? key : "";
}

async function getModel(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(KEY_MODEL);
  const model = stored[KEY_MODEL];
  return typeof model === "string" && model.trim() ? model : undefined;
}

// ---------------------------------------------------------------------------
// Synthesis flow (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Run Gemini over the currently-extracted context and persist the result.
 * Every transition is persisted BEFORE the next step, so a worker death at
 * any point leaves a coherent state: "synthesizing" (which getState()
 * reconciles to a clean error on wake) or a terminal ready/error.
 */
async function runSynthesis(): Promise<void> {
  const failWith = async (code: string, detail: string | null): Promise<void> => {
    console.error(`[hub] synthesis failed → ${code}${detail ? `: ${detail}` : ""}`);
    const next = await setState({
      status: "error",
      lastError: code,
      lastErrorDetail: detail,
    });
    void broadcastToPanel({ type: "STATE_SNAPSHOT", state: next });
  };

  // WRAPPED WHOLE (final-gate defect 2): previously an exception anywhere in
  // here rejected the caller's un-awaited async IIFE, so sendResponse never
  // fired, the message channel closed silently, and the panel sat in
  // "synthesizing" forever with nothing in the console. Now every throw
  // becomes a persisted, logged, terminal error state.
  try {
    const state = await getState();
    if (!state.extracted) {
      await failWith("NO_SOURCE", null);
      return;
    }

    await setState({ status: "synthesizing", lastError: null, lastErrorDetail: null });

    const apiKey = await getApiKey();
    if (!apiKey.trim()) {
      await failWith("NO_API_KEY", null);
      return;
    }

    // PERMISSION PRE-FLIGHT (final-gate defect 3). The Gemini origin is
    // optional (permission diet), so it can legitimately be absent — that
    // deserves its own message, not a mystery network error 20s later.
    const originGranted = await hasOrigin(GEMINI_ORIGIN);
    if (!originGranted) {
      await failWith(
        "NO_GEMINI_PERMISSION",
        `chrome.permissions.contains reported ${GEMINI_ORIGIN} is NOT granted`
      );
      return;
    }

    const model = await getModel();
    console.log(`[hub] synthesizing with model=${model ?? DEFAULT_MODEL}`);

    // The key is read here and passed as a call argument — it never enters a
    // message or the workflow state.
    const result = await synthesize(state.extracted, apiKey, { model, originGranted });

    if (result.ok) {
      const payload = toSwivelPayload(result.payload, state.extracted.sourceUrl);
      const next = await setState({
        status: "ready",
        payload,
        lastError: null,
        lastErrorDetail: null,
      });
      console.log("[hub] synthesis ok — payload ready");
      void broadcastToPanel({ type: "PAYLOAD_READY", payload });
      void broadcastToPanel({ type: "STATE_SNAPSHOT", state: next });
    } else {
      await failWith(result.code, result.detail);
    }
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[hub] synthesis threw (this is a bug, not a Gemini failure)", err);
    await failWith("SYNTHESIS_CRASHED", detail);
  }
}

// ---------------------------------------------------------------------------
// Target routing (Phase 5)
// ---------------------------------------------------------------------------

/** Find open tabs whose URL matches any of the recipe's patterns. Queries
 *  all tabs and filters with our own PURE matcher (urlMatch.ts) so the
 *  selection is deterministic and unit-tested, not dependent on
 *  tabs.query's pattern parsing. */
async function findTargetTabs(patterns: readonly string[]): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url !== undefined && matchesAnyPattern(t.url, patterns));
}

/** Bring a tab to the foreground (activate it and focus its window). */
async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Resolve the destination tab for a recipe and hand off.
 *
 * PHASE 5 SCOPE: this fully implements discovery — zero matches
 * (TARGET_NOT_OPEN + open-target affordance), multiple (candidate list to
 * the panel), exactly one (focus it). On a resolved single/chosen tab it
 * persists targetTabId and status "routing" and reports back. The actual
 * step INJECTION is Phase 7 (target.ts); until then the pipeline visibly
 * stops at "routing" with a note — honest, not a silent no-op.
 *
 * Returns the message to reply to the panel's request.
 */
async function routeToTarget(
  recipeId: string,
  dryRun: boolean,
  chosenTabId: number | undefined
): Promise<SwivelMessage> {
  const recipe = findRecipe(recipeId);
  if (!recipe) {
    return {
      type: "AUTOMATION_ERROR",
      runId: null,
      errorCode: "RECIPE_NOT_FOUND",
      detail: `No recipe with id "${recipeId}"`,
    };
  }

  // If the user already picked a tab from a candidate list, validate it
  // still matches (it could have navigated away) and use it directly.
  if (chosenTabId !== undefined) {
    const tab = await chrome.tabs.get(chosenTabId).catch(() => undefined);
    if (!tab?.url || !matchesAnyPattern(tab.url, recipe.urlPatterns)) {
      return {
        type: "AUTOMATION_ERROR",
        runId: null,
        errorCode: "TARGET_NOT_OPEN",
        detail: "The chosen tab is no longer a valid target",
      };
    }
    return dispatchRun(tab, recipe, dryRun);
  }

  const matches = await findTargetTabs(recipe.urlPatterns);

  if (matches.length === 0) {
    return {
      type: "AUTOMATION_ERROR",
      runId: null,
      errorCode: "TARGET_NOT_OPEN",
      detail: `No open ${recipe.label} tab. Open the target and retry.`,
    };
  }

  if (matches.length > 1) {
    const candidates: TargetCandidate[] = matches
      .filter((t) => t.id !== undefined)
      .map((t) => ({ tabId: t.id!, title: t.title ?? "(untitled)", url: t.url ?? "" }));
    return { type: "TARGET_CANDIDATES", recipeId, dryRun, candidates };
  }

  return dispatchRun(matches[0]!, recipe, dryRun);
}

/** Stable run id from the payload content + recipe. Same payload + recipe →
 *  same runId, which is what lets the executor refuse a double-submit. */
function makeRunId(recipeId: string, payload: SwivelPayload): string {
  const json = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  return `${recipeId}:${(h >>> 0).toString(36)}`;
}

/**
 * Focus the resolved tab and hand the run to the target executor (Phase 7).
 * The run itself lives in the content script; the hub only dispatches it and
 * (later) relays its progress. target.js is present via the manifest on
 * atlassian; on other domains (the fixture) it isn't, so a failed
 * sendMessage triggers an on-demand injection, then a retry.
 */
async function dispatchRun(
  tab: chrome.tabs.Tab,
  recipe: TargetRecipe,
  dryRun: boolean
): Promise<SwivelMessage> {
  const tabId = tab.id;
  if (tabId === undefined) {
    return { type: "AUTOMATION_ERROR", runId: null, errorCode: "TARGET_NOT_OPEN", detail: "Target tab has no id" };
  }

  const { payload } = await getState();
  if (!payload) {
    return { type: "AUTOMATION_ERROR", runId: null, errorCode: "NO_PAYLOAD", detail: "No payload to automate — synthesize first" };
  }

  await focusTab(tab);
  const runId = makeRunId(recipe.id, payload);
  const next = await setState({
    status: "executing",
    targetTabId: tabId,
    runId,
    runSteps: [], // fresh run — clear any prior run's persisted log
    // Record the MODE with the run so the panel's executing view states it
    // from hub truth rather than a panel-local flag that a rehydrate loses.
    runDryRun: dryRun,
    lastError: null,
    lastErrorDetail: null,
  });
  void broadcastToPanel({ type: "STATE_SNAPSHOT", state: next });

  const runMessage: SwivelMessage = {
    type: "RUN_RECIPE",
    runId,
    steps: recipe.steps,
    payload,
    dryRun,
  };

  // READINESS HANDSHAKE (Gate 7, defect A-b/c). This used to be "send, and if
  // it throws, inject and send again", with the first rejection swallowed by a
  // bare `catch {}` — so a dispatch that silently went nowhere left no trace
  // at all. Now we PROVE a listener is answering before handing it the run:
  // ping, inject if silent, ping again. Only a live PONG earns the payload.
  try {
    await ensureExecutorReady(tabId);
  } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Could not load the executor into the target tab";
      // WHY the injection was refused matters (final-gate defect 3a). The
      // recipe declares the origin it needs, so we can tell the three cases
      // apart instead of showing one catch-all:
      //   not granted  → enable the recipe in Settings (that requests it)
      //   granted      → almost certainly site access switched off in Chrome
      const required = recipe.requiredOrigin;
      const granted = required ? await hasOrigin(required) : true;
      const errorCode = !required
        ? "TARGET_INJECT_FAILED"
        : granted
          ? "TARGET_ORIGIN_BLOCKED"
          : "TARGET_ORIGIN_NOT_GRANTED";
      console.error(
        `[hub] target injection failed → ${errorCode} (required=${required ?? "none"}, ` +
          `granted=${granted}): ${detail}`
      );
      const s = await setState({
        status: "error",
        lastError: errorCode,
        lastErrorDetail: detail,
      });
    void broadcastToPanel({ type: "STATE_SNAPSHOT", state: s });
    return { type: "AUTOMATION_ERROR", runId, errorCode, detail };
  }

  // The executor answered a ping, so a live listener exists. Hand it the run.
  console.log(`[hub] dispatching run ${runId} to tab ${tabId} (dryRun=${dryRun})`);
  try {
    await chrome.tabs.sendMessage(tabId, runMessage);
  } catch (err) {
    // It answered a ping moments ago, so this is a real anomaly, not the
    // ordinary "not injected yet" case. Never swallow it.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[hub] RUN_RECIPE delivery failed after a successful ping: ${detail}`);
    const s = await setState({
      status: "error",
      lastError: "EXECUTOR_UNREACHABLE",
      lastErrorDetail: detail,
    });
    void broadcastToPanel({ type: "STATE_SNAPSHOT", state: s });
    return { type: "AUTOMATION_ERROR", runId, errorCode: "EXECUTOR_UNREACHABLE", detail };
  }

  startRunWatchdog(runId, tabId);

  // The run streams AUTOMATION_STEP_UPDATE / DONE / ERROR back to the hub,
  // which relays them. Reply to the panel with the executing snapshot.
  return { type: "STATE_SNAPSHOT", state: next };
}

/**
 * Prove a live executor listener exists in `tabId`, injecting if needed.
 *
 * WHY A HANDSHAKE AND NOT "just inject" (Gate 7): chrome.scripting
 * .executeScript resolving tells you the FILE ran, not that a listener is
 * attached and reachable — and until this gate, target.js could run and
 * deliberately attach nothing (its `__swivelTargetLoaded` guard). A tab could
 * therefore be injected, report success, and answer nothing. A PONG is the
 * only evidence that actually means "ready".
 *
 * Throws with a readable message if the tab never answers.
 */
async function ensureExecutorReady(tabId: number): Promise<void> {
  const ping: SwivelMessage = { type: "PING", hops: ["hub:ready-check"] };

  const answered = async (): Promise<boolean> => {
    try {
      const reply: unknown = await chrome.tabs.sendMessage(tabId, ping);
      return isSwivelMessage(reply) && reply.type === "PONG";
    } catch {
      return false;
    }
  };

  if (await answered()) {
    console.log(`[hub] executor already live in tab ${tabId}`);
    return;
  }

  console.log(`[hub] no executor in tab ${tabId} — injecting target.js`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["target.js"] });

  if (await answered()) {
    console.log(`[hub] executor ready in tab ${tabId} after injection`);
    return;
  }
  throw new Error(
    `target.js was injected into tab ${tabId} but no listener answered a ping`
  );
}

/**
 * RUN WATCHDOG (Gate 7, defect A-d). Nothing in this system may hang forever.
 *
 * A dispatched run that reports NO first step is the failure this gate hit:
 * the panel sat at "Waiting for the first step…" in phase "executing" with no
 * step, no error, no timeout. The executor is remote (a content script in a
 * page we do not control) so the hub cannot know it died — it can only know
 * that nothing arrived.
 *
 * If no step update has been recorded within FIRST_STEP_TIMEOUT_MS, fail the
 * run with a typed error that NAMES the likely cause. In-memory timer, which
 * is right for the common case; a worker death is covered separately by the
 * wake reconciliation in getState().
 */
const FIRST_STEP_TIMEOUT_MS = 20_000;
let runWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearRunWatchdog(): void {
  if (runWatchdog !== null) {
    clearTimeout(runWatchdog);
    runWatchdog = null;
  }
}

function startRunWatchdog(runId: string, tabId: number): void {
  clearRunWatchdog();
  runWatchdog = setTimeout(() => {
    void (async () => {
      const state = await getState();
      // Only fire if THIS run is still live and has reported nothing at all.
      if (state.status !== "executing" || state.runId !== runId) return;
      if (state.runSteps.length > 0) return;

      const detail =
        `No step was reported within ${FIRST_STEP_TIMEOUT_MS / 1000}s of dispatching run ` +
        `${runId} to tab ${tabId}. The executor received the run but never reported, or the ` +
        `message was never delivered to a live listener.`;
      console.error(`[hub] WATCHDOG → EXECUTOR_SILENT: ${detail}`);
      await abortRun(runId, tabId, "EXECUTOR_SILENT", detail);
    })();
  }, FIRST_STEP_TIMEOUT_MS);
}

/**
 * Abort the active run with a typed reason. Tells the executor to stop
 * (best-effort — it may already be gone if the page navigated), then records
 * the terminal error and pushes it to the panel over the Port. Because the
 * relay handler is terminal-first-wins, the executor's own late ABORTED
 * report is dropped and does not overwrite this reason.
 */
async function abortRun(
  runId: string,
  targetTabId: number | null,
  code: string,
  detail: string
): Promise<void> {
  if (targetTabId !== null) {
    const abort: SwivelMessage = { type: "ABORT_RUN", runId };
    chrome.tabs.sendMessage(targetTabId, abort).catch(() => {});
  }
  await setState({ status: "error", lastError: code });
  broadcastToPorts({ type: "AUTOMATION_ERROR", runId, errorCode: code, detail });
}

// ---------------------------------------------------------------------------
// SPA client-side navigation guard (Phase 8)
// ---------------------------------------------------------------------------

// Modern SPAs route via history.pushState without a full load. If the TARGET
// tab does that mid-run, the DOM the recipe was operating on is gone —
// continuing would fill a phantom page. Abort cleanly instead.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // top frame only
  void (async () => {
    const state = await getState();
    if (
      state.status === "executing" &&
      state.runId !== null &&
      details.tabId === state.targetTabId
    ) {
      console.warn(`[hub] target tab ${details.tabId} navigated mid-run → aborting`);
      await abortRun(
        state.runId,
        state.targetTabId,
        "NAVIGATION_INTERRUPTED",
        "The target page navigated (client-side routing) during the run."
      );
    }
  })();
});

// ---------------------------------------------------------------------------
// The message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: SwivelMessage) => void
  ): boolean | undefined => {
    // --- Gate 1: sender must be this extension. ---------------------------
    if (sender.id !== chrome.runtime.id) {
      console.warn("[hub] Dropped message from foreign sender:", sender.id);
      return undefined;
    }

    // --- Gate 2: envelope must be a known SwivelMessage. ------------------
    if (!isSwivelMessage(message)) {
      console.warn("[hub] Dropped malformed message:", message);
      return undefined;
    }

    // WHO is talking? Panel-only actions (extract, synthesize, edit,
    // automate) must originate from OUR OWN extension UI, never from a
    // content script running in an untrusted page. The precise discriminator
    // is the sender's URL: our extension pages report
    // chrome-extension://<our-id>/…, whereas a content script reports the
    // http(s) page URL. This is stricter and more correct than "has no tab":
    // it explicitly trusts our UI (the side panel — whether docked, which
    // has no tab, or opened as a tab under the e2e harness) and explicitly
    // distrusts page content scripts.
    const fromTab = sender.tab?.id;
    const fromExtensionPage =
      typeof sender.url === "string" &&
      sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
    console.log(
      `[hub] ${message.type} from ${
        fromExtensionPage ? "extension UI" : fromTab !== undefined ? `tab ${fromTab}` : "unknown"
      }`
    );

    switch (message.type) {
      // -- Phase 1 gate: panel → hub → active tab content script → back. --
      case "PING": {
        (async () => {
          const hops = [...message.hops, "hub"];
          try {
            const tab = await getActiveTab();
            const reply = await routeToTab(tab.id!, { type: "PING", hops });
            if (reply?.type === "PONG") {
              sendResponse({ type: "PONG", hops: [...reply.hops, "hub(return)"] });
            } else {
              sendResponse({
                type: "AUTOMATION_ERROR",
                runId: null,
                errorCode: "PING_NO_PONG",
                detail: "Content script replied, but not with a PONG",
              });
            }
          } catch (err) {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: null,
              errorCode: "PING_FAILED",
              detail:
                err instanceof Error
                  ? err.message
                  : "Unknown error — is the active tab a Swivel-matched domain?",
            });
          }
        })();
        // THE MV3 PITFALL: onMessage listeners are synchronous. Returning
        // `true` tells Chrome "sendResponse will be called later — keep the
        // message channel open." Without it, the channel closes the moment
        // this function returns, and every await above would respond into
        // the void ("The message port closed before a response was
        // received"). Returning true also pins the worker alive until we
        // respond or time out.
        return true;
      }

      // -- Panel opened: hand it the persisted state to render from. ------
      case "GET_STATE": {
        (async () => {
          const state = await getState();
          sendResponse({ type: "STATE_SNAPSHOT", state });
        })();
        return true;
      }

      // -- Panel button: extract from whatever tab the user is looking at. --
      case "EXTRACT_REQUEST": {
        // Origin gate: extraction is a user-facing panel action. Only our
        // own extension UI may trigger it; a content script in a page is
        // dropped (see fromExtensionPage above).
        if (!fromExtensionPage) {
          console.warn("[hub] EXTRACT_REQUEST from a non-UI sender rejected");
          return undefined;
        }
        (async () => {
          try {
            const tab = await getActiveTab();
            const state = await extractFromTab(tab);
            sendResponse({ type: "STATE_SNAPSHOT", state });
          } catch (err) {
            const state = await setState({
              status: "error",
              lastError: err instanceof Error ? err.message : "EXTRACT_FAILED",
            });
            sendResponse({ type: "STATE_SNAPSHOT", state });
          }
        })();
        return true;
      }

      // -- Panel: synthesize the extracted context into a payload. --------
      case "SYNTHESIZE": {
        // Panel-only action; a content script (page-influenced) must not be
        // able to trigger an LLM call on our key.
        if (!fromExtensionPage) {
          console.warn("[hub] SYNTHESIZE from a non-UI sender rejected");
          return undefined;
        }
        // runSynthesis persists every transition and broadcasts PAYLOAD_READY
        // / STATE_SNAPSHOT itself, so the panel stays correct even if it was
        // closed during the call. We still reply with the final snapshot for
        // the request/response path when the panel is open.
        (async () => {
          // runSynthesis never throws (it wraps itself), but this belt-and-
          // braces catch guarantees the channel is ALWAYS answered: an
          // unanswered sendResponse is what strands the panel in a pending
          // state with no error (final-gate defect 2e).
          try {
            await runSynthesis();
          } catch (err) {
            console.error("[hub] SYNTHESIZE handler threw", err);
            await setState({
              status: "error",
              lastError: "SYNTHESIS_CRASHED",
              lastErrorDetail: err instanceof Error ? err.message : String(err),
            });
          }
          const state = await getState();
          sendResponse({ type: "STATE_SNAPSHOT", state });
        })();
        return true;
      }

      // -- Panel (Settings): probe the key with ONE minimal live call. ----
      case "TEST_KEY_REQUEST": {
        if (!fromExtensionPage) return undefined;
        (async () => {
          const model = (await getModel()) ?? DEFAULT_MODEL;
          try {
            const apiKey = await getApiKey();
            const originGranted = await hasOrigin(GEMINI_ORIGIN);
            if (!originGranted) {
              console.warn("[hub] key probe skipped — Gemini origin not granted");
              sendResponse({
                type: "TEST_KEY_RESULT",
                ok: false,
                errorCode: "NO_GEMINI_PERMISSION",
                detail: `${GEMINI_ORIGIN} is not granted`,
                model,
              });
              return;
            }
            const result = await testApiKey(apiKey, { model, originGranted });
            sendResponse(
              result.ok
                ? { type: "TEST_KEY_RESULT", ok: true, errorCode: null, detail: null, model: result.model }
                : {
                    type: "TEST_KEY_RESULT",
                    ok: false,
                    errorCode: result.code,
                    detail: result.detail,
                    model: result.model,
                  }
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error("[hub] TEST_KEY_REQUEST threw", err);
            sendResponse({
              type: "TEST_KEY_RESULT",
              ok: false,
              errorCode: "SYNTHESIS_CRASHED",
              detail,
              model,
            });
          }
        })();
        return true;
      }

      // -- Panel: persist an edited payload from the review form. ---------
      case "PAYLOAD_EDIT": {
        if (!fromExtensionPage) {
          console.warn("[hub] PAYLOAD_EDIT from a non-UI sender rejected");
          return undefined;
        }
        (async () => {
          // The edit comes from our own panel, but still crosses a trust
          // boundary — re-validate before persisting (Charter: validate
          // everything that crosses a boundary).
          const parsed = swivelPayloadSchema.safeParse(message.payload);
          if (!parsed.success) {
            const state = await getState();
            sendResponse({ type: "STATE_SNAPSHOT", state });
            return;
          }
          const state = await setState({ payload: parsed.data });
          sendResponse({ type: "STATE_SNAPSHOT", state });
        })();
        return true;
      }

      // -- Panel: resolve and focus the destination tab. ------------------
      case "AUTOMATE_TO_TARGET": {
        if (!fromExtensionPage) {
          console.warn("[hub] AUTOMATE_TO_TARGET from a non-UI sender rejected");
          return undefined;
        }
        (async () => {
          // Single-run guard: reject a second automate while a run is live,
          // BEFORE any content-script involvement (Phase 8). This is what
          // makes a double-click produce exactly one run.
          const state = await getState();
          if (state.status === "executing") {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: state.runId,
              errorCode: "RUN_IN_PROGRESS",
              detail: "A run is already in progress — wait for it to finish.",
            });
            return;
          }
          const reply = await routeToTarget(message.recipeId, message.dryRun, message.tabId);
          sendResponse(reply);
        })();
        return true;
      }

      // -- Panel: open the recipe's canonical URL when no target is open. --
      case "OPEN_TARGET": {
        if (!fromExtensionPage) return undefined;
        (async () => {
          const recipe = findRecipe(message.recipeId);
          if (!recipe) {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: null,
              errorCode: "RECIPE_NOT_FOUND",
              detail: `No recipe with id "${message.recipeId}"`,
            });
            return;
          }
          const tab = await chrome.tabs.create({ url: recipe.canonicalUrl });
          const state = await getState();
          console.log(`[hub] Opened target tab ${tab.id} → ${recipe.canonicalUrl}`);
          sendResponse({ type: "STATE_SNAPSHOT", state });
        })();
        return true;
      }

      // -- Panel: draft a reply on the source Gmail thread (loop closure). -
      case "DRAFT_REPLY": {
        if (!fromExtensionPage) return undefined;
        (async () => {
          const gmailTab = await resolveGmailTab();
          if (gmailTab === null) {
            sendResponse({ type: "DRAFT_REPLY_DONE", ok: false, errorCode: "NO_GMAIL_TAB" });
            return;
          }
          try {
            // Forward the same DRAFT_REPLY to gmail.ts and relay its result.
            const result = await routeToTab(gmailTab, message);
            if (result?.type === "DRAFT_REPLY_DONE") sendResponse(result);
            else sendResponse({ type: "DRAFT_REPLY_DONE", ok: false, errorCode: "DRAFT_FAILED" });
          } catch {
            // gmail.js not present (tab predates install) — surface cleanly.
            sendResponse({ type: "DRAFT_REPLY_DONE", ok: false, errorCode: "REPLY_NO_RECEIVER" });
          }
        })();
        return true;
      }

      // -- Panel: reset the workflow, preserving settings (storage.local). -
      case "START_OVER": {
        if (!fromExtensionPage) return undefined;
        (async () => {
          const state = await setState({ ...INITIAL_WORKFLOW_STATE });
          sendResponse({ type: "STATE_SNAPSHOT", state });
        })();
        return true;
      }

      // -- Panel: recipe-staleness check — resolve a recipe's selectors on
      //    the open target without acting (Phase 10). -----------------------
      case "TEST_SELECTORS_REQUEST": {
        if (!fromExtensionPage) return undefined;
        (async () => {
          const recipe = findRecipe(message.recipeId);
          if (!recipe) {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: null,
              errorCode: "RECIPE_NOT_FOUND",
              detail: `No recipe with id "${message.recipeId}"`,
            });
            return;
          }
          let tab: chrome.tabs.Tab | undefined;
          if (message.tabId !== undefined) {
            const chosen = await chrome.tabs.get(message.tabId).catch(() => undefined);
            if (chosen?.url && matchesAnyPattern(chosen.url, recipe.urlPatterns)) {
              tab = chosen;
            } else {
              sendResponse({
                type: "AUTOMATION_ERROR",
                runId: null,
                errorCode: "TARGET_NOT_OPEN",
                detail: "The selected tab is no longer a valid target.",
              });
              return;
            }
          } else {
            const matches = await findTargetTabs(recipe.urlPatterns);
            if (matches.length > 1) {
              const candidates: TargetCandidate[] = matches
                .filter((t) => t.id !== undefined)
                .map((t) => ({
                  tabId: t.id!,
                  title: t.title ?? "(untitled)",
                  url: t.url ?? "",
                }));
              sendResponse({
                type: "TARGET_CANDIDATES",
                recipeId: message.recipeId,
                dryRun: false,
                candidates,
              });
              return;
            }
            tab = matches[0];
          }
          if (!tab?.id) {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: null,
              errorCode: "TARGET_NOT_OPEN",
              detail: `Open a ${recipe.label} tab to test its selectors.`,
            });
            return;
          }
          // Collect every selector the recipe uses.
          const selectors: string[] = [];
          for (const step of recipe.steps) {
            if ("selector" in step) selectors.push(step.selector);
            if ("triggerSelector" in step) selectors.push(step.triggerSelector);
          }
          const probe: SwivelMessage = { type: "TEST_SELECTORS", selectors };
          try {
            let result: SwivelMessage | undefined;
            try {
              result = await routeToTab(tab.id, probe);
            } catch {
              // target.js not present — inject on demand, then retry.
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["target.js"] });
              result = await routeToTab(tab.id, probe);
            }
            sendResponse(
              result?.type === "TEST_SELECTORS_RESULT"
                ? result
                : { type: "TEST_SELECTORS_RESULT", results: [] }
            );
          } catch {
            sendResponse({
              type: "AUTOMATION_ERROR",
              runId: null,
              errorCode: "TARGET_INJECT_FAILED",
              detail: "Couldn't load the checker into the target tab.",
            });
          }
        })();
        return true;
      }

      // -- Run events FROM the target executor → relay to the panel. -------
      // Stream over the Port (the panel's live run log). STEP updates are
      // ALSO accumulated into the persisted runSteps (idempotent by
      // stepIndex) so the log survives a worker death / panel reload. DONE
      // and ERROR are TERMINAL-FIRST-WINS: once the run leaves "executing"
      // the first terminal event has settled it, so later ones (e.g. the
      // executor's ABORTED after a navigation abort) are dropped and can't
      // overwrite the real reason. We do NOT broadcast a STATE_SNAPSHOT for
      // run events — a SYNC(done) could beat the Port RUN_DONE and make the
      // reducer reject it (it requires phase "executing"), dropping readBack.
      case "AUTOMATION_STEP_UPDATE":
      case "AUTOMATION_DONE":
      case "AUTOMATION_ERROR": {
        (async () => {
          // Must come from a content script (a tab), be our target tab, and
          // be for the CURRENT run. Otherwise it's stale or spoofed — drop.
          //
          // EVERY DROP IS LOGGED (Gate 7). These three guards are correct, but
          // they were silent: a run whose events were all dropped here looked
          // EXACTLY like an executor that never ran — the panel sat in
          // "executing" forever with nothing to show. A dropped event is a
          // diagnosis, so it has to leave a trace.
          if (fromTab === undefined) {
            console.warn(`[hub] DROP ${message.type}: not from a tab`);
            return;
          }
          const state = await getState();
          if (fromTab !== state.targetTabId) {
            console.warn(
              `[hub] DROP ${message.type}: from tab ${fromTab} but targetTabId is ${state.targetTabId}`
            );
            return;
          }
          if (message.runId !== null && state.runId !== null && message.runId !== state.runId) {
            console.warn(
              `[hub] DROP ${message.type}: runId "${message.runId}" != active "${state.runId}"`
            );
            return;
          }

          // A real event arrived — the executor is alive, so stand the
          // watchdog down.
          clearRunWatchdog();

          // PERSIST only from "executing" (terminal-first-wins): once the run
          // has settled, a later event — e.g. the executor's ABORTED after a
          // navigation abort — must not overwrite the recorded reason. But we
          // ALWAYS relay to the panel; its reducer dedups on its own side
          // (RUN_DONE/RUN_ERROR require phase "executing").
          if (state.status === "executing") {
            if (message.type === "AUTOMATION_STEP_UPDATE") {
              const runSteps = upsertStep(state.runSteps, {
                stepIndex: message.stepIndex,
                status: message.status,
                detail: message.detail,
              });
              await setState({ runSteps });
            } else if (message.type === "AUTOMATION_DONE") {
              await setState({ status: "done" });
            } else {
              await setState({ status: "error", lastError: message.errorCode });
            }
          }
          broadcastToPorts(message);
        })();
        return undefined;
      }

      // -- Outbound-only types: hub → panel/content, never sent TO the hub.
      //    If one arrives here it's stray; log and drop. -------------------
      case "EXTRACT_RESULT":
      case "PAYLOAD_READY":
      case "PAYLOAD_SOURCE_READY":
      case "TARGET_CANDIDATES":
      case "RUN_RECIPE":
      case "ABORT_RUN":
      case "DRAFT_REPLY_DONE":
      case "TEST_SELECTORS":
      case "TEST_SELECTORS_RESULT":
      case "PONG":
      case "STATE_SNAPSHOT":
        console.log("[hub] No handler yet for", message.type);
        return undefined;
    }
  }
);

console.log("[hub] Swivel service worker loaded");
