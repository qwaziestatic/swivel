/**
 * tests/resolveInOrder.test.ts
 *
 * Locks the ONE guarantee the Gmail locale fallbacks depend on: ranked
 * lookups resolve in LIST order, not document order.
 *
 * This is the regression that would be invisible otherwise. If someone ever
 * "simplifies" the ranked list back into a comma-joined selector, English
 * Gmail would start resolving by document position and a best-effort locale
 * heuristic could outrank the precise selector. These tests fail loudly if
 * that happens.
 *
 * No jsdom in this project (vitest environment is "node"), so we stub the
 * only method resolveInOrder needs: querySelector.
 */

import { describe, it, expect } from "vitest";
import {
  resolveInOrder,
  type MatchStrategy,
  type QueryRoot,
} from "../src/content/lib/waitForElement";

/** A fake root where each selector maps to a sentinel "element". */
function rootWith(map: Record<string, unknown>): QueryRoot {
  return {
    querySelector: (sel: string) => (map[sel] ?? null) as Element | null,
  };
}

describe("resolveInOrder", () => {
  it("returns the FIRST strategy that matches, not the first in the map", () => {
    const preferred = { tag: "preferred" };
    const fallback = { tag: "fallback" };
    const root = rootWith({ ".preferred": preferred, ".fallback": fallback });

    expect(resolveInOrder([".preferred", ".fallback"], root)).toBe(preferred);
  });

  it("honours rank even when a lower-ranked strategy also matches", () => {
    // The real-world case: on English Gmail BOTH the aria selector and the
    // locale fallback match. Rank must decide, not document position.
    const aria = { tag: "aria" };
    const localeFallback = { tag: "locale" };
    const root = rootWith({
      'div[role="button"][aria-label^="Reply"]': aria,
      "span.ams.bkH": localeFallback,
    });

    const ranked: MatchStrategy[] = [
      'div[role="button"][aria-label^="Reply"]',
      "span.ams.bkH",
    ];
    expect(resolveInOrder(ranked, root)).toBe(aria);
  });

  it("falls through to a lower-ranked strategy when higher ones miss", () => {
    // The non-English case: the aria/tooltip strings do not exist at all.
    const localeFallback = { tag: "locale" };
    const root = rootWith({ "span.ams.bkH": localeFallback });

    const ranked: MatchStrategy[] = [
      'div[role="button"][aria-label^="Reply"]',
      '[data-tooltip^="Reply"]',
      "span.ams.bkH",
    ];
    expect(resolveInOrder(ranked, root)).toBe(localeFallback);
  });

  it("supports function strategies for matches CSS cannot express", () => {
    const positional = { tag: "positional" };
    const root = rootWith({});

    expect(resolveInOrder([".nope", () => positional as never], root)).toBe(
      positional
    );
  });

  it("treats a THROWING strategy as a miss and continues", () => {
    // One bad heuristic must never take down the whole lookup.
    const fallback = { tag: "fallback" };
    const root = rootWith({ ".fallback": fallback });
    const explode: MatchStrategy = () => {
      throw new Error("bad heuristic");
    };

    expect(resolveInOrder([explode, ".fallback"], root)).toBe(fallback);
  });

  it("returns null when nothing matches", () => {
    expect(resolveInOrder([".a", ".b"], rootWith({}))).toBeNull();
  });

  it("ignores a strategy that returns undefined", () => {
    const fallback = { tag: "fallback" };
    const root = rootWith({ ".fallback": fallback });
    expect(resolveInOrder([() => undefined, ".fallback"], root)).toBe(fallback);
  });
});
