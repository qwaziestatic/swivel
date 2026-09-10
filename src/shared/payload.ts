/**
 * src/shared/payload.ts — zod schemas for the structured payload.
 *
 * The LLM is UNTRUSTED INPUT (Charter): its JSON is validated here before
 * it is persisted to storage.session or broadcast to the panel. Gemini's
 * responseSchema constrains the shape server-side, but "the model claimed
 * to follow a schema" is not "the bytes parsed clean" — we verify, we
 * don't trust. A validation failure drives the one repair retry in
 * gemini.ts; a second failure becomes a typed SYNTHESIS_ERROR.
 *
 * Field split: the MODEL produces five fields (ticket_title, customer_id,
 * priority, summary, action_items). source_url is NOT model output — it is
 * the provenance of the extraction, injected by the hub. Keeping it out of
 * the LLM schema means the model can't fabricate or overwrite where the
 * context came from.
 */

import { z } from "zod";
import type { SwivelPayload, SwivelPriority } from "./messages";

export const PRIORITY_VALUES = ["low", "medium", "high", "urgent"] as const;

/** The five fields Gemini returns. Bounded lengths keep a pathological
 *  model response from bloating storage or the panel. */
export const llmPayloadSchema = z.object({
  ticket_title: z.string().min(1).max(300),
  // Gemini may emit null, an empty string, or omit it — normalize the
  // "no customer" cases to null so downstream code has one empty value.
  customer_id: z
    .union([z.string().max(120), z.null()])
    .optional()
    .transform((v) => (v == null || v === "" ? null : v)),
  priority: z.enum(PRIORITY_VALUES),
  summary: z.string().min(1).max(4000),
  action_items: z.array(z.string().min(1).max(500)).max(50).default([]),
});

export type LlmPayload = z.infer<typeof llmPayloadSchema>;

/**
 * Full payload schema (LLM fields + hub-supplied source_url). Used to
 * re-validate edits coming back from the panel (Phase 4) — the panel is
 * our own code, but PAYLOAD_EDIT still crosses a boundary and gets the
 * same treatment as any other input.
 */
export const swivelPayloadSchema = llmPayloadSchema.extend({
  source_url: z.string(),
});

// Parity guard on the OUTPUT type: the PARSED result must equal
// SwivelPayload in both directions. We check z.infer (the output) rather
// than `satisfies z.ZodType<SwivelPayload>` because zod's INPUT type for
// customer_id/action_items admits `undefined` (from .optional()/.default())
// — harmless at runtime, but it would make the stricter satisfies-check
// fail. If messages.ts and this schema ever diverge, this line stops
// compiling.
type _ParsedParity =
  z.infer<typeof swivelPayloadSchema> extends SwivelPayload
    ? SwivelPayload extends z.infer<typeof swivelPayloadSchema>
      ? true
      : never
    : never;
const _parsedParity: _ParsedParity = true;
void _parsedParity;

/**
 * Parse untrusted LLM text into an LlmPayload. Returns a discriminated
 * result rather than throwing, so gemini.ts can feed the error string back
 * to the model on the repair attempt without a try/catch dance.
 */
export type ParseResult =
  | { ok: true; value: LlmPayload }
  | { ok: false; error: string };

export function parseLlmPayload(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = llmPayloadSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  // zod's flatten gives compact, model-readable field errors for the repair
  // prompt (far better than the default nested issue dump).
  return { ok: false, error: JSON.stringify(result.error.flatten().fieldErrors) };
}

/** Assemble the full payload the rest of the system consumes. */
export function toSwivelPayload(llm: LlmPayload, sourceUrl: string): SwivelPayload {
  return { ...llm, customer_id: llm.customer_id, source_url: sourceUrl };
}

// Compile-time guarantee that the priority enum here stays identical to the
// SwivelPriority union in messages.ts — a divergence is a type error, not a
// runtime surprise.
const _priorityParity: readonly SwivelPriority[] = PRIORITY_VALUES;
void _priorityParity;
