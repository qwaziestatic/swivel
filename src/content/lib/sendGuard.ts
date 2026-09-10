/**
 * src/content/lib/sendGuard.ts — the Send-denial law, in code.
 *
 * CHARTER LAW (Phase 8/9): Swivel drafts; a human sends. The executor must
 * have NO capability to activate a Send control — not by a shipped recipe,
 * not by a hostile user-edited one (recipes become editable in Phase 10).
 * This is enforced, not documented: target.ts calls these before acting and
 * refuses (SEND_DENIED) if either the SELECTOR or the resolved ELEMENT looks
 * like a Send control.
 *
 * Two layers because each catches what the other misses:
 *  - looksLikeSendSelector: catches a recipe that names Send outright, e.g.
 *    `[aria-label="Send"]` or `[data-tooltip*="Send"]`.
 *  - isSendElement: catches a recipe that targets Send by an opaque class
 *    (Gmail's real send button is `.T-I-atl`), by inspecting the resolved
 *    element's accessible name.
 *
 * Both are pure (isSendElement only reads getAttribute/textContent) so they
 * are unit-tested without a browser.
 */

/** True if the selector string clearly targets a Send control by name. */
export function looksLikeSendSelector(selector: string): boolean {
  const s = selector.toLowerCase();
  // [aria-label(*^~|$)="send…"] / [data-tooltip*="send…"] and :has-text("send")
  return (
    /aria-label\s*[~^$*|]?=\s*["']?\s*send/.test(s) ||
    /data-tooltip\s*[~^$*|]?=\s*["']?\s*send/.test(s) ||
    /:has-text\(\s*["']?\s*send/.test(s)
  );
}

/** Minimal element shape sendGuard reads — keeps it mockable in unit tests. */
export interface SendCheckable {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/** True if the resolved element is (accessibly) a Send control. */
export function isSendElement(el: SendCheckable): boolean {
  const label = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("data-tooltip") ?? ""}`;
  if (/\bsend\b/i.test(label)) return true;
  // A role=button whose visible text is "Send" (e.g. Gmail's Send button).
  if (el.getAttribute("role") === "button" && /^send\b/i.test((el.textContent ?? "").trim())) {
    return true;
  }
  return false;
}
