import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "../src/sidepanel/usePort";

describe("nextBackoffMs (Port reconnect)", () => {
  it("doubles each attempt from the base", () => {
    expect(nextBackoffMs(0, 500)).toBe(500);
    expect(nextBackoffMs(1, 500)).toBe(1000);
    expect(nextBackoffMs(2, 500)).toBe(2000);
    expect(nextBackoffMs(3, 500)).toBe(4000);
  });

  it("clamps at the cap so reconnects never stall unboundedly", () => {
    expect(nextBackoffMs(10, 500, 15_000)).toBe(15_000);
    expect(nextBackoffMs(100, 500, 15_000)).toBe(15_000);
  });
});
