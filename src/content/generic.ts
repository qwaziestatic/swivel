/**
 * src/content/generic.ts — the on-demand generic extractor (generic.js).
 *
 * NOT manifest-registered, on purpose: we can't enumerate every internal
 * portal, and blanket host patterns would violate least privilege
 * (Charter Law 7). Instead the hub injects this file with
 * chrome.scripting.executeScript({ files: ["generic.js"] }), riding either
 * a declared host permission (Atlassian/Salesforce) or the temporary
 * activeTab grant created when the user invoked Swivel on the tab (action
 * click / keyboard command). If neither applies, executeScript throws in
 * the hub and the panel renders NO_ACTIVE_TAB_GRANT as instructions.
 *
 * DOUBLE-INJECTION GUARD: the hub injects on every extract (it can't know
 * whether we're already here), and executeScript happily runs the same
 * file twice. A window-scoped flag makes the second run a no-op — without
 * it we'd stack duplicate onMessage listeners and race our own
 * sendResponse.
 */

import { isSwivelMessage, type SwivelMessage } from "../shared/messages";

declare global {
  interface Window {
    __swivelGenericLoaded?: boolean;
  }
}

/**
 * Pre-cap well above cleanText's 8k final cap: this only exists to keep a
 * multi-megabyte innerText from a giant page out of the message channel.
 * Real hygiene (and the visible truncation marker) happens in the hub.
 */
const PRE_CAP = 20_000;

function mainContentText(): string {
  // Tier 1: semantic landmarks. Any page with basic a11y gives us these.
  const landmark = document.querySelector<HTMLElement>(
    'main, [role="main"], article'
  );
  if (landmark && landmark.innerText.trim().length > 0) {
    return landmark.innerText;
  }

  // Tier 2: largest-text-block drill-down. Starting at <body>, repeatedly
  // descend into the child that carries ≥60% of the visible text; stop when
  // text is spread across siblings (that node is the content region). The
  // depth bound is a hard stop against pathological DOM nesting.
  let node: HTMLElement = document.body;
  for (let depth = 0; depth < 25; depth++) {
    const total = node.innerText.length || 1;
    let best: HTMLElement | null = null;
    let bestLen = 0;
    for (const child of Array.from(node.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const len = child.innerText.length;
      if (len >= total * 0.6 && len > bestLen) {
        best = child;
        bestLen = len;
      }
    }
    if (!best) break;
    node = best;
  }
  return node.innerText;
}

if (!window.__swivelGenericLoaded) {
  window.__swivelGenericLoaded = true;

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: SwivelMessage) => void
    ): undefined => {
      if (!isSwivelMessage(message)) return undefined;
      // Only EXTRACT_REQUEST — PING stays with the manifest-registered
      // scripts, so this listener can't shadow their responses on domains
      // (Atlassian/Salesforce) where both scripts coexist.
      if (message.type !== "EXTRACT_REQUEST") return undefined;

      try {
        sendResponse({
          type: "EXTRACT_RESULT",
          ok: true,
          context: {
            sourceUrl: location.href,
            subject: document.title || null,
            sender: null, // no meaningful sender on an arbitrary page
            bodyText: mainContentText().slice(0, PRE_CAP),
          },
          errorCode: null,
        });
      } catch {
        sendResponse({
          type: "EXTRACT_RESULT",
          ok: false,
          context: null,
          errorCode: "EXTRACT_FAILED",
        });
      }
      return undefined; // synchronous response — no `return true` needed
    }
  );

  console.log("[swivel:generic] extractor injected on", location.hostname);
}
