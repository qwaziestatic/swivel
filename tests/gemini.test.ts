import { describe, expect, it, vi } from "vitest";
import { synthesize } from "../src/background/gemini";
import type { ExtractedContext } from "../src/shared/messages";

const CTX: ExtractedContext = {
  sourceUrl: "https://mail.google.com/mail/u/0/#inbox/x",
  subject: "Login 500 on submit",
  sender: "Jane <jane@acme.test>",
  bodyText: "Users report a 500 when submitting the login form. Please prioritize.",
};

const VALID = JSON.stringify({
  ticket_title: "Login page 500s on submit",
  customer_id: "ACME-42",
  priority: "high",
  summary: "Submit returns a 500; users cannot log in.",
  action_items: ["Repro on staging"],
});

/** Build a Gemini-shaped generateContent response. */
function geminiResponse(text: string, status = 200): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("synthesize (mocked fetch)", () => {
  it("returns NO_API_KEY without calling fetch when the key is empty", async () => {
    const fetchImpl = vi.fn();
    const r = await synthesize(CTX, "   ", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NO_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("happy path: one call, valid JSON → validated payload", async () => {
    const fetchImpl = vi.fn(async () => geminiResponse(VALID));
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.priority).toBe("high");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the key as a header, never in the URL", async () => {
    const fetchImpl = vi.fn(async () => geminiResponse(VALID));
    await synthesize(CTX, "secret-key-123", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain("secret-key-123");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("secret-key-123");
  });

  it("malformed JSON → one repair retry → success (exactly two calls)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return geminiResponse(call === 1 ? "{ this is not valid json" : VALID);
    });
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("repair also fails → typed SYNTHESIS_SCHEMA (two calls, no third)", async () => {
    // Renamed from SYNTHESIS_ERROR when the taxonomy was split after the
    // final-gate defects: "the model's JSON didn't validate" now has its own
    // code, distinct from transport/auth/model failures that used to share it.
    const fetchImpl = vi.fn(async () => geminiResponse("{ still broken"));
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SYNTHESIS_SCHEMA");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("schema-invalid content → repair → success", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First response is valid JSON but a bad enum; repair returns valid.
      return geminiResponse(
        call === 1
          ? JSON.stringify({
              ticket_title: "T",
              priority: "WHENEVER",
              summary: "S",
              action_items: [],
            })
          : VALID
      );
    });
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("HTTP 403 → SYNTHESIS_AUTH and does NOT trigger the repair retry", async () => {
    const fetchImpl = vi.fn(async () => geminiResponse("forbidden", 403));
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SYNTHESIS_AUTH");
    // A rejected key won't fix itself on retry — one call only.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 → SYNTHESIS_RATE_LIMIT", async () => {
    const fetchImpl = vi.fn(async () => geminiResponse("slow down", 429));
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SYNTHESIS_RATE_LIMIT");
  });

  it("aborts on timeout → SYNTHESIS_TIMEOUT", async () => {
    // Never resolves on its own; only settles when the AbortController fires.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    const r = await synthesize(CTX, "key", { fetchImpl: hangingFetch, timeoutMs: 40 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SYNTHESIS_TIMEOUT");
  });

  it("network rejection → SYNTHESIS_NETWORK", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await synthesize(CTX, "key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SYNTHESIS_NETWORK");
  });
});
