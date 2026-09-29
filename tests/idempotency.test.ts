import { describe, expect, it, vi } from "vitest";
import { createRunGuard, IdempotencyUnavailableError } from "../src/content/lib/idempotency";

describe("createRunGuard", () => {
  it("reads and writes the persistent run key", async () => {
    const values: Record<string, unknown> = {};
    const guard = createRunGuard({
      get: vi.fn(async (key) => values[key] === undefined ? {} : { [key]: values[key] }),
      set: vi.fn(async (items) => Object.assign(values, items)),
    });

    expect(await guard.has("run-1")).toBe(false);
    await guard.mark("run-1", "in-progress");
    expect(await guard.has("run-1")).toBe(true);
  });

  it("fails closed when persistent reads are unavailable", async () => {
    const guard = createRunGuard({
      get: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      set: vi.fn(),
    });

    await expect(guard.has("run-1")).rejects.toBeInstanceOf(IdempotencyUnavailableError);
  });

  it("fails closed when persistent writes are unavailable", async () => {
    const guard = createRunGuard({
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });

    await expect(guard.mark("run-1", "in-progress")).rejects.toBeInstanceOf(
      IdempotencyUnavailableError
    );
  });
});
