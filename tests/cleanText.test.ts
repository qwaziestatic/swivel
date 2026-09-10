import { describe, expect, it } from "vitest";
import {
  MAX_CHARS,
  TRUNCATION_MARKER,
  cleanEmailText,
  collapseWhitespace,
  stripLegalFooter,
  stripQuotedHistory,
  stripSignature,
  truncateWithMarker,
} from "../src/shared/cleanText";

describe("stripQuotedHistory", () => {
  it("cuts at a Gmail-style 'On ... wrote:' header", () => {
    const input =
      "Please review the attached invoice.\n\n" +
      "On Mon, Jul 13, 2026 at 9:02 AM Jane Doe <jane@example.com> wrote:\n" +
      "> earlier message\n> more quoted text";
    // Trailing newlines survive here by design — collapsing whitespace is
    // a separate stage (collapseWhitespace), so trim before comparing.
    expect(stripQuotedHistory(input).trim()).toBe("Please review the attached invoice.");
  });

  it("cuts at an Outlook 'Original Message' divider", () => {
    const input =
      "New content here.\n" +
      "-----Original Message-----\n" +
      "From: old@example.com\nSubject: RE: old thread";
    expect(stripQuotedHistory(input).trim()).toBe("New content here.");
  });

  it("drops line-quoted remnants (> prefixed lines)", () => {
    const input = "Top reply.\n> quoted line one\n> quoted line two\nMore top content.";
    const result = stripQuotedHistory(input);
    expect(result).not.toContain(">");
    expect(result).toContain("Top reply.");
    expect(result).toContain("More top content.");
  });

  it("leaves plain text with no quote markers untouched", () => {
    const input = "Just a normal short email with no history.";
    expect(stripQuotedHistory(input)).toBe(input);
  });
});

describe("stripSignature", () => {
  it("cuts at the RFC 3676 '-- ' delimiter", () => {
    const input = "Thanks for the update.\n--\nJane Doe\nSenior Engineer";
    expect(stripSignature(input)).toBe("Thanks for the update.\n");
  });

  it("cuts at a 'Sent from my iPhone' mobile signature", () => {
    const input = "On my way.\n\nSent from my iPhone";
    expect(stripSignature(input)).toBe("On my way.\n\n");
  });
});

describe("stripLegalFooter", () => {
  it("cuts a trailing confidentiality notice", () => {
    const body = "Here is the summary you asked for.";
    const footer =
      "\n\nCONFIDENTIALITY NOTICE: This email and any attachments is confidential " +
      "and intended solely for the addressee.";
    expect(stripLegalFooter(body + footer).trim()).toBe(body);
  });

  it("does not cut when the disclaimer phrase is genuine early content", () => {
    // The trigger phrase appears in the first half of the text, which the
    // heuristic treats as real content rather than a trailing footer.
    const input =
      "CONFIDENTIALITY NOTICE policies at our firm require every outbound " +
      "message to carry one, so let's discuss updating our template. ".repeat(3) +
      "That's the whole ask.";
    expect(stripLegalFooter(input)).toBe(input);
  });
});

describe("collapseWhitespace", () => {
  it("normalizes CRLF, trims trailing spaces, and collapses blank-line runs", () => {
    const input = "Line one.   \r\nLine two.\r\n\r\n\r\n\r\nLine three.";
    expect(collapseWhitespace(input)).toBe("Line one.\nLine two.\n\nLine three.");
  });
});

describe("truncateWithMarker", () => {
  it("passes short text through unchanged", () => {
    expect(truncateWithMarker("short")).toBe("short");
  });

  it("caps at maxChars and appends the visible marker", () => {
    const input = "x".repeat(MAX_CHARS + 500);
    const result = truncateWithMarker(input);
    expect(result.startsWith("x".repeat(MAX_CHARS))).toBe(true);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.length).toBe(MAX_CHARS + TRUNCATION_MARKER.length);
  });
});

describe("cleanEmailText (full pipeline)", () => {
  it("strips quoted history, signature, and footer, then collapses whitespace", () => {
    const input =
      "Can you approve this by Friday?\n" +
      "--\n" +
      "Jane Doe\n\n" +
      "On Mon, Jul 13, 2026 at 9:02 AM John Smith <john@example.com> wrote:\n" +
      "> original request text";
    const result = cleanEmailText(input);
    expect(result).toBe("Can you approve this by Friday?");
  });

  it("marks truncation explicitly when the cleaned body exceeds 8k chars", () => {
    const input = "word ".repeat(3000); // well over MAX_CHARS, no strip markers present
    const result = cleanEmailText(input);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_CHARS + TRUNCATION_MARKER.length);
  });
});
