import { describe, expect, it } from "vitest";
import {
  isSendElement,
  looksLikeSendSelector,
  type SendCheckable,
} from "../src/content/lib/sendGuard";

/** Minimal stand-in for an element the guard inspects. */
function el(attrs: Record<string, string>, text = ""): SendCheckable {
  return {
    getAttribute: (n: string) => attrs[n] ?? null,
    textContent: text,
  };
}

describe("looksLikeSendSelector", () => {
  it("flags selectors that name a Send control", () => {
    expect(looksLikeSendSelector('[aria-label="Send"]')).toBe(true);
    expect(looksLikeSendSelector('[aria-label="Send \u202A(Ctrl+Enter)\u202C"]')).toBe(true);
    expect(looksLikeSendSelector('[data-tooltip*="Send"]')).toBe(true);
    expect(looksLikeSendSelector('button:has-text("Send")')).toBe(true);
  });

  it("does not flag ordinary target selectors", () => {
    expect(looksLikeSendSelector('[data-testid="submit-button"]')).toBe(false);
    expect(looksLikeSendSelector('input[name="summary"]')).toBe(false);
    expect(looksLikeSendSelector('[aria-label="Reply"]')).toBe(false);
    // "resend"/"sender" shouldn't false-positive on the aria-label form
    expect(looksLikeSendSelector('[data-testid="sender-name"]')).toBe(false);
  });
});

describe("isSendElement", () => {
  it("flags an element whose accessible name is Send (even via opaque class)", () => {
    expect(isSendElement(el({ "aria-label": "Send", class: "T-I-atl" }))).toBe(true);
    expect(isSendElement(el({ "data-tooltip": "Send (Ctrl+Enter)" }))).toBe(true);
    expect(isSendElement(el({ role: "button" }, "Send"))).toBe(true);
  });

  it("does not flag ordinary controls", () => {
    expect(isSendElement(el({ "aria-label": "Reply" }))).toBe(false);
    expect(isSendElement(el({ "aria-label": "Create issue" }))).toBe(false);
    expect(isSendElement(el({ role: "button" }, "Submit"))).toBe(false);
  });
});
