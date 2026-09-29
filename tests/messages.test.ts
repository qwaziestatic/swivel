import { describe, expect, it } from "vitest";
import { isExtractedContext } from "../src/shared/messages";

const validContext = {
  sourceUrl: "https://mail.google.com/mail/u/0/#inbox/abc",
  subject: "Customer issue",
  sender: "Customer <customer@example.com>",
  bodyText: "The customer cannot sign in.",
};

describe("isExtractedContext", () => {
  it("accepts a valid HTTPS context", () => {
    expect(isExtractedContext(validContext)).toBe(true);
  });

  it("accepts an HTTP context for local or development sources", () => {
    expect(isExtractedContext({ ...validContext, sourceUrl: "http://localhost:4599/" })).toBe(
      true
    );
  });

  it("rejects non-web source URLs", () => {
    expect(isExtractedContext({ ...validContext, sourceUrl: "javascript:alert(1)" })).toBe(false);
  });

  it("rejects oversized body text", () => {
    expect(isExtractedContext({ ...validContext, bodyText: "x".repeat(100_001) })).toBe(false);
  });

  it("rejects oversized metadata", () => {
    expect(isExtractedContext({ ...validContext, subject: "x".repeat(1_001) })).toBe(false);
    expect(isExtractedContext({ ...validContext, sender: "x".repeat(1_001) })).toBe(false);
    expect(isExtractedContext({ ...validContext, sourceUrl: `https://example.com/${"x".repeat(2041)}` })).toBe(
      false
    );
  });
});
