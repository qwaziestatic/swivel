/**
 * tests/runOutcome.test.ts — the stop-class regression from Gate 6.
 *
 * A DRY RUN reported "Ticket created ✓" against real Jira. Nothing was
 * submitted; nothing could have been. The done view derived its success text
 * from "the run ended" rather than from what the run DID, and a dry run ends
 * exactly like a real one.
 *
 * describeRunOutcome is the single place that decides what may be claimed, so
 * these tests are the enforcement point. The key assertions are on the
 * `claimsCreation` PROPERTY rather than on UI copy, so rewording the strings
 * can never quietly re-open the hole.
 */

import { describe, it, expect } from "vitest";
import { describeRunOutcome } from "../src/sidepanel/panelMachine";
import type { RunOutcome } from "../src/shared/messages";

const dry: RunOutcome = {
  dryRun: true,
  submitted: false,
  stepsExecuted: 4,
  stepsSkipped: 4,
  highlighted: 4,
};
const realSubmitted: RunOutcome = {
  dryRun: false,
  submitted: true,
  stepsExecuted: 6,
  stepsSkipped: 0,
  highlighted: 0,
};
const realNoSubmit: RunOutcome = {
  dryRun: false,
  submitted: false,
  stepsExecuted: 3,
  stepsSkipped: 2,
  highlighted: 0,
};

/** Words that assert a ticket exists. None may appear unless submitted. */
const CREATION_WORDS = /created|ticket created|submitted successfully/i;

describe("a DRY RUN can never render creation language", () => {
  it("does not claim creation", () => {
    expect(describeRunOutcome(dry, null).claimsCreation).toBe(false);
  });

  it("says explicitly that nothing was submitted", () => {
    const r = describeRunOutcome(dry, null);
    expect(r.headline).toMatch(/dry run/i);
    expect(`${r.headline} ${r.detail}`).toMatch(/nothing was submitted|no ticket was created/i);
  });

  it("uses no creation wording in the headline", () => {
    expect(describeRunOutcome(dry, null).headline).not.toMatch(CREATION_WORDS);
  });

  it("STILL refuses creation language even if a readBack somehow exists", () => {
    // Defence in depth: a stale readBack from an earlier real run must not be
    // able to turn a dry run's report into a creation claim.
    const r = describeRunOutcome(dry, { issueKey: "SWIV-9", issueUrl: "https://x/browse/SWIV-9" });
    expect(r.claimsCreation).toBe(false);
    expect(r.headline).not.toMatch(CREATION_WORDS);
    expect(r.canDraftReply).toBe(false);
  });

  it("never offers to draft a reply about a ticket that does not exist", () => {
    expect(describeRunOutcome(dry, null).canDraftReply).toBe(false);
  });

  it("reports what the dry run actually did", () => {
    expect(describeRunOutcome(dry, null).detail).toContain("4 field");
  });
});

describe("a run whose SUBMIT step did not execute cannot report creation", () => {
  it("does not claim creation when submitted is false", () => {
    expect(describeRunOutcome(realNoSubmit, null).claimsCreation).toBe(false);
  });

  it("says so plainly and warns", () => {
    const r = describeRunOutcome(realNoSubmit, null);
    expect(r.headline).toMatch(/without submitting/i);
    expect(r.tone).toBe("warning");
    expect(r.headline).not.toMatch(CREATION_WORDS);
  });

  it("is not rescued by a readBack — skipped optional steps are not success", () => {
    // The Gate-5 `optional` change means post-submit steps report status "ok"
    // when they skip, so an all-green step log proves nothing about the submit.
    const r = describeRunOutcome(realNoSubmit, { issueKey: "SWIV-1" });
    expect(r.claimsCreation).toBe(false);
    expect(r.canDraftReply).toBe(false);
  });

  it("offers no draft-reply affordance", () => {
    expect(describeRunOutcome(realNoSubmit, null).canDraftReply).toBe(false);
  });
});

describe("a real submitted run", () => {
  it("claims creation and links the ticket when the key was read back", () => {
    const r = describeRunOutcome(realSubmitted, { issueKey: "SWIV-42" });
    expect(r.claimsCreation).toBe(true);
    expect(r.tone).toBe("created");
    expect(r.headline).toMatch(/created/i);
    expect(r.canDraftReply).toBe(true);
  });

  it("warns — and does NOT offer a reply — when the key could not be read back", () => {
    // The submit ran, so a ticket very likely exists: the danger here is a
    // blind retry creating a duplicate, not a false success.
    const r = describeRunOutcome(realSubmitted, null);
    expect(r.claimsCreation).toBe(true);
    expect(r.tone).toBe("warning");
    expect(r.detail).toMatch(/duplicate/i);
    expect(r.canDraftReply).toBe(false);
  });
});

describe("an unknown outcome is never treated as success", () => {
  it("refuses to claim anything when the executor sent no outcome", () => {
    // e.g. a stale target.js from before Gate 6 is still resident in the page.
    const r = describeRunOutcome(null, null);
    expect(r.claimsCreation).toBe(false);
    expect(r.tone).toBe("warning");
    expect(r.headline).not.toMatch(CREATION_WORDS);
    expect(r.canDraftReply).toBe(false);
  });

  it("does not claim creation even with a readBack present", () => {
    expect(describeRunOutcome(null, { issueKey: "SWIV-7" }).claimsCreation).toBe(false);
  });
});

describe("exhaustive property: creation is claimed ONLY when submitted", () => {
  it("holds across every combination of the outcome flags", () => {
    for (const dryRun of [true, false]) {
      for (const submitted of [true, false]) {
        for (const readBack of [null, { issueKey: "K" }, { issueUrl: "u" }]) {
          const r = describeRunOutcome(
            { dryRun, submitted, stepsExecuted: 1, stepsSkipped: 0, highlighted: 1 },
            readBack
          );
          if (r.claimsCreation) {
            expect(submitted, "claimsCreation implies the submit step ran").toBe(true);
            expect(dryRun, "a dry run may never claim creation").toBe(false);
          }
          // And the affordance to tell a customer about the ticket is even
          // stricter: it needs a real, identified ticket.
          if (r.canDraftReply) {
            expect(submitted && !dryRun && readBack !== null).toBe(true);
          }
        }
      }
    }
  });
});
