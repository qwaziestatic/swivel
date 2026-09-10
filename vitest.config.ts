import { defineConfig } from "vitest/config";

/**
 * Unit tests target pure functions only (src/shared/*.ts) — no DOM, no
 * chrome.* mocking needed for Phase 2. jsdom for MutationObserver-based
 * waitForElement tests arrives in Phase 10's harness.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
