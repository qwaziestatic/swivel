import { describe, expect, it } from "vitest";
import {
  automationStepSchema,
  findRecipe,
  isFillStep,
  isReadBackStep,
  isSelectOptionStep,
  RECIPES,
  targetRecipeSchema,
  type AutomationStep,
} from "../src/shared/recipes";
import { matchesAnyPattern, matchesPattern } from "../src/shared/urlMatch";

describe("optional steps (Gate 5)", () => {
  const base = {
    id: "t",
    label: "T",
    urlPatterns: ["https://example.com/*"],
    requiredOrigin: "https://example.com/*",
    canonicalUrl: "https://example.com/",
  };

  it("accepts optional on a POST-SUBMIT step", () => {
    const r = targetRecipeSchema.safeParse({
      ...base,
      steps: [
        { type: "click", selector: "#go", description: "submit", submits: true },
        { type: "readBack", selector: "#k", saveAs: "issueKey", description: "key", optional: true },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("REFUSES optional on a PRE-submit step — a prerequisite must fail loudly", () => {
    // Gate 7: this was previously ALLOWED, and it is what let a failed
    // "open the Create dialog" click be recorded as a benign skip while every
    // step that depended on the dialog then failed with a misleading error.
    const r = targetRecipeSchema.safeParse({
      ...base,
      steps: [
        { type: "click", selector: "#open", description: "open dialog", optional: true },
        { type: "click", selector: "#go", description: "submit", submits: true },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain("only allowed on steps AFTER the submit");
  });

  it("REFUSES optional in a recipe with no submit step at all", () => {
    // Nothing is "post-submit" if nothing submits, so optional has no valid
    // meaning here — every step is a prerequisite for the ones after it.
    const r = targetRecipeSchema.safeParse({
      ...base,
      steps: [{ type: "waitFor", selector: "#x", description: "w", optional: true }],
    });
    expect(r.success).toBe(false);
  });

  it("Jira: no step before the submit is optional", () => {
    const jira = findRecipe("jira-cloud-create-issue")!;
    const submitIndex = jira.steps.findIndex((s) => s.type === "click" && s.submits);
    for (const step of jira.steps.slice(0, submitIndex)) {
      expect(step.optional, `pre-submit "${step.description}" must not be optional`).toBeFalsy();
    }
  });

  it("Jira: no longer depends on a guessed nav Create selector", () => {
    // The open-dialog click was removed (Gate 7) — it was an unverified guess
    // AND could never work in a dry run, which highlights instead of clicking.
    const jira = findRecipe("jira-cloud-create-issue")!;
    const selectors = jira.steps.map((s) => ("selector" in s ? s.selector : "")).join(" ");
    expect(selectors).not.toContain("createGlobalItem");
    expect(selectors).not.toContain('aria-label="Create"');
  });

  it("REFUSES optional on a submitting step — a skipped submit must fail loudly", () => {
    const r = targetRecipeSchema.safeParse({
      ...base,
      steps: [
        { type: "click", selector: "#go", description: "submit", submits: true, optional: true },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain("may not be optional");
  });

  it("Jira: post-submit steps are optional, the submit itself is not", () => {
    // A failed read-back must not retract an issue that WAS created; a submit
    // must never be skippable.
    const jira = findRecipe("jira-cloud-create-issue")!;
    const submit = jira.steps.find((s) => s.type === "click" && s.submits)!;
    expect(submit.optional).toBeFalsy();

    for (const step of jira.steps.slice(jira.steps.indexOf(submit) + 1)) {
      expect(step.optional, `post-submit "${step.description}" should be optional`).toBe(true);
    }
  });

  it("Jira: no priority step — it is absent from the modernised dialog", () => {
    // Documented decision, asserted so that re-adding a GUESSED priority
    // selector has to consciously change this test first.
    const jira = findRecipe("jira-cloud-create-issue")!;
    expect(jira.steps.some((s) => "payloadField" in s && s.payloadField === "priority")).toBe(
      false
    );
  });

  it("Jira: description uses fillRichText on the ProseMirror host, not fill", () => {
    const jira = findRecipe("jira-cloud-create-issue")!;
    const desc = jira.steps.find((s) => s.type === "fillRichText")!;
    expect(desc).toBeTruthy();
    if ("selector" in desc) {
      expect(desc.selector).toContain("#ak-editor-textarea");
      // The placeholder span is contenteditable="false" — never a target.
      expect(desc.selector).not.toContain("placeholder");
    }
    // The summary is a plain input and must stay a `fill`.
    const summary = jira.steps.find((s) => s.type === "fill")!;
    expect(summary.type).toBe("fill");
  });
});

describe("matchesPattern (chrome match patterns)", () => {
  it("matches a subdomain wildcard", () => {
    expect(matchesPattern("https://acme.atlassian.net/jira/x", "https://*.atlassian.net/*")).toBe(
      true
    );
    expect(matchesPattern("https://atlassian.net/x", "https://*.atlassian.net/*")).toBe(true);
  });

  it("rejects a different host", () => {
    expect(matchesPattern("https://evil.com/atlassian.net", "https://*.atlassian.net/*")).toBe(
      false
    );
  });

  it("respects scheme (* means http/https only)", () => {
    expect(matchesPattern("http://localhost:4599/", "http://localhost:4599/*")).toBe(true);
    expect(matchesPattern("https://localhost:4599/", "http://localhost:4599/*")).toBe(false);
    expect(matchesPattern("https://x.atlassian.net/", "*://*.atlassian.net/*")).toBe(true);
    expect(matchesPattern("ftp://x.atlassian.net/", "*://*.atlassian.net/*")).toBe(false);
  });

  it("matches path and query against the /* tail", () => {
    expect(
      matchesPattern("https://acme.atlassian.net/browse/ABC-1?focused=true", "https://*.atlassian.net/*")
    ).toBe(true);
  });

  it("does not treat the host as part of a subdomain when it only shares a suffix", () => {
    expect(matchesPattern("https://notatlassian.net/x", "https://*.atlassian.net/*")).toBe(false);
  });

  it("matchesAnyPattern is an OR over the list", () => {
    const patterns = ["https://*.atlassian.net/*", "http://localhost:4599/*"];
    expect(matchesAnyPattern("http://localhost:4599/", patterns)).toBe(true);
    expect(matchesAnyPattern("https://example.com/", patterns)).toBe(false);
  });
});

describe("recipe registry", () => {
  it("ships the jira + fixture recipes and finds them by id", () => {
    expect(RECIPES).toHaveLength(2);
    expect(findRecipe("jira-cloud-create-issue")?.label).toContain("Jira");
    expect(findRecipe("fixture-create-ticket")?.label).toContain("fixture");
    expect(findRecipe("nope")).toBeUndefined();
  });

  it("every built-in recipe passes its own schema", () => {
    for (const r of RECIPES) expect(targetRecipeSchema.safeParse(r).success).toBe(true);
  });
});

describe("automationStepSchema", () => {
  it("accepts a well-formed fill step", () => {
    const step = {
      type: "fill",
      selector: "#title",
      payloadField: "ticket_title",
      description: "Fill title",
    };
    expect(automationStepSchema.safeParse(step).success).toBe(true);
  });

  it("rejects a fill step with an unknown payloadField", () => {
    const step = {
      type: "fill",
      selector: "#x",
      payloadField: "not_a_field",
      description: "d",
    };
    expect(automationStepSchema.safeParse(step).success).toBe(false);
  });

  it("rejects an unknown step type", () => {
    expect(automationStepSchema.safeParse({ type: "teleport", selector: "#x" }).success).toBe(
      false
    );
  });

  it("rejects an empty selector", () => {
    expect(
      automationStepSchema.safeParse({ type: "click", selector: "", description: "d" }).success
    ).toBe(false);
  });
});

describe("targetRecipeSchema superRefine", () => {
  const base = {
    id: "r",
    label: "R",
    urlPatterns: ["https://*.example.com/*"],
    requiredOrigin: "https://*.example.com/*",
    canonicalUrl: "https://example.com/",
  };

  it("rejects a selectOption step with neither optionText nor payloadField", () => {
    const recipe = {
      ...base,
      steps: [{ type: "selectOption", triggerSelector: "#p", description: "pick" }],
    };
    expect(targetRecipeSchema.safeParse(recipe).success).toBe(false);
  });

  it("accepts a selectOption step with payloadField", () => {
    const recipe = {
      ...base,
      steps: [
        {
          type: "selectOption",
          triggerSelector: "#p",
          payloadField: "priority",
          description: "pick",
        },
      ],
    };
    expect(targetRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it("rejects a recipe with no steps or no urlPatterns", () => {
    expect(targetRecipeSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(
      targetRecipeSchema.safeParse({
        ...base,
        urlPatterns: [],
        steps: [{ type: "click", selector: "#x", description: "d" }],
      }).success
    ).toBe(false);
  });

  it("rejects a non-URL canonicalUrl", () => {
    expect(
      targetRecipeSchema.safeParse({
        ...base,
        canonicalUrl: "not a url",
        steps: [{ type: "click", selector: "#x", description: "d" }],
      }).success
    ).toBe(false);
  });
});

describe("step type guards", () => {
  it("narrow correctly", () => {
    const fill: AutomationStep = {
      type: "fill",
      selector: "#x",
      payloadField: "summary",
      description: "d",
    };
    const readBack: AutomationStep = {
      type: "readBack",
      selector: "#x",
      saveAs: "issueKey",
      description: "d",
    };
    const select: AutomationStep = {
      type: "selectOption",
      triggerSelector: "#p",
      optionText: "High",
      description: "d",
    };
    expect(isFillStep(fill)).toBe(true);
    expect(isFillStep(readBack)).toBe(false);
    expect(isReadBackStep(readBack)).toBe(true);
    expect(isSelectOptionStep(select)).toBe(true);
  });
});
