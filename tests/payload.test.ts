import { describe, expect, it } from "vitest";
import {
  parseLlmPayload,
  swivelPayloadSchema,
  toSwivelPayload,
} from "../src/shared/payload";

const validJson = JSON.stringify({
  ticket_title: "Login page 500s on submit",
  customer_id: "ACME-42",
  priority: "high",
  summary: "Users can't log in; the submit button returns a 500.",
  action_items: ["Reproduce on staging", "Check auth service logs"],
});

describe("parseLlmPayload", () => {
  it("accepts a well-formed response", () => {
    const r = parseLlmPayload(validJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ticket_title).toBe("Login page 500s on submit");
      expect(r.value.priority).toBe("high");
      expect(r.value.action_items).toHaveLength(2);
    }
  });

  it("normalizes a missing customer_id to null", () => {
    const r = parseLlmPayload(
      JSON.stringify({
        ticket_title: "T",
        priority: "low",
        summary: "S",
        action_items: [],
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.customer_id).toBeNull();
  });

  it("normalizes an empty-string customer_id to null", () => {
    const r = parseLlmPayload(
      JSON.stringify({
        ticket_title: "T",
        customer_id: "",
        priority: "low",
        summary: "S",
        action_items: [],
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.customer_id).toBeNull();
  });

  it("defaults action_items to [] when absent", () => {
    const r = parseLlmPayload(
      JSON.stringify({ ticket_title: "T", priority: "medium", summary: "S" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action_items).toEqual([]);
  });

  it("rejects non-JSON", () => {
    const r = parseLlmPayload("not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/i);
  });

  it("rejects an invalid priority enum with a field-keyed error", () => {
    const r = parseLlmPayload(
      JSON.stringify({
        ticket_title: "T",
        priority: "SUPER_URGENT",
        summary: "S",
        action_items: [],
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("priority");
  });

  it("rejects a missing required field (summary)", () => {
    const r = parseLlmPayload(
      JSON.stringify({ ticket_title: "T", priority: "low", action_items: [] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("summary");
  });
});

describe("toSwivelPayload", () => {
  it("merges the hub-supplied source_url onto the LLM fields", () => {
    const r = parseLlmPayload(validJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const full = toSwivelPayload(r.value, "https://mail.google.com/x");
      expect(full.source_url).toBe("https://mail.google.com/x");
      // Full payload round-trips through the full schema.
      expect(swivelPayloadSchema.safeParse(full).success).toBe(true);
    }
  });
});
