/**
 * src/sidepanel/Settings.tsx — settings (Phase 10 complete).
 *
 * API key (masked) + model, per-recipe enable/disable, and "Test selectors"
 * (the recipe-staleness early-warning). Writes go straight to
 * chrome.storage.local via settingsStore — the key never rides a message.
 *
 * Permission diet: saving a key grants the Gemini host permission, and
 * enabling a recipe grants its target host permission — both requested from
 * the button click (a user gesture), which chrome.permissions.request
 * requires. A fresh install therefore prompts only for Gmail.
 */

import { useEffect, useState } from "react";
import { DEFAULT_MODEL } from "../shared/config";
import { RECIPE_SUMMARIES } from "../shared/recipes";
import {
  isSwivelMessage,
  type SelectorTestResult,
  type SwivelMessage,
} from "../shared/messages";
import { helpFor } from "../shared/errors";
import {
  GEMINI_ORIGIN,
  getApiKeyStatus,
  getEnabledRecipes,
  getModel,
  hasOrigin,
  requestGeminiPermission,
  requestOrigin,
  saveApiKey,
  saveModel,
  setRecipeEnabled,
} from "./settingsStore";

async function sendToHub(message: SwivelMessage): Promise<SwivelMessage | undefined> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  return isSwivelMessage(response) ? response : undefined;
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [keyInput, setKeyInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [status, setStatus] = useState<{ set: boolean; masked: string }>({
    set: false,
    masked: "",
  });
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<string | null>(null);
  /** Result of the live "Test key" probe. */
  const [keyProbe, setKeyProbe] = useState<{
    pending: boolean;
    ok?: boolean;
    message?: string;
    detail?: string | null;
  } | null>(null);
  /**
   * Whether each optional origin is GRANTED (final-gate defect 3b: make this
   * visible before a run fails, not after). Note the honest limit stated in
   * the UI copy: granted ≠ reachable, because Chrome's per-site access
   * toggle can withhold a granted origin and contains() still reports true.
   */
  const [geminiGranted, setGeminiGranted] = useState<boolean | null>(null);
  const [originGranted, setOriginGranted] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<{
    recipeId: string;
    results?: SelectorTestResult[];
    error?: string;
  } | null>(null);

  const refreshPermissions = async () => {
    setGeminiGranted(await hasOrigin(GEMINI_ORIGIN));
    const map: Record<string, boolean> = {};
    for (const r of RECIPE_SUMMARIES) {
      map[r.id] = await hasOrigin(r.requiredOrigin);
    }
    setOriginGranted(map);
  };

  useEffect(() => {
    void (async () => {
      setStatus(await getApiKeyStatus());
      setModelInput(await getModel());
      setEnabled(new Set(await getEnabledRecipes()));
      await refreshPermissions();
    })();
  }, []);

  const save = async () => {
    if (keyInput.trim()) {
      await saveApiKey(keyInput.trim());
      // Opt into the Gemini endpoint now that a key exists.
      await requestGeminiPermission();
    }
    await saveModel(modelInput.trim());
    setStatus(await getApiKeyStatus());
    setKeyInput("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const toggleRecipe = async (id: string, origin: string, next: boolean) => {
    if (next) {
      // Ask for the target host permission (user gesture → this click).
      const granted = (await hasOrigin(origin)) || (await requestOrigin(origin));
      if (!granted) return; // permission declined — leave it off
    }
    await setRecipeEnabled(id, next);
    setEnabled(new Set(await getEnabledRecipes()));
    await refreshPermissions();
    if (!next && testResult?.recipeId === id) setTestResult(null);
  };

  /**
   * "Test key" — one minimal live Gemini call (final-gate defect 2c).
   *
   * The point is ISOLATION: it separates "my key is wrong" from "the
   * extension is broken" without making the user open the service worker
   * devtools. The hub does the call (the key never leaves storage/worker);
   * we render the typed code through the same helpFor() as everything else,
   * with the raw status/body underneath as secondary text.
   */
  const testKey = async () => {
    setKeyProbe({ pending: true });
    try {
      const reply = await sendToHub({ type: "TEST_KEY_REQUEST" });
      if (reply?.type === "TEST_KEY_RESULT") {
        setKeyProbe({
          pending: false,
          ok: reply.ok,
          message: reply.ok
            ? `Key works — ${reply.model} responded.`
            : helpFor(reply.errorCode),
          detail: reply.detail,
        });
      } else {
        // A missing/malformed reply means the worker never answered the
        // channel — itself diagnostic, so say that rather than nothing.
        setKeyProbe({
          pending: false,
          ok: false,
          message:
            "The background worker didn't answer. Reload the extension at chrome://extensions and retry.",
          detail: null,
        });
      }
    } catch (err) {
      setKeyProbe({
        pending: false,
        ok: false,
        message: helpFor("SYNTHESIS_CRASHED"),
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const testSelectors = async (recipeId: string) => {
    setTesting(recipeId);
    setTestResult(null);
    try {
      const reply = await sendToHub({ type: "TEST_SELECTORS_REQUEST", recipeId });
      if (reply?.type === "TEST_SELECTORS_RESULT") {
        setTestResult({ recipeId, results: reply.results });
      } else if (reply?.type === "AUTOMATION_ERROR") {
        setTestResult({ recipeId, error: helpFor(reply.errorCode) });
      }
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Settings</h2>
        <button onClick={onClose} className="text-[11px] text-slate-400 hover:text-slate-200">
          ← Back
        </button>
      </div>

      <label className="mb-1 block text-[11px] font-medium text-slate-300">Gemini API key</label>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder={status.set ? `Saved: ${status.masked}` : "Paste your key"}
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
      />
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        Stored in this extension's local storage on your machine only. It is
        never sent anywhere except your own Gemini API calls, and never reaches
        a web page.
      </p>

      <label className="mt-3 mb-1 block text-[11px] font-medium text-slate-300">
        Model <span className="text-slate-500">(optional)</span>
      </label>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={modelInput}
        onChange={(e) => setModelInput(e.target.value)}
        placeholder={DEFAULT_MODEL}
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
      />

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void save()}
          className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500"
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
        <button
          onClick={() => void testKey()}
          disabled={!status.set || keyProbe?.pending}
          className="rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          title="Make one minimal live Gemini call and report exactly what happens"
        >
          {keyProbe?.pending ? "Testing…" : "Test key"}
        </button>
      </div>

      {keyProbe && !keyProbe.pending && (
        <div
          className={`mt-2 rounded border p-2 text-[11px] leading-snug ${
            keyProbe.ok
              ? "border-emerald-800 bg-emerald-950 text-emerald-200"
              : "border-rose-900 bg-rose-950 text-rose-200"
          }`}
        >
          <div>{keyProbe.message}</div>
          {keyProbe.detail && (
            <div className="mt-1 font-mono text-[10px] break-all text-slate-400">
              {keyProbe.detail}
            </div>
          )}
        </div>
      )}

      {/* Site-access visibility (defect 3b): show the permission state BEFORE
          a run fails on it. */}
      <div className="mt-2 flex items-center justify-between rounded border border-slate-800 bg-slate-900 px-2 py-1.5 text-[11px]">
        <span className="text-slate-300">
          Gemini API access:{" "}
          {geminiGranted === null ? (
            <span className="text-slate-500">checking…</span>
          ) : geminiGranted ? (
            <span className="text-emerald-400">granted</span>
          ) : (
            <span className="text-amber-400">not granted</span>
          )}
        </span>
        {geminiGranted === false && (
          <button
            onClick={() =>
              void (async () => {
                await requestGeminiPermission();
                await refreshPermissions();
              })()
            }
            className="rounded border border-slate-700 px-2 py-0.5 text-[10px] hover:bg-slate-800"
          >
            Grant Gemini access
          </button>
        )}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        “Granted” means the permission exists. Chrome can still block it
        separately: chrome://extensions → Swivel → Details → Site access. If
        calls fail while this says granted, check there — and use “Test key”
        to confirm.
      </p>

      {/* --- Targets: enable/disable + staleness check --- */}
      <h3 className="mt-5 mb-1 text-[11px] font-semibold text-slate-300">Targets</h3>
      <p className="mb-2 text-[10px] leading-snug text-slate-500">
        Enabling a target grants Swivel access to that site. Access is only
        requested when you turn it on.
      </p>

      <div className="space-y-2">
        {RECIPE_SUMMARIES.map((r) => {
          const on = enabled.has(r.id);
          return (
            <div key={r.id} className="rounded-md border border-slate-800 bg-slate-900 p-2">
              {/* Per-target site access, visible before a run fails on it. */}
              {on && originGranted[r.id] === false && (
                <div className="mb-1 rounded border border-amber-900 bg-amber-950 px-1.5 py-1 text-[10px] leading-snug text-amber-200">
                  Enabled, but Swivel has no permission for{" "}
                  <span className="font-mono">{r.requiredOrigin}</span>. Toggle
                  this target off and on to re-request it.
                </div>
              )}
              <label className="flex items-center justify-between gap-2 text-[12px] text-slate-200">
                <span>{r.label}</span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => void toggleRecipe(r.id, r.requiredOrigin, e.target.checked)}
                />
              </label>
              {on && (
                <button
                  onClick={() => void testSelectors(r.id)}
                  disabled={testing === r.id}
                  className="mt-2 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-indigo-500 disabled:opacity-50"
                >
                  {testing === r.id ? "Testing…" : "Test selectors"}
                </button>
              )}
              {testResult?.recipeId === r.id && (
                <SelectorReport
                  results={testResult.results}
                  error={testResult.error}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectorReport({
  results,
  error,
}: {
  results?: SelectorTestResult[];
  error?: string;
}) {
  if (error) {
    return <p className="mt-2 text-[11px] text-rose-300">{error}</p>;
  }
  if (!results) return null;
  const failed = results.filter((r) => !r.resolved);
  return (
    <div className="mt-2 text-[11px]">
      <p className={failed.length === 0 ? "text-emerald-300" : "text-amber-300"}>
        {results.length - failed.length}/{results.length} selectors resolve
        {failed.length > 0 ? " — recipe may be stale:" : " ✓"}
      </p>
      {failed.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {failed.map((f, i) => (
            <li key={i} className="break-all font-mono text-[10px] text-rose-300">
              ✕ {f.selector}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
