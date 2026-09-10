/**
 * src/sidepanel/App.tsx — Phase 4 side panel control center.
 *
 * The panel is a DUMB VIEW of hub state. All workflow state lives in the
 * pure reducer (panelMachine.ts); this component only (a) renders the
 * current phase, (b) turns user actions into hub messages, and (c) feeds
 * hub broadcasts / Port events back into the reducer. No business logic
 * here (Charter Law 3).
 *
 * Three input channels, all funneled through the reducer:
 *   - GET_STATE on mount → REHYDRATE (unconditional load from storage)
 *   - runtime STATE_SNAPSHOT broadcasts → SYNC (transition-guarded)
 *   - Port step stream during a run → STEP / RUN_DONE / RUN_ERROR
 */

import { useEffect, useReducer, useRef, useState } from "react";
import {
  isSwivelMessage,
  type SwivelMessage,
  type SwivelPayload,
} from "../shared/messages";
import { RECIPE_SUMMARIES, type RecipeSummary } from "../shared/recipes";
import type { TargetCandidate } from "../shared/messages";
import { helpFor } from "../shared/errors";
import { getEnabledRecipes } from "./settingsStore";
import {
  initialPanelState,
  panelReducer,
  describeRunOutcome,
  willAcceptSync,
  type PanelAction,
  type PanelState,
} from "./panelMachine";
import { usePort } from "./usePort";
import { Settings } from "./Settings";
import { getApiKeyStatus } from "./settingsStore";

async function sendToHub(message: SwivelMessage): Promise<SwivelMessage | undefined> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  return isSwivelMessage(response) ? response : undefined;
}

/** Map an incoming hub/Port message to a reducer action (or null to ignore). */
function messageToAction(msg: SwivelMessage): PanelAction | null {
  switch (msg.type) {
    case "STATE_SNAPSHOT":
      return { type: "SYNC", state: msg.state };
    case "AUTOMATION_STEP_UPDATE":
      return {
        type: "STEP",
        runId: msg.runId,
        stepIndex: msg.stepIndex,
        status: msg.status,
        detail: msg.detail,
      };
    case "AUTOMATION_DONE":
      return {
        type: "RUN_DONE",
        runId: msg.runId,
        readBack: msg.readBack,
        // `outcome` is absent if an OLD target.js is still resident in the
        // page (the injection guard makes a stale executor stick). Null is
        // handled explicitly by describeRunOutcome — it never assumes success.
        outcome: msg.outcome ?? null,
      };
    case "AUTOMATION_ERROR":
      return {
        type: "RUN_ERROR",
        runId: msg.runId,
        errorCode: msg.errorCode,
        detail: msg.detail,
      };
    default:
      return null;
  }
}

export function App() {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const [showSettings, setShowSettings] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; kind: "info" | "ok" | "error" } | null>(
    null
  );
  // Routing UI: a candidate list to pick from, and the recipe to offer an
  // "open target" affordance for when nothing matched.
  const [candidates, setCandidates] = useState<{
    recipeId: string;
    dryRun: boolean;
    list: TargetCandidate[];
  } | null>(null);
  const [targetNotOpen, setTargetNotOpen] = useState<string | null>(null);
  const [replyDrafted, setReplyDrafted] = useState(false);
  const [enabledRecipes, setEnabledRecipes] = useState<RecipeSummary[]>([]);

  const refreshKeyStatus = () => void getApiKeyStatus().then((s) => setHasKey(s.set));
  const refreshEnabled = () =>
    void getEnabledRecipes().then((ids) =>
      setEnabledRecipes(RECIPE_SUMMARIES.filter((r) => ids.includes(r.id)))
    );

  // Mount: read key presence + enabled recipes (direct storage.local — never
  // a message) and rehydrate the machine from persisted hub state.
  useEffect(() => {
    refreshKeyStatus();
    refreshEnabled();
    void (async () => {
      const reply = await sendToHub({ type: "GET_STATE" });
      if (reply?.type === "STATE_SNAPSHOT") dispatch({ type: "REHYDRATE", state: reply.state });
    })();
  }, []);

  // TWO CHANNELS, deliberately separated to avoid a done/readBack race:
  //  - runtime broadcasts carry STATE_SNAPSHOT (workflow transitions) → SYNC
  //  - the Port carries live run events (STEP / DONE / ERROR)
  // The hub never broadcasts a terminal STATE_SNAPSHOT for a run, so the
  // Port's RUN_DONE always lands while the panel is still in "executing".
  useEffect(() => {
    const handler = (msg: unknown): undefined => {
      if (!isSwivelMessage(msg)) return undefined;
      const action = messageToAction(msg);
      if (action?.type === "SYNC") dispatch(action);
      return undefined;
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  usePort((msg) => {
    const action = messageToAction(msg);
    if (action && action.type !== "SYNC") dispatch(action);
  });

  const runExtract = async () => {
    setBusy(true);
    setNote({ text: "Extracting…", kind: "info" });
    try {
      const reply = await sendToHub({ type: "EXTRACT_REQUEST" });
      if (reply?.type === "STATE_SNAPSHOT") {
        // ONE SOURCE OF TRUTH (gate run #2, item d). The old code set
        // "Source captured ✓" from the HUB's status while the phase came
        // from the reducer, so a dropped SYNC produced a success tick over
        // an empty panel. Now: success is not a note at all — it is the
        // captured-source view rendering, which can only happen if the
        // transition was actually applied. The note is reserved for
        // failures and in-progress states.
        const accepted = willAcceptSync(state.phase, reply.state);
        dispatch({ type: "SYNC", state: reply.state });

        if (reply.state.status === "source_ready") {
          if (accepted) {
            setNote(null); // the rendered source IS the confirmation
          } else {
            // Extraction worked but the panel refused the transition. That
            // is a panel bug, and it must never look like success.
            console.error(
              `[panel] SYNC(source_ready) REJECTED from phase "${state.phase}" — ` +
                `extraction succeeded but the UI cannot show it.`
            );
            setNote({ text: helpFor("PANEL_SYNC_REJECTED"), kind: "error" });
          }
        } else {
          setNote({ text: helpFor(reply.state.lastError), kind: "error" });
        }
      } else {
        // NO ANSWER from the hub. Previously this fell through silently and
        // the UI just stopped — the exact "logs one line then nothing"
        // symptom from the gate. An unanswered channel is itself a fault.
        console.error("[panel] EXTRACT_REQUEST got no usable reply:", reply);
        setNote({ text: helpFor("HUB_NO_RESPONSE"), kind: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const runSynthesize = async () => {
    setBusy(true);
    setNote({ text: "Synthesizing with Gemini…", kind: "info" });
    try {
      const reply = await sendToHub({ type: "SYNTHESIZE" });
      if (reply?.type === "STATE_SNAPSHOT") {
        // Same one-source-of-truth rule as runExtract: the review form
        // rendering IS the confirmation. "Payload ready ✓" was computed from
        // the HUB's status while the form mounts on the reducer's phase —
        // the identical parallel-truth pattern, and it produced the identical
        // green tick over an empty panel.
        const accepted = willAcceptSync(state.phase, reply.state);
        dispatch({ type: "SYNC", state: reply.state });

        if (reply.state.status === "ready") {
          if (accepted) {
            setNote(null);
          } else {
            console.error(
              `[panel] SYNC(ready) REJECTED from phase "${state.phase}" — ` +
                `synthesis succeeded but the review form cannot mount.`
            );
            setNote({ text: helpFor("PANEL_SYNC_REJECTED"), kind: "error" });
          }
        } else {
          setNote({ text: helpFor(reply.state.lastError), kind: "error" });
        }
      } else {
        // Same guarantee as extract: never leave the panel pending with no
        // explanation. Also force the reducer out of "synthesizing" so the
        // UI can't sit on a spinner forever (defect 2e).
        console.error("[panel] SYNTHESIZE got no usable reply:", reply);
        const snapshot = await sendToHub({ type: "GET_STATE" });
        if (snapshot?.type === "STATE_SNAPSHOT") {
          dispatch({ type: "SYNC", state: snapshot.state });
        }
        setNote({ text: helpFor("HUB_NO_RESPONSE"), kind: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const persistEdit = async (payload: SwivelPayload) => {
    const reply = await sendToHub({ type: "PAYLOAD_EDIT", payload });
    if (reply?.type === "STATE_SNAPSHOT") dispatch({ type: "SYNC", state: reply.state });
  };

  const automate = async (recipeId: string, dryRun: boolean, tabId?: number) => {
    setBusy(true);
    setCandidates(null);
    setTargetNotOpen(null);
    try {
      const reply = await sendToHub({
        type: "AUTOMATE_TO_TARGET",
        recipeId,
        dryRun,
        ...(tabId !== undefined ? { tabId } : {}),
      });
      if (reply?.type === "TARGET_CANDIDATES") {
        setCandidates({ recipeId: reply.recipeId, dryRun: reply.dryRun, list: reply.candidates });
      } else if (reply?.type === "STATE_SNAPSHOT") {
        // Run started — the hub focused the target and dispatched the recipe.
        // Move to the executing view; step events now stream over the Port.
        // Same rule again: only claim the run started if the run view can
        // actually mount, otherwise the step log streams into a dropped phase.
        const accepted = willAcceptSync(state.phase, reply.state);
        dispatch({ type: "SYNC", state: reply.state });
        if (accepted) {
          // NO "started" note (Gate 6, item d). This await can resolve AFTER
          // the run has already finished: the hub broadcasts executing and
          // dispatches to the content script, which can complete a dry run in
          // milliseconds and fire RUN_DONE over the Port before this promise
          // settles. Writing "Dry run started…" here then stamped stale text
          // underneath a finished run — state from two different moments on
          // screen at once. The executing view already announces the run, and
          // the done view announces the outcome; neither can be stale.
          setNote(null);
        } else {
          console.error(
            `[panel] SYNC(${reply.state.status}) REJECTED from phase "${state.phase}" — ` +
              `the run was dispatched but the run view cannot mount.`
          );
          setNote({ text: helpFor("PANEL_SYNC_REJECTED"), kind: "error" });
        }
      } else if (reply?.type === "AUTOMATION_ERROR") {
        if (reply.errorCode === "TARGET_NOT_OPEN") setTargetNotOpen(recipeId);
        setNote({ text: helpFor(reply.errorCode), kind: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const openTarget = async (recipeId: string) => {
    await sendToHub({ type: "OPEN_TARGET", recipeId });
    setTargetNotOpen(null);
    setNote({
      text: "Opened the target in a new tab — switch to it, then Automate again.",
      kind: "info",
    });
  };

  const draftReply = async (issueKey: string, issueUrl: string) => {
    setBusy(true);
    setNote({ text: "Drafting reply in Gmail…", kind: "info" });
    try {
      const template = `Thanks — I've logged this as ${issueKey}: ${issueUrl}`;
      const reply = await sendToHub({ type: "DRAFT_REPLY", issueKey, issueUrl, template });
      if (reply?.type === "DRAFT_REPLY_DONE" && reply.ok) {
        // No success note: the done view renders a "reply drafted" indicator
        // from this same `replyDrafted` flag. One confirmation, one source.
        // (This tick could not actually disagree — both were set in this one
        // branch — but two confirmations for one fact is how the disagreeing
        // pattern gets reintroduced later.)
        setReplyDrafted(true);
        setNote(null);
      } else {
        const code = reply?.type === "DRAFT_REPLY_DONE" ? reply.errorCode : null;
        setNote({ text: helpFor(code), kind: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const startOver = async () => {
    const reply = await sendToHub({ type: "START_OVER" });
    if (reply?.type === "STATE_SNAPSHOT") dispatch({ type: "SYNC", state: reply.state });
    setReplyDrafted(false);
    setNote(null);
  };

  if (showSettings) {
    return (
      <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
        <Settings
          onClose={() => {
            refreshKeyStatus();
            refreshEnabled();
            setShowSettings(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div>
          <h1 className="text-sm font-semibold tracking-wide">
            Swivel <span className="font-normal text-slate-400">· Cross-Tab Automator</span>
          </h1>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Phase <span className="font-mono text-slate-300">{state.phase}</span>
          </p>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          title="Settings"
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          ⚙
        </button>
      </header>

      <main className="flex-1 overflow-y-auto p-3">
        {!hasKey && (
          <div className="mb-3 rounded border-l-2 border-amber-500 bg-amber-950/40 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
            No Gemini API key set.{" "}
            <button
              onClick={() => setShowSettings(true)}
              className="underline underline-offset-2 hover:text-amber-100"
            >
              Add one in Settings
            </button>
            .
          </div>
        )}

        <ExtractStep busy={busy} onExtract={() => void runExtract()} state={state} />

        {state.extracted && (
          <SourcePreview
            subject={state.extracted.subject}
            sender={state.extracted.sender}
            sourceUrl={state.extracted.sourceUrl}
            bodyText={state.extracted.bodyText}
            collapsed={state.phase === "review" || state.phase === "routing"}
          />
        )}

        {(state.phase === "sourceReady" || state.phase === "synthesizing") && (
          <button
            onClick={() => void runSynthesize()}
            disabled={busy}
            className="mt-2 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {state.phase === "synthesizing" ? "Synthesizing…" : "Synthesize → payload"}
          </button>
        )}

        {state.phase === "review" && state.payload && (
          <ReviewForm
            key={state.extracted?.sourceUrl ?? "review"}
            payload={state.payload}
            recipes={enabledRecipes}
            busy={busy}
            onPersist={persistEdit}
            onAutomate={automate}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}

        {/* Multiple target tabs matched — the user picks one. */}
        {candidates && (
          <div className="mt-3 rounded-md border border-indigo-800 bg-indigo-950/30 p-2">
            <p className="mb-2 text-[11px] font-semibold text-indigo-300">
              Multiple targets open — pick one
            </p>
            <ul className="space-y-1">
              {candidates.list.map((c) => (
                <li key={c.tabId}>
                  <button
                    disabled={busy}
                    onClick={() => void automate(candidates.recipeId, candidates.dryRun, c.tabId)}
                    className="w-full truncate rounded border border-slate-700 bg-slate-900 px-2 py-1 text-left text-[11px] hover:border-indigo-500 disabled:opacity-50"
                    title={c.url}
                  >
                    {c.title}
                    <span className="block truncate text-[10px] text-slate-500">{c.url}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* No target tab open — offer to open the recipe's canonical URL. */}
        {targetNotOpen && (
          <button
            onClick={() => void openTarget(targetNotOpen)}
            className="mt-2 w-full rounded-md bg-slate-800 px-3 py-2 text-[12px] font-medium text-slate-200 hover:bg-slate-700"
          >
            Open target tab
          </button>
        )}

        {(state.phase === "routing" || state.phase === "executing") && (
          <ExecutingView state={state} />
        )}

        {state.phase === "done" && (
          <DoneView
            state={state}
            busy={busy}
            replyDrafted={replyDrafted}
            onDraftReply={draftReply}
            onStartOver={() => void startOver()}
          />
        )}

        {state.error && (
          <div className="mt-3 rounded border-l-2 border-rose-500 bg-rose-950/40 px-2 py-1.5 text-[12px] leading-snug text-rose-200">
            {helpFor(state.error)}
            {/* Operator detail (HTTP status / API body / failing selector).
                Secondary to the curated message, never a replacement for it. */}
            {state.errorDetail && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-rose-300/70 hover:text-rose-200">
                  Technical detail
                </summary>
                <div className="mt-1 font-mono text-[10px] break-all text-rose-300/80">
                  {state.errorDetail}
                </div>
              </details>
            )}
          </div>
        )}

        {note && state.phase !== "error" && (
          <div
            className={`mt-3 rounded px-2 py-1 text-[11px] ${
              note.kind === "ok"
                ? "text-emerald-300"
                : note.kind === "error"
                  ? "text-rose-300"
                  : "text-slate-400"
            }`}
          >
            {note.text}
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views (presentational — the reducer holds all state)
// ---------------------------------------------------------------------------

function ExtractStep({
  busy,
  onExtract,
  state,
}: {
  busy: boolean;
  onExtract: () => void;
  state: PanelState;
}) {
  // Once we're past extraction, this becomes a compact "re-extract" action.
  const advanced = state.phase !== "idle" && state.phase !== "extracting";
  return (
    <>
      <button
        onClick={onExtract}
        disabled={busy}
        className={`w-full rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${
          advanced
            ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
            : "bg-indigo-600 hover:bg-indigo-500"
        }`}
      >
        {busy && state.phase === "extracting"
          ? "Extracting…"
          : advanced
            ? "Re-extract from this tab"
            : "Extract from this tab"}
      </button>
      {!advanced && (
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          Gmail is read directly; other sites use the on-demand extractor.
          Shortcut: Ctrl+Shift+E.
        </p>
      )}
    </>
  );
}

function SourcePreview({
  subject,
  sender,
  sourceUrl,
  bodyText,
  collapsed,
}: {
  subject: string | null;
  sender: string | null;
  sourceUrl: string;
  bodyText: string;
  collapsed: boolean;
}) {
  return (
    <details open={!collapsed} className="mt-3 rounded-md border border-slate-800 bg-slate-900">
      <summary className="cursor-pointer list-none px-2 py-1.5">
        <span className="truncate text-[12px] font-medium text-slate-200">
          {subject ?? "(no title)"}
        </span>
        <span className="block truncate text-[11px] text-slate-500">{sender ?? sourceUrl}</span>
      </summary>
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-slate-800 px-2 py-1.5 font-sans text-[11px] leading-snug text-slate-300">
        {bodyText}
      </pre>
    </details>
  );
}

function ReviewForm({
  payload,
  recipes,
  busy,
  onPersist,
  onAutomate,
  onOpenSettings,
}: {
  payload: SwivelPayload;
  recipes: RecipeSummary[];
  busy: boolean;
  onPersist: (p: SwivelPayload) => Promise<void>;
  onAutomate: (recipeId: string, dryRun: boolean) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState<SwivelPayload>(payload);
  const [recipeId, setRecipeId] = useState<string>(recipes[0]?.id ?? "");
  const [dryRun, setDryRun] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist edits to storage.session shortly after they stop — so a
  // close/reopen of the panel never loses an edit. Flush is forced before
  // automation so a just-typed value can't be left behind.
  const schedulePersist = (next: SwivelPayload) => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => void onPersist(next), 300);
  };
  const flushPersist = async (next: SwivelPayload) => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    await onPersist(next);
  };

  const update = <K extends keyof SwivelPayload>(field: K, value: SwivelPayload[K]) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    schedulePersist(next);
  };

  const target = recipes.find((r) => r.id === recipeId);

  return (
    <div className="mt-3 space-y-2">
      <div className="rounded-md border border-emerald-900 bg-emerald-950/20 p-2">
        <p className="mb-2 text-[11px] font-semibold text-emerald-300">Review payload</p>

        <Label text="Title" />
        <input
          value={draft.ticket_title}
          onChange={(e) => update("ticket_title", e.target.value)}
          onBlur={() => void flushPersist(draft)}
          className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
        />

        <div className="mb-2 grid grid-cols-2 gap-2">
          <div>
            <Label text="Customer ID" />
            <input
              value={draft.customer_id ?? ""}
              onChange={(e) => update("customer_id", e.target.value || null)}
              onBlur={() => void flushPersist(draft)}
              placeholder="—"
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <Label text="Priority" />
            <select
              value={draft.priority}
              onChange={(e) => {
                const next = { ...draft, priority: e.target.value as SwivelPayload["priority"] };
                setDraft(next);
                void flushPersist(next);
              }}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="urgent">urgent</option>
            </select>
          </div>
        </div>

        <Label text="Summary" />
        <textarea
          value={draft.summary}
          onChange={(e) => update("summary", e.target.value)}
          onBlur={() => void flushPersist(draft)}
          rows={3}
          className="mb-2 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
        />

        <Label text={`Action items (${draft.action_items.length})`} />
        <div className="space-y-1">
          {draft.action_items.map((item, i) => (
            <input
              key={i}
              value={item}
              onChange={(e) => {
                const items = draft.action_items.map((v, j) => (j === i ? e.target.value : v));
                update("action_items", items);
              }}
              onBlur={() => void flushPersist(draft)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] focus:border-indigo-500 focus:outline-none"
            />
          ))}
        </div>
      </div>

      {/* Target picker + dry-run + explicit confirm gate */}
      <div className="rounded-md border border-slate-800 bg-slate-900 p-2">
        {recipes.length === 0 ? (
          <p className="text-[11px] leading-snug text-slate-400">
            No target enabled.{" "}
            <button
              onClick={onOpenSettings}
              className="underline underline-offset-2 hover:text-slate-200"
            >
              Enable one in Settings
            </button>{" "}
            (grants access to that site) to automate.
          </p>
        ) : (
          <>
        <Label text="Target" />
        <select
          value={recipeId}
          onChange={(e) => setRecipeId(e.target.value)}
          className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
        >
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>

        <label className="mb-2 flex items-center gap-2 text-[11px] text-slate-300">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          Dry run (highlight fields, don't submit)
        </label>

        {!confirming ? (
          <button
            onClick={async () => {
              await flushPersist(draft);
              setConfirming(true);
            }}
            disabled={busy || !target}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Automate to target…
          </button>
        ) : (
          <div className="rounded border border-amber-700 bg-amber-950/30 p-2">
            <p className="mb-2 text-[11px] leading-snug text-amber-200">
              {dryRun ? (
                <>Dry run against <b>{target?.label}</b>: fields will be highlighted, nothing submitted.</>
              ) : (
                <>This will fill and submit into <b>{target?.label}</b> using your live session. Continue?</>
              )}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-md bg-slate-700 px-3 py-1.5 text-[12px] hover:bg-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setConfirming(false);
                  await onAutomate(recipeId, dryRun);
                }}
                disabled={busy}
                className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-50 ${
                  dryRun ? "bg-indigo-600 hover:bg-indigo-500" : "bg-rose-600 hover:bg-rose-500"
                }`}
              >
                {dryRun ? "Run dry run" : "Confirm & run"}
              </button>
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

function ExecutingView({ state }: { state: PanelState }) {
  return (
    <div className="mt-3 rounded-md border border-slate-800 bg-slate-900 p-2">
      <p className="mb-2 text-[11px] font-semibold text-slate-300">
        {state.phase === "routing"
          ? "Finding target…"
          : state.runDryRun
            ? "Dry run — highlighting fields, nothing will be submitted"
            : "Running steps"}
      </p>
      {state.steps.length === 0 ? (
        <p className="text-[11px] text-slate-500">Waiting for the first step…</p>
      ) : (
        <ol className="space-y-1">
          {state.steps.map((s) => (
            <li key={s.stepIndex} className="flex items-start gap-2 text-[11px]">
              <span
                className={
                  s.status === "ok"
                    ? "text-emerald-400"
                    : s.status === "failed"
                      ? "text-rose-400"
                      : "text-slate-500"
                }
              >
                {s.status === "ok" ? "✓" : s.status === "failed" ? "✕" : s.status === "skipped" ? "–" : "…"}
              </span>
              <span className="text-slate-300">
                Step {s.stepIndex + 1}
                {s.detail ? ` — ${s.detail}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DoneView({
  state,
  busy,
  replyDrafted,
  onDraftReply,
  onStartOver,
}: {
  state: PanelState;
  busy: boolean;
  replyDrafted: boolean;
  onDraftReply: (issueKey: string, issueUrl: string) => void;
  onStartOver: () => void;
}) {
  const issueUrl = state.readBack?.issueUrl ?? "";
  const issueKey = state.readBack?.issueKey ?? "";
  const hasLink = issueUrl !== "" || issueKey !== "";

  // EVERY word this view says about the run comes from here (Gate 6). There
  // is deliberately no other source of completion language, and no hardcoded
  // success string anywhere below.
  const report = describeRunOutcome(state.runOutcome, state.readBack);

  const tone =
    report.tone === "created"
      ? "border-emerald-800 bg-emerald-950/30"
      : report.tone === "warning"
        ? "border-amber-800 bg-amber-950/30"
        : "border-slate-700 bg-slate-900";
  const headlineTone =
    report.tone === "created"
      ? "text-emerald-300"
      : report.tone === "warning"
        ? "text-amber-300"
        : "text-slate-200";

  return (
    <div className="mt-3 space-y-2">
      <div className={`rounded-md border p-2 text-[12px] ${tone}`}>
        <p className={`font-semibold ${headlineTone}`}>{report.headline}</p>
        <p className="mt-0.5 leading-snug text-slate-400">{report.detail}</p>
        {/* The link is shown whenever we HAVE one, but it never implies
            creation on its own — the headline above is the claim. */}
        {hasLink && (
          <a
            href={issueUrl || undefined}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block break-all text-indigo-400 underline"
          >
            {issueKey || issueUrl}
          </a>
        )}
        {replyDrafted && (
          <p className="mt-1 text-[11px] text-emerald-400">
            Reply drafted in Gmail (unsent) — review and send it yourself.
          </p>
        )}
      </div>

      {report.canDraftReply && !replyDrafted && (
        <button
          onClick={() => onDraftReply(issueKey, issueUrl)}
          disabled={busy}
          className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Drafting…" : "Draft reply in Gmail"}
        </button>
      )}

      <button
        onClick={onStartOver}
        className="w-full rounded-md bg-slate-800 px-3 py-2 text-[12px] font-medium text-slate-200 hover:bg-slate-700"
      >
        Start over
      </button>
    </div>
  );
}

function Label({ text }: { text: string }) {
  return <label className="mb-0.5 block text-[10px] font-medium text-slate-500">{text}</label>;
}
