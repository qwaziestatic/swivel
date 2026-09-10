/**
 * src/shared/errors.ts — the single error taxonomy (Phase 10).
 *
 * Every typed error code Swivel can surface lives here with human wording.
 * The panel renders errors ONLY through helpFor(), which returns the
 * mapped message or a generic fallback — so a raw stack trace or an
 * internal message can never reach the UI (Charter: no raw traces).
 */

export const ERROR_HELP: Record<string, string> = {
  // --- Extraction (Phase 2) ---
  NO_EMAIL_OPEN: "Open an email thread first — the inbox list view has nothing to extract.",
  NO_ACTIVE_TAB_GRANT:
    "Click the Swivel icon on this tab (or press the shortcut there), then extract.",
  UNSUPPORTED_PAGE: "Browser-internal pages can't be extracted.",
  EXTRACT_NO_RECEIVER:
    "Swivel couldn't reach its extractor on this tab, even after re-injecting it. Reload the tab, then extract.",
  GMAIL_SITE_ACCESS_BLOCKED:
    "Chrome is blocking Swivel's access to mail.google.com. Open chrome://extensions → Swivel → Details → Site access and allow mail.google.com, then reload the Gmail tab.",
  GMAIL_BODY_NOT_RENDERED:
    "Gmail hadn't finished rendering the open thread. Wait a moment and extract again.",
  GMAIL_EXTRACT_FAILED:
    "An email looks open, but its content couldn't be read. Gmail may have changed its layout.",
  EXTRACT_FAILED: "Extraction failed on this page.",
  PING_FAILED: "No Swivel content script answered on the active tab.",
  NO_SOURCE: "Extract from a tab first — there's nothing to synthesize yet.",

  // --- Synthesis (Phase 3; taxonomy split after the final-gate defects) ---
  NO_API_KEY: "Add your Gemini API key in Settings, then synthesize.",
  NO_GEMINI_PERMISSION:
    "Swivel doesn't have permission to reach the Gemini API. Open Settings and use “Grant Gemini access”, then retry.",
  GEMINI_ORIGIN_BLOCKED:
    "Gemini access is granted but BLOCKED by Chrome's site-access setting. Open chrome://extensions → Swivel → Details → Site access, and make sure generativelanguage.googleapis.com is allowed. (If you're offline, that would also cause this.)",
  SYNTHESIS_AUTH:
    "Gemini rejected the API key. Check it in Settings — it may be wrong, expired, or lack access to this model. Use “Test key” to confirm.",
  SYNTHESIS_MODEL:
    "Gemini doesn't recognise the configured model. Pick a different model in Settings (the default is a known-good one).",
  SYNTHESIS_BAD_REQUEST:
    "Gemini rejected the request as malformed. This is a Swivel bug — check the service worker console for the API's error body.",
  SYNTHESIS_RATE_LIMIT: "Gemini is rate-limiting your key. Wait a moment and retry.",
  SYNTHESIS_SERVER: "Gemini had a server-side error. This is on their end — retry shortly.",
  SYNTHESIS_HTTP: "Gemini returned an unexpected error. Check the service worker console for details.",
  SYNTHESIS_TIMEOUT: "The Gemini request timed out. Check your connection and retry.",
  SYNTHESIS_NETWORK: "Couldn't reach Gemini. Check your internet connection.",
  SYNTHESIS_BAD_RESPONSE:
    "Gemini replied, but with no usable content (often a safety block or an empty candidate). Try rewording the email.",
  SYNTHESIS_SCHEMA:
    "Gemini's response didn't match the expected format, even after a retry. Try again or refine the email.",
  SYNTHESIS_ERROR:
    "Gemini's response didn't match the expected format, even after a retry. Try again or refine the email.",
  SYNTHESIS_CRASHED:
    "Synthesis failed unexpectedly. Check the service worker console — the specific error was logged there.",

  // --- Lifecycle (Phase 3/8) ---
  PANEL_SYNC_REJECTED:
    "Extraction succeeded, but the panel couldn't display it (an internal state transition was refused). Reload the side panel — the captured source is saved and will reappear.",
  HUB_NO_RESPONSE:
    "Swivel's background worker didn't answer. Open chrome://extensions → Swivel → “service worker” to see the error, or reload the extension and retry.",
  INTERRUPTED:
    "The previous operation was interrupted (the background worker restarted). Please try again.",

  // --- Routing (Phase 5) ---
  RECIPE_NOT_FOUND: "That recipe no longer exists.",
  TARGET_NOT_OPEN: "No matching target tab is open. Open the target, then automate.",

  // --- Injection (Phase 7) ---
  NO_PAYLOAD: "Synthesize a payload before automating.",
  EXECUTOR_SILENT:
    "The automation script never reported a single step. It may not be running on the target tab, or the run never reached it. Reload the target tab and try again — nothing was submitted.",
  EXECUTOR_UNREACHABLE:
    "Swivel couldn't hand the run to the target tab's automation script. Reload the target tab and retry — nothing was submitted.",
  TARGET_ORIGIN_NOT_GRANTED:
    "Swivel doesn't have permission for this target's site. Enable its recipe in Settings to grant access, then retry.",
  TARGET_ORIGIN_BLOCKED:
    "Permission for this target is granted but BLOCKED by Chrome's site-access setting. Open chrome://extensions → Swivel → Details → Site access and allow the target's domain, then retry.",
  TARGET_INJECT_FAILED:
    "Couldn't load the automation script into the target tab. If this is Jira, enable the Jira recipe in Settings (grants access). Otherwise reload the target and retry.",
  RUN_DUPLICATE:
    "This exact payload was already submitted to this target — refusing to run again (double-submit guard).",
  SELECTOR_NOT_FOUND:
    "A field wasn't found on the target page — the recipe's selectors may be stale for this instance. Try 'Test selectors' in Settings.",
  OPTION_NOT_FOUND:
    "A dropdown option didn't match the payload value. Check the value against the target's options.",
  ABORTED: "The run was aborted before finishing.",
  STEP_FAILED: "A step failed on the target page.",

  // --- Resilience (Phase 8) ---
  NAVIGATION_INTERRUPTED:
    "The target page navigated during the run, so it was stopped. Nothing further was submitted.",
  RUN_IN_PROGRESS: "A run is already in progress — wait for it to finish.",
  SEND_DENIED:
    "Refused: a step tried to activate a Send control. Swivel drafts; sending stays a human action.",

  // --- Loop closure (Phase 9) ---
  NO_GMAIL_TAB: "No Gmail tab is open to reply in. Open the email thread and try again.",
  REPLY_UI_NOT_FOUND:
    "Couldn't find Gmail's Reply/compose controls — Gmail may have changed its layout.",
  REPLY_NO_RECEIVER: "Reload the Gmail tab (it predates Swivel), then draft again.",
  DRAFT_FAILED: "Couldn't draft the reply on the Gmail thread.",
};

/** Map a typed code to human wording, never exposing raw internal text. */
export function helpFor(code: string | null | undefined): string {
  if (!code) return "Something went wrong. Please try again.";
  return ERROR_HELP[code] ?? "Something went wrong. Please try again.";
}
