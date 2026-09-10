/**
 * src/content/lib/waitForElement.ts
 *
 * The ONLY sanctioned way Swivel content scripts touch the DOM (Charter
 * Law 4). SPAs render asynchronously: at the moment our recipe wants to
 * fill a field, that field may not exist yet — or may exist inside a modal
 * that is still animating in. A bare querySelector returns null and the
 * automation dies with an unhelpful TypeError.
 *
 * waitForElement turns "the element will exist soon" into an awaitable:
 *   1. Immediate-hit check: if the element is already in the DOM, resolve
 *      synchronously — no observer churn on the happy path.
 *   2. Otherwise, a MutationObserver on `root` (childList + subtree)
 *      re-queries on every DOM change until the selector matches.
 *   3. A timeout (default 10s) rejects with a typed TimeoutError, so
 *      callers can distinguish "recipe selector is stale" from other
 *      failures and report WHICH selector failed.
 *   4. An optional AbortSignal lets one controller cancel every pending
 *      wait in an automation run at once (used when a run fails midway or
 *      the user navigates — Phase 6/7).
 *
 * The observer is ALWAYS disconnected — on resolve, reject, or abort — so
 * a long-lived content script in a busy SPA never accumulates orphaned
 * observers.
 */

/** Typed failure: the selector did not match within timeoutMs. */
export class TimeoutError extends Error {
  readonly selector: string;
  readonly timeoutMs: number;

  constructor(selector: string, timeoutMs: number) {
    super(`waitForElement: "${selector}" did not appear within ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.selector = selector;
    this.timeoutMs = timeoutMs;
  }
}

/** Typed failure: the run's AbortSignal fired while waiting. */
export class WaitAbortedError extends Error {
  readonly selector: string;

  constructor(selector: string) {
    super(`waitForElement: wait for "${selector}" was aborted`);
    this.name = "WaitAbortedError";
    this.selector = selector;
  }
}

export interface WaitOptions {
  /** Reject with TimeoutError after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Subtree to observe. Default document.body. Narrowing the root (e.g.,
   *  to an already-found modal) cuts observer callback noise in busy SPAs. */
  root?: Element | Document;
  /** Cancel this wait (and its observer/timer) externally. */
  signal?: AbortSignal;
}

/**
 * Resolve with the first element matching `selector`, now or in the
 * future. Generic over the element type so call sites keep strong typing:
 *   const input = await waitForElement<HTMLInputElement>('input[name=q]');
 */
export function waitForElement<T extends Element = Element>(
  selector: string,
  { timeoutMs = 10_000, root = document.body, signal }: WaitOptions = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Pre-aborted signal: settle before doing any work.
    if (signal?.aborted) {
      reject(new WaitAbortedError(selector));
      return;
    }

    // 1) Immediate hit — the common case once a page has settled.
    const existing = (root instanceof Document ? root : root).querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Single cleanup path: whichever way this promise settles, the
    // observer, the timer, and the abort listener are all released.
    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new WaitAbortedError(selector));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    // 2) Observe. We re-query on each batch of mutations rather than
    // inspecting mutation records: records tell you a node was added, not
    // whether ANY node now matches an arbitrary selector — re-querying is
    // simpler and correct (e.g., matches caused by attribute changes on
    // pre-existing nodes are caught via the attributes flag below).
    observer = new MutationObserver(() => {
      const found = (root instanceof Document ? root : root).querySelector<T>(selector);
      if (found) {
        cleanup();
        resolve(found);
      }
    });

    observer.observe(root instanceof Document ? root.documentElement : root, {
      childList: true,
      subtree: true,
      attributes: true, // selectors like [aria-expanded="true"] flip via attributes
    });

    // 3) Deadline.
    timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(selector, timeoutMs));
    }, timeoutMs);
  });
}

/**
 * A single way to find an element: a CSS selector, or a function for matches
 * CSS can't express (position within a container, attribute-shape filtering).
 */
export type MatchStrategy =
  | string
  | ((root: ParentNode) => Element | null | undefined);

/** Minimal root shape resolveInOrder needs — keeps it unit-testable in node. */
export interface QueryRoot {
  querySelector(selectors: string): Element | null;
}

/** Human-readable name for a strategy, for TimeoutError messages. */
function describeStrategy(s: MatchStrategy): string {
  return typeof s === "string" ? s : `<fn:${s.name || "anonymous"}>`;
}

/**
 * Try each strategy IN ORDER and return the first hit.
 *
 * WHY this exists: `querySelector("a, b, c")` returns the first match in
 * DOCUMENT order, not list order — so a comma-separated fallback list gives
 * you no control over which branch wins. When fallbacks are ranked (a precise
 * selector first, a best-effort heuristic last) that difference matters, so
 * ranked lookups must resolve sequentially instead.
 *
 * A throwing strategy is treated as "no match": one bad heuristic must never
 * take down the whole lookup.
 *
 * Pure and root-agnostic (only needs querySelector), so the ordering
 * guarantee is unit-tested without a DOM.
 */
export function resolveInOrder<T extends Element = Element>(
  strategies: readonly MatchStrategy[],
  root: QueryRoot
): T | null {
  for (const strategy of strategies) {
    try {
      const hit =
        typeof strategy === "string"
          ? root.querySelector(strategy)
          : strategy(root as unknown as ParentNode);
      if (hit) return hit as T;
    } catch {
      // Malformed selector or a heuristic that threw — skip to the next.
    }
  }
  return null;
}

/**
 * waitForElement, but over a RANKED list of strategies (see resolveInOrder).
 * Same contract otherwise: immediate-hit check, MutationObserver, typed
 * TimeoutError, abort support, guaranteed cleanup.
 *
 * Note on ranking vs. timing: each pass returns the highest-ranked strategy
 * that matches AT THAT MOMENT. If a low-ranked element is already present and
 * a high-ranked one would appear 200ms later, the low-ranked one wins — the
 * alternative (waiting out the full timeout to see if something better shows
 * up) would cost seconds on every happy path. Rank is a tiebreak among what
 * currently exists, not a promise about the future.
 */
export function waitForFirstMatch<T extends Element = Element>(
  strategies: readonly MatchStrategy[],
  { timeoutMs = 10_000, root = document.body, signal }: WaitOptions = {}
): Promise<T> {
  const label = strategies.map(describeStrategy).join(" || ");

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitAbortedError(label));
      return;
    }

    const queryRoot = (root instanceof Document ? root : root) as QueryRoot;

    const existing = resolveInOrder<T>(strategies, queryRoot);
    if (existing) {
      resolve(existing);
      return;
    }

    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new WaitAbortedError(label));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    observer = new MutationObserver(() => {
      const found = resolveInOrder<T>(strategies, queryRoot);
      if (found) {
        cleanup();
        resolve(found);
      }
    });

    observer.observe(root instanceof Document ? root.documentElement : root, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
}

/**
 * The inverse: resolve once NO element matches `selector` — used to await
 * spinners disappearing or modals closing before the next step. Same
 * contract: immediate-hit check, observer, typed timeout, abort support.
 */
export function waitForElementGone(
  selector: string,
  { timeoutMs = 10_000, root = document.body, signal }: WaitOptions = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitAbortedError(selector));
      return;
    }

    const query = () =>
      (root instanceof Document ? root : root).querySelector(selector);

    if (!query()) {
      resolve();
      return;
    }

    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new WaitAbortedError(selector));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    observer = new MutationObserver(() => {
      if (!query()) {
        cleanup();
        resolve();
      }
    });

    observer.observe(root instanceof Document ? root.documentElement : root, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(selector, timeoutMs));
    }, timeoutMs);
  });
}
