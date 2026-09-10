/**
 * src/shared/diagnostics.ts — pure failure classification.
 *
 * WHY THIS FILE EXISTS (gate defect 2): the synthesis path already produced
 * typed codes, but it collapsed several very different failures into one
 * bucket and threw away the HTTP status and the API's error body. "Gemini
 * returned an error" is useless to a user who actually has a disabled site
 * toggle, a dead model id, or a bad key.
 *
 * Everything here is pure (string/number in, code out) so the classification
 * is unit-tested without a browser or a live API — the part of the gate
 * defects that CAN be locked down by tests.
 */

/** Typed synthesis outcomes. Codes flow into WorkflowState.lastError and get
 *  human wording from ERROR_HELP (Charter: no raw errors in the UI). */
export type SynthesisErrorCode =
  | "NO_API_KEY"
  | "NO_GEMINI_PERMISSION" // optional origin never granted
  | "GEMINI_ORIGIN_BLOCKED" // granted, but site access toggled off
  | "SYNTHESIS_AUTH" // key rejected (401/403/400 API_KEY_INVALID)
  | "SYNTHESIS_MODEL" // unknown/deprecated model id (404, some 400s)
  | "SYNTHESIS_BAD_REQUEST" // 400 we can't attribute to key or model
  | "SYNTHESIS_RATE_LIMIT" // 429
  | "SYNTHESIS_SERVER" // 5xx
  | "SYNTHESIS_HTTP" // other non-2xx
  | "SYNTHESIS_TIMEOUT" // AbortController fired
  | "SYNTHESIS_NETWORK" // fetch rejected (offline, DNS)
  | "SYNTHESIS_BAD_RESPONSE" // 200 but unparseable / no text
  | "SYNTHESIS_SCHEMA"; // parsed, but failed zod even after repair

/**
 * Map an HTTP status + response body to a typed code.
 *
 * The body matters: Gemini answers BOTH "your key is invalid" and "that
 * model doesn't exist" with a 400, so status alone cannot tell a user which
 * of the two to go fix. Real shapes this keys off:
 *   400 + "API key not valid" / "API_KEY_INVALID"  → auth
 *   400 + "is not found" / "not supported"          → model
 *   404 + "models/... is not found for API version" → model
 */
export function classifyHttpStatus(status: number, body: string): SynthesisErrorCode {
  const b = body.toLowerCase();
  const looksLikeBadKey =
    b.includes("api key not valid") ||
    b.includes("api_key_invalid") ||
    b.includes("api key expired") ||
    b.includes("permission_denied");
  const looksLikeBadModel =
    b.includes("is not found") ||
    b.includes("not supported") ||
    b.includes("unsupported model") ||
    b.includes("was not found");

  if (status === 404) return looksLikeBadKey ? "SYNTHESIS_AUTH" : "SYNTHESIS_MODEL";
  if (status === 401 || status === 403) return "SYNTHESIS_AUTH";
  if (status === 429) return "SYNTHESIS_RATE_LIMIT";
  if (status === 400) {
    if (looksLikeBadKey) return "SYNTHESIS_AUTH";
    if (looksLikeBadModel) return "SYNTHESIS_MODEL";
    return "SYNTHESIS_BAD_REQUEST";
  }
  if (status >= 500) return "SYNTHESIS_SERVER";
  return "SYNTHESIS_HTTP";
}

/**
 * Classify a rejected fetch.
 *
 * THE GATE-DEFECT-3 CASE: Chrome can report an optional origin as GRANTED
 * (permissions.contains → true) while the user has that origin's per-site
 * access toggled off in chrome://extensions. The request is then blocked
 * before it leaves the worker and surfaces as a bare "Failed to fetch",
 * indistinguishable from being offline.
 *
 * We disambiguate with the one extra bit we hold: whether we believe the
 * origin is granted. Granted + "Failed to fetch" is far more likely a
 * withheld site toggle than a dead network, so we say so — the user can act
 * on that, whereas "check your connection" sends them the wrong way.
 *
 * NOTE: this is a heuristic. A genuinely offline user with the origin
 * granted gets the site-access wording. That is the right trade: the
 * message names BOTH causes, and offline is self-evident to the user.
 */
export function classifyFetchFailure(
  message: string,
  originGranted: boolean
): SynthesisErrorCode {
  const m = message.toLowerCase();
  if (m.includes("abort")) return "SYNTHESIS_TIMEOUT";
  const isOpaqueNetworkError =
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed");
  if (isOpaqueNetworkError && originGranted) return "GEMINI_ORIGIN_BLOCKED";
  return "SYNTHESIS_NETWORK";
}

/**
 * Pick the container the user is actually LOOKING AT from several candidates.
 *
 * GATE DEFECT 1: Gmail is an SPA that keeps previously-rendered views in the
 * DOM. `document.querySelector('[role="main"]')` returns the FIRST match in
 * document order, which can be a stale, hidden view — so extraction happily
 * read the old thread after switching threads. Visible-first selection is
 * what makes a second extraction see the second email.
 *
 * Pure: the visibility predicate is injected, so this is unit-tested with
 * plain objects and no DOM.
 */
export function pickVisibleContainer<T>(
  candidates: readonly T[],
  isVisible: (el: T) => boolean
): T | null {
  if (candidates.length === 0) return null;
  for (const el of candidates) {
    if (isVisible(el)) return el;
  }
  // Nothing reports visible (detached subtree, zero-size layout during a
  // transition). Prefer the LAST candidate: Gmail appends newer views after
  // older ones, so the newest is the better guess than the stalest.
  return candidates[candidates.length - 1] ?? null;
}
