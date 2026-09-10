/**
 * src/content/gmail.ts — Gmail source extractor (manifest-registered for
 * https://mail.google.com/*, bundled to gmail.js as its own IIFE).
 *
 * Build note: waitForElement is compiled INTO this bundle, duplicating the
 * copy inside content.js. That duplication is correct for content scripts —
 * classic scripts can't share chunks — so we don't fight it.
 *
 * SELECTOR STRATEGY (Charter Law 6): Gmail's class names are obfuscated
 * and churn on every push, so we anchor on semantics that Gmail needs for
 * accessibility and its own features:
 *   - '[role="main"]'          the active pane (list view OR thread view)
 *   - '[role="main"] h2'       the thread subject — only exists in thread
 *                              view, which makes it our "is an email open?"
 *                              probe as well
 *   - 'div[data-message-id]'   one per message in the thread (data-* Gmail
 *                              relies on internally; far stabler than class)
 *   - 'span[email]'            sender chips carry the address as an
 *                              attribute — attribute selectors, not classes
 *   - 'div.a3s'                the ONE class we allow: the message body
 *                              container, unchanged for ~a decade; we fall
 *                              back to the message container's innerText if
 *                              it ever dies.
 *
 * We read innerText, not textContent, deliberately: innerText skips
 * display:none content, which is where Gmail hides collapsed quoted
 * history — so most reply-chain noise never even reaches cleanText.
 */

import {
  isSwivelMessage,
  type ExtractedContext,
  type SwivelMessage,
} from "../shared/messages";
import {
  TimeoutError,
  waitForElement,
  waitForFirstMatch,
} from "./lib/waitForElement";
import { insertRichText, realisticClick } from "./lib/inject";
import { isSendElement } from "./lib/sendGuard";
import { pickVisibleContainer } from "../shared/diagnostics";

/** Typed "not a failure, just nothing to extract" — the inbox list view. */
class NoEmailOpenError extends Error {
  constructor() {
    super("No email thread is open (inbox list view)");
    this.name = "NoEmailOpenError";
  }
}

/** Typed "the thread is open but Gmail hasn't painted it yet". */
class BodyNotRenderedError extends Error {
  constructor() {
    super("Thread container found, but no message body rendered in time");
    this.name = "BodyNotRenderedError";
  }
}

/**
 * Is this element the one the user is actually looking at?
 *
 * offsetParent is null for display:none subtrees, which is how Gmail parks a
 * view it is no longer showing. The rect check catches the zero-size case
 * (a container that is technically laid out but collapsed).
 */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Resolve the CURRENTLY VISIBLE thread container.
 *
 * FINAL-GATE DEFECT 1 (c): this used to be
 * `document.querySelector('[role="main"]')`, which returns the FIRST match in
 * document order. Gmail is an SPA that keeps previously-rendered views in the
 * DOM, so after switching threads the first [role="main"] can be a stale,
 * hidden view — and extraction cheerfully returned the PREVIOUS email. That
 * is precisely "opening a different email and extracting again doesn't pick
 * up the new thread".
 *
 * Every call re-queries the live DOM. Nothing is cached across calls, at
 * module scope or anywhere else.
 */
function resolveVisibleMain(): HTMLElement | null {
  const mains = [...document.querySelectorAll<HTMLElement>('[role="main"]')];
  return pickVisibleContainer(mains, isVisible);
}

/**
 * Extract the open thread. FULLY STATELESS: every element is re-resolved on
 * every call, scoped to the visible container, and the body is WAITED FOR
 * rather than read optimistically.
 *
 * FINAL-GATE DEFECT 1 (d): the old version awaited only the subject h2 and
 * then read the message body with a synchronous querySelectorAll. Gmail swaps
 * thread content asynchronously, and waitForElement has an immediate-hit
 * check — so right after a thread switch the OLD h2 satisfied the wait
 * instantly and the body was read before the new thread had painted. Now the
 * message container is awaited inside the resolved container.
 */
async function extractOpenThread(): Promise<ExtractedContext> {
  const main = resolveVisibleMain();
  if (!main) throw new NoEmailOpenError();

  // The subject <h2> is the probe: present in thread view, absent in list
  // view. Scoped to `main` so it can never come from a different (stale)
  // view than the body — previously these were two independent
  // document-wide queries that could disagree.
  let subjectEl: HTMLElement;
  try {
    subjectEl = await waitForElement<HTMLElement>("h2", {
      timeoutMs: 1500,
      root: main,
    });
  } catch (err) {
    if (err instanceof TimeoutError) throw new NoEmailOpenError();
    throw err;
  }

  // Wait for the thread's messages to actually exist in THIS container.
  // Longer than the subject probe: this is the async swap we were racing.
  try {
    await waitForElement<HTMLElement>("div[data-message-id]", {
      timeoutMs: 5000,
      root: main,
    });
  } catch (err) {
    if (err instanceof TimeoutError) throw new BodyNotRenderedError();
    throw err;
  }

  // Re-query AFTER the wait: the wait tells us at least one message exists,
  // but we want the full, current list — and Gmail may have added more while
  // we waited. Latest message = last data-message-id container.
  const messages = main.querySelectorAll<HTMLElement>("div[data-message-id]");
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  if (!last) throw new BodyNotRenderedError();

  const senderEl = last.querySelector("span[email]");
  const senderName = senderEl?.textContent?.trim() ?? "";
  const senderAddr = senderEl?.getAttribute("email") ?? "";
  const sender = senderEl
    ? `${senderName}${senderAddr ? ` <${senderAddr}>` : ""}`.trim()
    : null;

  const bodyEl = last.querySelector<HTMLElement>("div.a3s") ?? last;
  const bodyText = bodyEl.innerText.trim();

  // An empty body after all that waiting means we resolved a container that
  // isn't the live thread. Fail loudly rather than persisting a blank
  // "success" — a success state built on a stale reference is what made this
  // defect so confusing to diagnose.
  if (!bodyText) throw new BodyNotRenderedError();

  console.log(
    `[swivel:gmail] extracted "${subjectEl.innerText.trim().slice(0, 60)}" ` +
      `(${bodyText.length} chars, ${messages.length} message(s) in thread)`
  );

  return {
    sourceUrl: location.href,
    subject: subjectEl.innerText.trim(),
    sender,
    bodyText,
  };
}

/**
 * LOCALE FALLBACK — Reply control, structural.
 *
 * Gmail exposes no locale-independent HANDLE for Reply: it is a generic
 * div[role="button"] with no data-testid, sharing its role with dozens of
 * other controls. The only thing that distinguishes it without reading an
 * English string is WHERE it sits — the per-message toolbar inside the last
 * div[data-message-id] — so this is explicitly best-effort.
 *
 * Constraints that keep a wrong match cheap:
 *  - Scoped to the LAST message container, so top-of-page toolbar actions
 *    (archive/delete) are structurally out of reach.
 *  - :not([aria-haspopup]) drops the "More" (⋮) overflow button, the other
 *    tooltip-bearing button in that toolbar.
 *  - isSendElement rejects anything that reads as a Send control. That check
 *    is itself English-biased, but it only ever REJECTS — it can never select
 *    a worse candidate, so a non-English miss is no worse than today.
 *
 * Limits, stated plainly: if Gmail adds or reorders buttons in the message
 * toolbar this can click the wrong one. The failure is benign and visible —
 * a wrong click opens a menu or does nothing, no compose box appears, and the
 * flow fails at the next wait with REPLY_UI_NOT_FOUND. It cannot send.
 */
function replyButtonByPosition(root: ParentNode): Element | null {
  const messages = root.querySelectorAll<HTMLElement>("div[data-message-id]");
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  if (!last) return null;

  const candidates = last.querySelectorAll<HTMLElement>(
    'div[role="button"][data-tooltip]:not([aria-haspopup])'
  );
  for (const el of candidates) {
    if (isSendElement(el)) continue;
    return el;
  }
  return null;
}

/** LOCALE FALLBACK — compose body: the LAST editable textbox on the page.
 *  An inline reply is appended at the bottom of the thread, so when several
 *  editors exist (an unrelated draft already open) the newest is ours. */
function composeBoxLast(root: ParentNode): Element | null {
  const boxes = root.querySelectorAll<HTMLElement>(
    'div[role="textbox"][contenteditable="true"], div[contenteditable="true"]'
  );
  return boxes.length > 0 ? boxes[boxes.length - 1]! : null;
}

/**
 * Draft (never send) a reply on the open thread. Clicks Gmail's Reply
 * control, waits for the compose box (a contenteditable), and inserts the
 * templated reply via insertRichText.
 *
 * SEND-DENIAL LAW: there is deliberately NO code path here that touches
 * Gmail's Send control. Drafting leaves the composed reply in the editor for
 * a human to review and send. Selectors are best-effort against Gmail's
 * obfuscated DOM (verified at GATE 3), anchored on aria/role/data-tooltip.
 *
 * RANKED, NOT COMMA-JOINED: these lists go through waitForFirstMatch, which
 * honours list order. A comma-joined selector would resolve in DOCUMENT order
 * instead, letting a locale fallback outrank the precise English selector on
 * an English UI — the opposite of what a fallback should do.
 *
 * Ranking is English-first by design: the existing selectors are unchanged
 * and still win on an English UI. Everything below them is what keeps the
 * flow alive on a non-English Gmail, where the aria-label/tooltip strings
 * ("Reply", "Message Body") simply do not exist.
 */
async function draftReply(template: string): Promise<void> {
  const reply = await waitForFirstMatch<HTMLElement>(
    [
      // 1-3: English aria/tooltip — unchanged, highest rank.
      'div[role="button"][aria-label^="Reply"]',
      '[data-tooltip^="Reply"]',
      'div[aria-label="Reply"]',
      // 4: locale-independent. Gmail's bottom-of-thread action buttons are
      // .ams, with .bkH=reply, .bkG=reply-all, .bkI=forward. Class-based, so
      // it can churn — but it is the same pragmatic allowance already made
      // for div.a3s above, and it is exact: we never match a bare .ams,
      // because that would risk clicking Forward and drafting into the wrong
      // composer.
      "span.ams.bkH",
      // 5: structural last resort.
      replyButtonByPosition,
    ],
    { timeoutMs: 8000 }
  );
  realisticClick(reply);

  const compose = await waitForFirstMatch<HTMLElement>(
    [
      // 1-3: existing order preserved. #2 is already locale-independent, so
      // the compose box was never the weak link — the Reply button was.
      'div[role="textbox"][aria-label*="Body"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label="Message Body"][contenteditable="true"]',
      // 4: Gmail's editor container class, locale-independent.
      'div.editable[contenteditable="true"]',
      // 5: structural last resort.
      composeBoxLast,
    ],
    { timeoutMs: 8000 }
  );
  insertRichText(compose, template);
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: SwivelMessage) => void
  ): boolean | undefined => {
    if (!isSwivelMessage(message)) return undefined;

    switch (message.type) {
      case "DRAFT_REPLY": {
        (async () => {
          try {
            await draftReply(message.template);
            sendResponse({ type: "DRAFT_REPLY_DONE", ok: true, errorCode: null });
          } catch (err) {
            sendResponse({
              type: "DRAFT_REPLY_DONE",
              ok: false,
              errorCode: err instanceof TimeoutError ? "REPLY_UI_NOT_FOUND" : "DRAFT_FAILED",
            });
          }
        })();
        return true;
      }

      case "PING": {
        sendResponse({
          type: "PONG",
          hops: [...message.hops, `gmail(${location.hostname})`],
        });
        return undefined;
      }

      case "EXTRACT_REQUEST": {
        (async () => {
          try {
            const context = await extractOpenThread();
            sendResponse({
              type: "EXTRACT_RESULT",
              ok: true,
              context,
              errorCode: null,
            });
          } catch (err) {
            // Every failure names itself, in the page console AND as a typed
            // code — no silent empty result (cross-cutting gate requirement).
            console.error("[swivel:gmail] extraction failed", err);
            const errorCode =
              err instanceof NoEmailOpenError
                ? "NO_EMAIL_OPEN"
                : err instanceof BodyNotRenderedError
                  ? "GMAIL_BODY_NOT_RENDERED"
                  : "GMAIL_EXTRACT_FAILED";
            sendResponse({
              type: "EXTRACT_RESULT",
              ok: false,
              context: null,
              errorCode,
            });
          }
        })();
        // Async sendResponse — same `return true` channel rule as the hub.
        return true;
      }

      default:
        return undefined;
    }
  }
);

console.log("[swivel:gmail] extractor loaded");
