/**
 * src/background/gemini.ts — the ONLY place Swivel calls an LLM.
 *
 * Runs exclusively in the service worker (Charter Law 2). The API key is a
 * parameter here, read by the hub from chrome.storage.local per call and
 * passed in — it is never imported into, or reachable from, a content
 * script or the message union. This file does not touch chrome.storage
 * itself, which keeps it a pure, mockable unit (see gemini.test.ts).
 *
 * Structured output: we ask Gemini for responseMimeType "application/json"
 * plus a responseSchema, which constrains the model server-side. We STILL
 * zod-validate the bytes (parseLlmPayload) — schema-conformant intent is
 * not schema-conformant output. On a validation miss we do exactly one
 * repair retry, feeding the zod error back so the model can self-correct;
 * a second miss is a typed failure, never a persisted half-payload.
 */

import { parseLlmPayload, PRIORITY_VALUES, type LlmPayload } from "../shared/payload";
import type { ExtractedContext } from "../shared/messages";
import { DEFAULT_MODEL } from "../shared/config";
import {
  classifyFetchFailure,
  classifyHttpStatus,
  type SynthesisErrorCode,
} from "../shared/diagnostics";

const DEFAULT_TIMEOUT_MS = 20_000;
const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type { SynthesisErrorCode };

export type SynthesisResult =
  | { ok: true; payload: LlmPayload }
  | { ok: false; code: SynthesisErrorCode; detail: string };

export interface SynthesizeOptions {
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests — defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Whether the caller believes the Gemini origin is granted. Feeds
   * classifyFetchFailure so an opaque "Failed to fetch" on a GRANTED origin
   * is reported as a blocked site-access toggle rather than "you're offline"
   * (the exact final-gate defect 3 state). Defaults to false = don't guess.
   */
  originGranted?: boolean;
}

/**
 * Default fetch, BOUND to the global scope.
 *
 * WHY: `const f = opts.fetchImpl ?? fetch; f(url)` calls fetch with its
 * receiver detached, which some engines reject with "Illegal invocation".
 * Every unit test injects a mock fetchImpl, so that path is exercised by
 * tests and never by production — precisely the shape of bug that survives
 * a green suite and dies in a browser. Binding removes the question.
 *
 * FLAGGED: I could not reproduce this in a browser from here, so I am not
 * claiming it WAS the failure — only that it is now structurally impossible.
 */
const boundFetch: typeof fetch = (...args) => fetch(...args);

/** Gemini's responseSchema dialect is an OpenAPI subset (UPPERCASE type
 *  names, `nullable`), distinct from JSON Schema — hand-built to match
 *  llmPayloadSchema. source_url is intentionally absent (hub-supplied). */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    ticket_title: { type: "STRING" },
    customer_id: { type: "STRING", nullable: true },
    priority: { type: "STRING", enum: [...PRIORITY_VALUES] },
    summary: { type: "STRING" },
    action_items: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["ticket_title", "priority", "summary", "action_items"],
} as const;

const SYSTEM_INSTRUCTION =
  "You convert an unstructured work email into a structured ticket payload. " +
  "Extract only what the email supports; do not invent a customer_id — use null if absent. " +
  "priority must reflect urgency cues in the text. summary is 1-3 sentences. " +
  "action_items are concrete next steps, empty array if none.";

function buildPrompt(ctx: ExtractedContext, repairError?: string): string {
  const base =
    `SUBJECT: ${ctx.subject ?? "(none)"}\n` +
    `FROM: ${ctx.sender ?? "(unknown)"}\n\n` +
    `BODY:\n${ctx.bodyText}`;
  if (!repairError) return base;
  // Repair turn: the previous output failed validation. Give the model the
  // exact field errors so it can fix them, not guess.
  return (
    base +
    `\n\n---\nYour previous response failed validation with these errors:\n` +
    `${repairError}\nReturn corrected JSON that satisfies the schema exactly.`
  );
}

/** Extract the text part from a Gemini generateContent response. */
function extractText(json: unknown): string | null {
  const candidates = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = (parts[0] as { text?: unknown })?.text;
  return typeof text === "string" ? text : null;
}

/** One request/parse attempt. Returns the raw model text or a typed error;
 *  parsing/validation happens in the caller so it can drive the repair.
 *
 *  EVERY exit path logs to the service worker console (final-gate defect 2:
 *  an external API call must never fail invisibly). */
async function callOnce(
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  originGranted: boolean
): Promise<{ ok: true; text: string } | { ok: false; code: SynthesisErrorCode; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;
  console.log(`[gemini] POST ${url} (timeout ${timeoutMs}ms, originGranted=${originGranted})`);
  try {
    // Key travels as a header, not a query string, so it never lands in
    // request-URL logs. abort → typed timeout below.
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = classifyHttpStatus(res.status, body);
      // The API's error body is the single most useful thing for diagnosing
      // a key/model problem. It was previously fetched and dropped.
      console.error(
        `[gemini] HTTP ${res.status} ${res.statusText} → ${code}\n[gemini] body: ${body.slice(0, 1000)}`
      );
      return { ok: false, code, detail: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[gemini] 200 but body was not JSON: ${detail}`);
      return { ok: false, code: "SYNTHESIS_BAD_RESPONSE", detail };
    }

    const text = extractText(json);
    if (text === null) {
      // A 200 with no text usually means a safety block or an empty
      // candidate. Log the envelope — the finishReason lives in there.
      const envelope = JSON.stringify(json).slice(0, 1000);
      console.error(`[gemini] 200 with no text content. Envelope: ${envelope}`);
      return {
        ok: false,
        code: "SYNTHESIS_BAD_RESPONSE",
        detail: "Model returned no text content (possible safety block)",
      };
    }
    console.log(`[gemini] ok — ${text.length} chars of model text`);
    return { ok: true, text };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    const code = isAbort ? "SYNTHESIS_TIMEOUT" : classifyFetchFailure(raw, originGranted);
    console.error(`[gemini] fetch rejected → ${code}: ${raw}`, err);
    return {
      ok: false,
      code,
      detail: isAbort ? `Timed out after ${timeoutMs}ms` : raw,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synthesize a validated LlmPayload from extracted context. At most two
 * model round-trips: the initial call, then (only if validation fails) one
 * repair call seeded with the zod error. HTTP/timeout/network failures do
 * NOT trigger the repair loop — retrying a rejected key or a dead network
 * just burns another 20s; only a validation miss is worth a repair.
 */
export async function synthesize(
  ctx: ExtractedContext,
  apiKey: string,
  opts: SynthesizeOptions = {}
): Promise<SynthesisResult> {
  if (!apiKey.trim()) {
    return { ok: false, code: "NO_API_KEY", detail: "No Gemini API key configured" };
  }
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? boundFetch;
  const originGranted = opts.originGranted ?? false;

  const first = await callOnce(
    apiKey,
    model,
    buildPrompt(ctx),
    timeoutMs,
    fetchImpl,
    originGranted
  );
  if (!first.ok) return first;

  const firstParse = parseLlmPayload(first.text);
  if (firstParse.ok) return { ok: true, payload: firstParse.value };

  console.warn(`[gemini] first response failed validation, repairing: ${firstParse.error}`);

  // Repair attempt — one only.
  const repair = await callOnce(
    apiKey,
    model,
    buildPrompt(ctx, firstParse.error),
    timeoutMs,
    fetchImpl,
    originGranted
  );
  if (!repair.ok) return repair;

  const repairParse = parseLlmPayload(repair.text);
  if (repairParse.ok) return { ok: true, payload: repairParse.value };

  console.error(`[gemini] validation failed even after repair: ${repairParse.error}`);
  return {
    ok: false,
    code: "SYNTHESIS_SCHEMA",
    detail: `Validation failed after repair: ${repairParse.error}`,
  };
}

/**
 * ONE minimal live call, used by Settings' "Test key" button.
 *
 * Deliberately the cheapest possible generateContent request (no schema, no
 * system instruction, 1-token cap): it proves key + model + origin access in
 * a single round trip without spending a real synthesis. Returns the same
 * typed codes as synthesize(), so Settings renders through the same helpFor().
 */
export async function testApiKey(
  apiKey: string,
  opts: SynthesizeOptions = {}
): Promise<{ ok: true; model: string } | { ok: false; code: SynthesisErrorCode; detail: string; model: string }> {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  if (!apiKey.trim()) {
    return { ok: false, code: "NO_API_KEY", detail: "No Gemini API key configured", model };
  }
  const fetchImpl = opts.fetchImpl ?? boundFetch;
  const originGranted = opts.originGranted ?? false;
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  console.log(`[gemini] key probe → ${url}`);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = classifyHttpStatus(res.status, body);
      console.error(`[gemini] key probe HTTP ${res.status} → ${code}\n[gemini] body: ${body.slice(0, 1000)}`);
      return { ok: false, code, detail: `HTTP ${res.status}: ${body.slice(0, 300)}`, model };
    }
    console.log("[gemini] key probe ok");
    return { ok: true, model };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    const code = isAbort ? "SYNTHESIS_TIMEOUT" : classifyFetchFailure(raw, originGranted);
    console.error(`[gemini] key probe rejected → ${code}: ${raw}`, err);
    return { ok: false, code, detail: raw, model };
  } finally {
    clearTimeout(timer);
  }
}
