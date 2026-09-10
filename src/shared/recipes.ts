/**
 * src/shared/recipes.ts — the target recipe registry (Phase 5).
 *
 * A recipe is a DECLARATIVE description of what to do on a target page: a
 * URL match set plus an ordered list of typed steps. The injection engine
 * (Phase 7) interprets these; nothing here touches the DOM. Recipes are
 * zod-validated at load time because they will become user-editable later
 * (Phase 10) — a malformed recipe must fail loudly at the boundary, not
 * halfway through a run against a live ticket system.
 *
 * SELECTOR STRATEGY (Charter Law 6): deterministic recipe selectors first,
 * preferring aria/role/data-testid over classes. The Jira selectors below
 * are BEST-EFFORT and explicitly pending the Gate-2 reality check against a
 * real Jira Cloud instance. The fixture recipe is AUTHORITATIVE — Phase 6
 * builds the mock page to match it exactly, so recipe and fixture move
 * together.
 */

import { z } from "zod";

/**
 * Payload fields a step may inject as text. action_items is an array (not a
 * scalar fill target) and source_url is provenance, so neither is offered.
 */
export const PAYLOAD_FIELDS = [
  "ticket_title",
  "customer_id",
  "priority",
  "summary",
] as const;
export type PayloadField = (typeof PAYLOAD_FIELDS)[number];

const timeout = z.number().int().positive().optional();

/**
 * Mark a step NON-FATAL: if its selector never resolves, the executor logs a
 * skip and carries on instead of aborting the run.
 *
 * WHY (Gate 5): two different situations genuinely warrant it.
 *  - A control that may not exist in this variant of the target UI (Jira's
 *    modernised create dialog hides secondary fields behind a disclosure).
 *  - Anything AFTER a successful submit. Once the create button has been
 *    clicked the issue EXISTS; failing the run because we couldn't scrape the
 *    key back reports a falsehood — it tells the user nothing was created
 *    when something was. A missing read-back is a degraded success.
 *
 * Strictly limited: the executor only skips "the element isn't there" errors
 * (SELECTOR_NOT_FOUND / OPTION_NOT_FOUND). SEND_DENIED, aborts and navigation
 * interrupts are never skippable, and `submits` steps may not be optional at
 * all (enforced below) — silently skipping a submit would be the worst
 * possible failure mode.
 */
const optional = z.boolean().optional();

// --- Step schemas (each a plain object so discriminatedUnion can key on `type`).
const clickStep = z.object({
  type: z.literal("click"),
  selector: z.string().min(1),
  description: z.string().min(1),
  // Marks a click that COMMITS data into the target system. Dry-run
  // hard-skips this step and everything after it (Phase 7): no submit is
  // ever performed in a dry run, and post-submit waits/readbacks can't
  // succeed without the submit anyway.
  submits: z.boolean().optional(),
  timeoutMs: timeout,
  optional,
});
const fillStep = z.object({
  type: z.literal("fill"),
  selector: z.string().min(1),
  payloadField: z.enum(PAYLOAD_FIELDS),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});
const fillRichTextStep = z.object({
  type: z.literal("fillRichText"),
  selector: z.string().min(1),
  payloadField: z.enum(PAYLOAD_FIELDS),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});
const selectOptionStep = z.object({
  type: z.literal("selectOption"),
  triggerSelector: z.string().min(1),
  // Exactly one source of the option text — enforced by the recipe-level
  // superRefine below (discriminatedUnion members can't self-refine).
  optionText: z.string().min(1).optional(),
  payloadField: z.enum(PAYLOAD_FIELDS).optional(),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});
const waitForStep = z.object({
  type: z.literal("waitFor"),
  selector: z.string().min(1),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});
const waitForGoneStep = z.object({
  type: z.literal("waitForGone"),
  selector: z.string().min(1),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});
const readBackStep = z.object({
  type: z.literal("readBack"),
  selector: z.string().min(1),
  attribute: z.string().min(1).optional(), // omitted → read textContent
  saveAs: z.string().min(1),
  description: z.string().min(1),
  timeoutMs: timeout,
  optional,
});

export const automationStepSchema = z.discriminatedUnion("type", [
  clickStep,
  fillStep,
  fillRichTextStep,
  selectOptionStep,
  waitForStep,
  waitForGoneStep,
  readBackStep,
]);
export type AutomationStep = z.infer<typeof automationStepSchema>;

export const targetRecipeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** chrome match patterns; used to find open target tabs. */
    urlPatterns: z.array(z.string().min(1)).min(1),
    /** The host permission this recipe needs — requested via
     *  chrome.permissions.request when the recipe is enabled (Phase 10).
     *  Must be a member of the manifest's optional_host_permissions (or an
     *  already-granted host). */
    requiredOrigin: z.string().min(1),
    /** Where "Open target" navigates when nothing matches. */
    canonicalUrl: z.string().url(),
    steps: z.array(automationStepSchema).min(1),
  })
  .superRefine((recipe, ctx) => {
    recipe.steps.forEach((step, i) => {
      if (step.type === "selectOption" && !step.optionText && !step.payloadField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selectOption requires either optionText or payloadField",
          path: ["steps", i],
        });
      }
      // A submit may never be optional. "Optional" means "carry on if the
      // element isn't there" — applied to a submit that would mean silently
      // not creating the ticket while the run still reports success.
      if (step.type === "click" && step.submits && step.optional) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a step with submits:true may not be optional — a skipped submit must fail the run",
          path: ["steps", i],
        });
      }
    });

    // OPTIONAL IS POST-SUBMIT ONLY (Gate 7, defect B-b).
    //
    // `optional` was introduced for steps AFTER the submit, where the write
    // has already happened and failing the run would misreport a ticket that
    // genuinely exists. It was then also used for a SETUP step ("open the
    // Create dialog"), and that inverted its meaning: the click failed with
    // SELECTOR_NOT_FOUND, `optional` recorded a benign-looking skip, and every
    // later step depended on a dialog that consequently never opened. The run
    // failed several steps downstream with a misleading error, and the step
    // log showed the real cause as a harmless skip.
    //
    // A PREREQUISITE CANNOT BE OPTIONAL: if later steps depend on it, its
    // failure makes them impossible, so it must fail the run loudly and
    // immediately. Enforced structurally rather than left to reviewer
    // discipline, because the discipline is what failed.
    //
    // If a genuinely-conditional pre-submit step is ever needed, it needs a
    // real mechanism (a guard/branch expressing what it depends on), not this
    // flag.
    const submitIndex = recipe.steps.findIndex((s) => s.type === "click" && s.submits);
    recipe.steps.forEach((step, i) => {
      if (!step.optional) return;
      if (submitIndex === -1 || i < submitIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "optional is only allowed on steps AFTER the submit step — a prerequisite that later " +
            "steps depend on must fail the run, not skip silently",
          path: ["steps", i],
        });
      }
    });
  });
export type TargetRecipe = z.infer<typeof targetRecipeSchema>;

// --- Per-type guards (used by the executor in Phase 7). --------------------
export const isClickStep = (s: AutomationStep): s is Extract<AutomationStep, { type: "click" }> =>
  s.type === "click";
export const isFillStep = (s: AutomationStep): s is Extract<AutomationStep, { type: "fill" }> =>
  s.type === "fill";
export const isFillRichTextStep = (
  s: AutomationStep
): s is Extract<AutomationStep, { type: "fillRichText" }> => s.type === "fillRichText";
export const isSelectOptionStep = (
  s: AutomationStep
): s is Extract<AutomationStep, { type: "selectOption" }> => s.type === "selectOption";
export const isReadBackStep = (
  s: AutomationStep
): s is Extract<AutomationStep, { type: "readBack" }> => s.type === "readBack";

// ---------------------------------------------------------------------------
// The recipes
// ---------------------------------------------------------------------------

// --- Jira selectors, captured from a live create dialog at Gate 5 ----------
//
// VERSIONED TESTIDS ARE EXPECTED STALENESS CANDIDATES. Atlassian's testids
// embed a UI generation name — "issue-create-modernised", "issue-create-
// commons" — and they renamed this dialog once already (the pre-Gate-5 recipe
// targeted "issue-create.common.ui.footer.create-button", which no longer
// exists). Assume they will do it again. Each selector below is therefore a
// ranked list: the exact captured testid first, then a version-independent
// anchor (id / name / aria / testid SUFFIX) that should survive a rename.
//
// Ranking caveat, inherited from the Gmail work: `querySelector("a, b")`
// resolves in DOCUMENT order, not list order. That is safe here only because
// every branch below is written to match the SAME element in this dialog. Do
// not add a branch that could match a different element.

/** Summary: plain <input>. Captured: data-testid + name + id + aria-label. */
const JIRA_SUMMARY =
  '[data-testid="issue-create-commons.common.ui.fields.base-fields.input-field.textfield"], ' +
  "#summary-field, " +
  'input[name="summary"]';
// NB: deliberately NOT a [data-testid$="input-field.textfield"] suffix match —
// every base text field in the dialog shares that suffix, so it would be
// ambiguous. #summary-field / name="summary" are the safe generic anchors.

/**
 * Description: ProseMirror (Atlassian Editor), NOT a textarea.
 *
 * #ak-editor-textarea is the editor's own contenteditable host. The visible
 * placeholder <span> inside it is contenteditable="false" and must never be
 * the target — writing into it would do nothing and would not reach
 * ProseMirror's document model. Targeting the host by id makes that
 * impossible, which is why the id leads here.
 */
const JIRA_DESCRIPTION =
  "#ak-editor-textarea, " +
  '[role="textbox"][contenteditable="true"][aria-label^="Description"]';
// The aria fallback is English-only; #ak-editor-textarea is not, so the
// locale-independent branch is the one ranked first.

/** Create button. Suffix match is safe here — one footer create button. */
const JIRA_CREATE_BUTTON =
  '[data-testid="issue-create-modernised.ui.footer.create-button"], ' +
  '[data-testid$="ui.footer.create-button"]';

/**
 * Jira Cloud — Create issue.
 *
 * Selectors CAPTURED at Gate 5 from a live modernised create dialog (Kanban
 * project, Task issue type). Structurally verified against that capture; the
 * run itself is NOT yet re-verified in a browser.
 *
 * PRIORITY IS DELIBERATELY ABSENT — see the note below the recipe.
 *
 * POST-SUBMIT STEPS ARE UNVERIFIED. The capture covers the dialog only; what
 * Jira renders AFTER a successful create was not captured, so those steps are
 * marked optional rather than guessed at with confidence. See the note.
 */
const jiraCloudCreateIssue: TargetRecipe = {
  id: "jira-cloud-create-issue",
  label: "Jira Cloud — Create issue",
  urlPatterns: ["https://*.atlassian.net/*"],
  requiredOrigin: "https://*.atlassian.net/*",
  canonicalUrl: "https://your-domain.atlassian.net/jira/software/projects",
  steps: [
    {
      // THE OPEN-DIALOG CLICK IS GONE (Gate 7, defect B). It was built on an
      // unverified guess at Jira's nav Create control, and when that guess
      // missed, `optional` turned the miss into a skip and the run limped on
      // to fail later with a misleading error.
      //
      // It also could never have worked in a DRY RUN even with a correct
      // selector: dry-run downgrades every click to a highlight, so the dialog
      // would not open and every following step would fail anyway. A
      // navigational prerequisite is fundamentally incompatible with dry-run
      // semantics as they stand.
      //
      // So the recipe now REQUIRES the create dialog to be open, and says so.
      // That removes a guess instead of adding one. See the capture request in
      // the note below the recipe for what would let us restore the step
      // properly (non-optional, with dry-run handled).
      type: "waitFor",
      selector: JIRA_SUMMARY,
      description: "Wait for the create dialog — open it in Jira before running",
      timeoutMs: 15000,
    },
    {
      type: "fill",
      selector: JIRA_SUMMARY,
      payloadField: "ticket_title",
      description: "Fill Summary",
    },
    {
      // MUST be fillRichText: ProseMirror keeps its own document model and
      // ignores direct value/textContent writes. insertRichText drives it
      // through execCommand("insertText") with a beforeinput/input fallback.
      type: "fillRichText",
      selector: JIRA_DESCRIPTION,
      payloadField: "summary",
      description: "Fill Description (ProseMirror editor)",
    },
    {
      type: "click",
      selector: JIRA_CREATE_BUTTON,
      description: "Create the issue",
      submits: true,
    },
    {
      // UNVERIFIED post-submit DOM — optional so a wrong guess cannot report
      // "nothing was created" about an issue that WAS created.
      type: "waitFor",
      selector: '[role="alert"], [data-testid*="flag"]',
      description: "Wait for the success confirmation (best-effort)",
      optional: true,
      timeoutMs: 15000,
    },
    {
      type: "readBack",
      selector: 'a[href*="/browse/"]',
      attribute: "href",
      saveAs: "issueUrl",
      description: "Read back the new issue URL (best-effort)",
      optional: true,
      timeoutMs: 8000,
    },
    {
      type: "readBack",
      selector: 'a[href*="/browse/"]',
      saveAs: "issueKey",
      description: "Read back the new issue key (best-effort)",
      optional: true,
      timeoutMs: 8000,
    },
  ],
};

/**
 * CAPTURE REQUEST — Jira's nav "Create" control.
 *
 * To restore an "open the dialog" step (non-optional, as a prerequisite must
 * be), run this on the Jira BOARD page with NO dialog open, and send the
 * output. Do not let me guess it again:
 *
 *   copy([...document.querySelectorAll('button,[role="button"],a')]
 *     .filter(el => /create/i.test(
 *       (el.getAttribute('aria-label') || '') + ' ' +
 *       (el.getAttribute('data-testid') || '') + ' ' +
 *       (el.textContent || '').trim()))
 *     .map(el => ({
 *       tag: el.tagName,
 *       testid: el.getAttribute('data-testid'),
 *       id: el.id || null,
 *       ariaLabel: el.getAttribute('aria-label'),
 *       text: (el.textContent || '').trim().slice(0, 40),
 *       visible: !!el.offsetParent,
 *     })));
 *
 * Restoring it also needs a decision on dry-run semantics: a dry run
 * highlights instead of clicking, so a navigational click cannot open
 * anything. Either such steps click even in dry run (they commit no data), or
 * dry runs keep requiring the dialog to be open already. Your call.
 *
 * PRIORITY: intentionally not a step in this recipe.
 *
 * The Gate-5 capture enumerated every button in the modernised dialog and
 * found only: project, issue type, Minimise, Go full screen, Close, Browse
 * attachment, Give feedback, Create. There is no priority control on screen —
 * the dialog hides secondary fields behind a disclosure that was not captured.
 *
 * So writing a priority step means inventing both the disclosure selector AND
 * the field selector from markup nobody has looked at. Marking such a step
 * `optional` would not make that honest; it would make it INVISIBLE — a step
 * that always skips is indistinguishable from a step that is silently wrong,
 * and it trains you to ignore skip messages that will one day matter.
 *
 * The payload's `priority` therefore goes UNUSED for this target, and that is
 * recorded here rather than being a silent omission. Two ways to change that,
 * both needing a capture first:
 *   1. Open the disclosure in the dialog, capture the disclosure control and
 *      the priority field, and add: an optional click on the disclosure, then
 *      an optional selectOption on the field.
 *   2. If you would rather not depend on a hidden control at all: append the
 *      priority to the description text instead. That keeps the data but
 *      changes what "description" means, so it is your call, not mine.
 */

/**
 * Local fixture — Create ticket. AUTHORITATIVE. Phase 6 builds
 * tests/fixtures/spa to match these selectors exactly; the two evolve
 * together and are the regression target for Phases 6–8.
 */
const fixtureCreateTicket: TargetRecipe = {
  id: "fixture-create-ticket",
  label: "Local fixture — Create ticket",
  urlPatterns: ["http://localhost:4599/*"],
  requiredOrigin: "http://localhost:4599/*",
  canonicalUrl: "http://localhost:4599/",
  steps: [
    { type: "waitFor", selector: '[data-testid="ticket-form"]', description: "Wait for the form to render" },
    {
      type: "fill",
      selector: '[data-testid="title-input"]',
      payloadField: "ticket_title",
      description: "Fill the title",
    },
    {
      type: "fill",
      selector: '[data-testid="customer-input"]',
      payloadField: "customer_id",
      description: "Fill the customer id",
    },
    {
      type: "selectOption",
      triggerSelector: '[data-testid="priority-combobox"]',
      payloadField: "priority",
      description: "Choose the priority",
    },
    {
      type: "fillRichText",
      selector: '[data-testid="description-editor"]',
      payloadField: "summary",
      description: "Fill the description",
    },
    {
      type: "click",
      selector: '[data-testid="submit-button"]',
      description: "Submit the ticket",
      submits: true,
    },
    {
      type: "waitForGone",
      selector: '[data-testid="submit-spinner"]',
      description: "Wait for submission to finish",
    },
    {
      type: "waitFor",
      selector: '[data-testid="success-screen"]',
      description: "Wait for the success screen",
    },
    {
      type: "readBack",
      selector: '[data-testid="ticket-id"]',
      saveAs: "issueKey",
      description: "Read back the generated ticket id",
    },
    {
      type: "readBack",
      selector: '[data-testid="issue-link"]',
      attribute: "href",
      saveAs: "issueUrl",
      description: "Read back the ticket URL",
    },
  ],
};

export const RECIPES: readonly TargetRecipe[] = [jiraCloudCreateIssue, fixtureCreateTicket];

/** Validate every built-in recipe at module load — a bad recipe is a build
 *  bug we want to surface immediately, not at run time on a live target. */
for (const recipe of RECIPES) {
  const result = targetRecipeSchema.safeParse(recipe);
  if (!result.success) {
    throw new Error(`Invalid built-in recipe "${recipe.id}": ${result.error.message}`);
  }
}

export function findRecipe(id: string): TargetRecipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

/** Lightweight shape for the panel picker + settings (no steps needed). */
export interface RecipeSummary {
  id: string;
  label: string;
  requiredOrigin: string;
}
export const RECIPE_SUMMARIES: readonly RecipeSummary[] = RECIPES.map((r) => ({
  id: r.id,
  label: r.label,
  requiredOrigin: r.requiredOrigin,
}));
