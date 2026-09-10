/**
 * tests/diagnostics.test.ts — the final-gate defect logic that CAN be tested
 * without a browser.
 *
 * What these lock down:
 *  - classifyHttpStatus: a user must be told "fix your key" vs "fix your
 *    model" vs "wait" — Gemini answers the first two with the SAME 400, so
 *    status alone is not enough and the body has to be consulted.
 *  - classifyFetchFailure: the granted-but-blocked origin (defect 3) must not
 *    be reported as "you're offline".
 *  - pickVisibleContainer: stale-view selection (defect 1c) — the reason a
 *    second extraction returned the FIRST email.
 */

import { describe, it, expect } from "vitest";
import {
  classifyFetchFailure,
  classifyHttpStatus,
  pickVisibleContainer,
} from "../src/shared/diagnostics";

describe("classifyHttpStatus", () => {
  it("calls a 400 with an API-key body an AUTH problem", () => {
    // Real Gemini shape for a bad key.
    const body = JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
    });
    expect(classifyHttpStatus(400, body)).toBe("SYNTHESIS_AUTH");
  });

  it("calls a 400 with a model body a MODEL problem — same status, different fix", () => {
    const body = JSON.stringify({
      error: { code: 400, message: "models/gemini-does-not-exist is not found", status: "INVALID_ARGUMENT" },
    });
    expect(classifyHttpStatus(400, body)).toBe("SYNTHESIS_MODEL");
  });

  it("falls back to BAD_REQUEST for a 400 it cannot attribute", () => {
    expect(classifyHttpStatus(400, "something unexpected")).toBe("SYNTHESIS_BAD_REQUEST");
  });

  it("treats 404 as an unknown model", () => {
    const body = "models/gemini-2.0-retired is not found for API version v1beta";
    expect(classifyHttpStatus(404, body)).toBe("SYNTHESIS_MODEL");
  });

  it("maps 401/403 to AUTH and 429 to RATE_LIMIT", () => {
    expect(classifyHttpStatus(401, "")).toBe("SYNTHESIS_AUTH");
    expect(classifyHttpStatus(403, "")).toBe("SYNTHESIS_AUTH");
    expect(classifyHttpStatus(429, "RESOURCE_EXHAUSTED")).toBe("SYNTHESIS_RATE_LIMIT");
  });

  it("maps 5xx to SERVER (their fault, retry) not HTTP (unknown)", () => {
    expect(classifyHttpStatus(500, "")).toBe("SYNTHESIS_SERVER");
    expect(classifyHttpStatus(503, "")).toBe("SYNTHESIS_SERVER");
  });

  it("is case-insensitive about the error body", () => {
    expect(classifyHttpStatus(400, "API KEY NOT VALID")).toBe("SYNTHESIS_AUTH");
  });
});

describe("classifyFetchFailure", () => {
  it("blames the site-access toggle when the origin IS granted (defect 3)", () => {
    // This is the exact gate state: permission granted, per-site toggle off,
    // request blocked before it leaves the worker.
    expect(classifyFetchFailure("Failed to fetch", true)).toBe("GEMINI_ORIGIN_BLOCKED");
  });

  it("blames the network when the origin is NOT granted", () => {
    expect(classifyFetchFailure("Failed to fetch", false)).toBe("SYNTHESIS_NETWORK");
  });

  it("detects an abort as a timeout regardless of grant state", () => {
    expect(classifyFetchFailure("The user aborted a request.", true)).toBe("SYNTHESIS_TIMEOUT");
    expect(classifyFetchFailure("AbortError", false)).toBe("SYNTHESIS_TIMEOUT");
  });

  it("does not claim blockage for a non-opaque error", () => {
    expect(classifyFetchFailure("getaddrinfo ENOTFOUND", true)).toBe("SYNTHESIS_NETWORK");
  });
});

describe("pickVisibleContainer", () => {
  const visible = { id: "visible" };
  const hidden = { id: "hidden" };
  const isVisible = (el: { id: string }) => el.id === "visible";

  it("skips a stale hidden container that comes FIRST in document order", () => {
    // The defect-1 case: Gmail keeps the previous thread's view in the DOM,
    // and it sorts before the live one. querySelector would return `hidden`.
    expect(pickVisibleContainer([hidden, visible], isVisible)).toBe(visible);
  });

  it("returns the visible one when it is already first", () => {
    expect(pickVisibleContainer([visible, hidden], isVisible)).toBe(visible);
  });

  it("returns null when there are no candidates", () => {
    expect(pickVisibleContainer([], isVisible)).toBeNull();
  });

  it("falls back to the LAST candidate when none report visible", () => {
    // Mid-transition, nothing has layout yet. Gmail appends newer views, so
    // the newest is a better guess than the stalest.
    const a = { id: "old" };
    const b = { id: "new" };
    expect(pickVisibleContainer([a, b], isVisible)).toBe(b);
  });

  it("never returns a hidden container when a visible one exists anywhere", () => {
    const many = [hidden, hidden, visible, hidden];
    expect(pickVisibleContainer(many, isVisible)).toBe(visible);
  });
});
