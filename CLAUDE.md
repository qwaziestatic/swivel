# Swivel (The Cross-Tab Automator) — Engineering Charter

You are a senior Chrome Extension engineer (Manifest V3 only) and browser
automation architect. You are building "Swivel (The Cross-Tab Automator)"
with me: an extension that extracts context from a source tab (e.g., a
Gmail thread), structures it into strict JSON via the Gemini API, and
injects that payload into a different open tab (Jira, Salesforce, or an
internal portal) by automating client-side DOM inputs. No backend, no
OAuth — the user's existing browser session is the auth.

## TECH STACK (non-negotiable)

- Side panel: React + TypeScript + Tailwind CSS
- Bundling: Vite with a MANUAL multi-entry config (no @crxjs plugin, no
  HMR — dev loop is `vite build --watch` + Reload in chrome://extensions)
- Service worker: ES module type ("type": "module" in manifest background)
- Strict TypeScript everywhere, including content scripts

## ARCHITECTURAL LAWS — never violate these, and call it out if I ask you to

1. MV3 service workers are EPHEMERAL. They can be killed between any two
   messages. Never rely on in-memory state for anything that must survive:
   the extracted payload, workflow status, and target tab ID live in
   chrome.storage.session. In-memory maps are cache only.
2. The service worker is the ONLY component that calls the Gemini API.
   The API key lives in chrome.storage.local (user-supplied via settings
   UI), is never hardcoded, and never reaches a content script or the DOM.
3. All cross-component communication goes through the background hub.
   Content scripts and the side panel never talk to each other directly.
   Every message is a TypeScript discriminated union defined in
   src/shared/messages.ts — no untyped message objects, ever.
4. Content scripts must be SPA-defensive: never assume an element exists.
   All DOM access goes through the Promise-based waitForElement utility
   (MutationObserver + timeout + immediate-hit check). Every automation
   step has a timeout and a typed failure mode.
5. Modern web apps use controlled inputs. Setting element.value directly
   does NOT update React/Lightning state. Always use the native property
   setter (Object.getOwnPropertyDescriptor on the prototype) and dispatch
   bubbling `input` / `change` events. Contenteditable fields (Jira
   description, Gmail compose) need a separate insertion path.
6. Selector strategy: deterministic "recipe" selectors first (prefer
   aria/role/data-testid over classes), with graceful, reported failure.
   LLM-based selector recovery is a later enhancement, not the core path
   — running an LLM over the DOM per action is slow, costly, and flaky.
7. Least privilege: request only the permissions each phase needs, and
   flag every permission you add with one line of justification.
8. Any action that SUBMITS data into a target system requires an explicit
   user confirmation in the side panel. Dry-run (highlight fields, don't
   submit) is a first-class mode.

## WORKING AGREEMENT

- Build incrementally. One phase at a time; within a phase, one file at a
  time if it's large. Never dump the whole app.
- State the full file path above every code block.
- Explain WHY for every non-obvious choice (one or two sentences, not
  essays), especially Chrome API gotchas: service worker lifetime, message
  channel closure (`return true` for async sendResponse), sidePanel
  behavior, host_permissions vs activeTab, CORS from the worker.
- End every phase with a concrete verification checklist I can run
  manually in the browser.
- If a request is ambiguous (e.g., which Jira screen, which selectors),
  ask before coding.

## PHASE ROADMAP (gate on each phase's VERIFY before advancing)

1. Scaffold, manifest, message hub, waitForElement
2. Source extraction (Gmail + generic fallback)
3. AI synthesis (Gemini, worker-only, zod-validated)
4. Side panel control center (React state machine)
5. Target routing & recipe registry
6. Injection engine (native setters, rich text, realistic clicks, dry-run)
7. SPA & lifecycle resilience (pushState routing, worker death, ports)
8. Loop closure (read back issue key, draft — never send — Gmail reply)
9. Hardening, permission diet, settings, error taxonomy
10. Test harness, mock-SPA fixture, packaging

## PROGRESS (resume log — update after every phase)

- **Scope decision (locked):** MVP is Gmail → Jira Cloud + local fixture.
  Salesforce is OUT — host permissions removed. The recipe registry
  (Phase 5) keeps a future Salesforce target a data+selectors task.
- **Phase 1** — delivered & verified. Scaffold, manifest, message hub,
  waitForElement.
- **Phase 2** — delivered; awaiting the browser gate (folded into GATE 1).
  Gmail extractor, generic on-demand extractor, cleanText, keyboard
  command, panel extraction UI. Tests: cleanText (13).
- **Phase 3** — delivered; **GATE 1 PASSED** (human-verified in browser).
  Gemini client, zod payload schema, one repair retry, worker-only key,
  settings UI, synthesis flow, wake-reconcile.
  Deviations (all flagged, all deliberate):
  1. API key is kept ENTIRELY out of the message union. The panel writes
     it directly to chrome.storage.local (settingsStore.ts); there is no
     SET_API_KEY message. Stronger than "avoid sending it" — it is
     structurally unroutable, per the continuation prompt's explicit ask.
  2. Renamed src/sidepanel/settings.ts → settingsStore.ts: it case-collided
     with Settings.tsx on Windows/macOS (tsc TS1149). settings* = store,
     Settings.tsx = component.
  3. Added a wake-reconcile in the hub's getState(): a fresh worker that
     rehydrates a worker-transient status (extracting/synthesizing/routing)
     flips it to a clean "error"/lastError:"INTERRUPTED" — no stuck spinner
     after a mid-flight worker death (Phase 3 req. 4). "executing" is
     excluded (that run lives in the content script — Phase 8 owns it).
  4. src/shared/config.ts holds DEFAULT_MODEL so the panel shows it without
     importing the Gemini client (keeps zod out of the panel bundle).
  5. payload.ts parity guard checks the zod OUTPUT type against
     SwivelPayload (mutual-extends), not `satisfies z.ZodType` — zod's
     INPUT type admits undefined from .optional()/.default().
- **Phase 4** — delivered; self-verified (tsc clean, 62 tests, all bundles
  build). Pure-reducer panel state machine (panelMachine.ts), editable
  review form with debounced+blur-flushed PAYLOAD_EDIT persistence, target
  picker (recipe stub), dry-run toggle, explicit confirm gate, executing
  view, reconnecting Port (usePort.ts + hub onConnect registry).
  Deviations (flagged):
  1. Reducer distinguishes REHYDRATE (unconditional load from
     storage.session — the panel may have been closed for minutes) from
     SYNC (transition-guarded live broadcast). "Illegal transition
     rejection" = SYNC illegal jumps + STEP/RUN_DONE/RUN_ERROR arriving
     outside executing or with a mismatched runId. SYNC to idle/error is
     always legal (reset/failure valves).
  2. Port transport is stood up but carries nothing yet — execution is
     Phase 6/7. Port name is "swivel-panel"; it will encode the runId once
     runs exist (Phase 6/8). Flagged because a runId can't be encoded before
     runs exist. broadcastToPorts is wired, `void`-guarded until Phase 6.
  3. src/shared/recipes.ts is a MINIMAL Phase-4 stub (id+label+canonicalUrl
     for the picker only). Phase 5 replaces it with the full TargetRecipe /
     AutomationStep typed registry + zod. Do not treat the stub as the
     registry.
  4. Removed the Phase-1 PING diagnostics button from the panel UI (the hub
     still answers PING). It was plumbing scaffolding, now superseded.
  5. AUTOMATE_TO_TARGET still returns NOT_IMPLEMENTED from the hub — the
     panel wires the full picker→dry-run→confirm→send path, but the pipeline
     visibly stops at review until Phase 5 lands routing. Honest, not a bug.
- **Phase 5** — delivered; self-verified (tsc clean, 79 tests, all bundles
  build). Full recipe registry (recipes.ts: TargetRecipe + AutomationStep
  zod discriminated union + superRefine + per-type guards + jira & fixture
  recipes, all validated at module load), pure chrome-match-pattern matcher
  (urlMatch.ts), hub routing (zero → TARGET_NOT_OPEN + open-target;
  multiple → TARGET_CANDIDATES picker; one → focus), OPEN_TARGET handler,
  panel candidate picker + open-target affordance.
  Deviations (flagged):
  1. Routing stops at "routing" phase with a typed EXECUTION_NOT_WIRED
     notice (shown as INFO in the panel, not an error) after focusing the
     target. Actual step injection is Phase 7 (target.ts doesn't exist yet).
     This is the honest hand-off point, not a silent no-op.
  2. background.js shrank ~62KB→12KB: the panel now imports recipes.ts, so
     zod is shared by both main-pass entries and Rollup split it into
     assets/config-*.js. The module service worker statically imports that
     chunk (valid for "type":"module"). Content scripts still bundle zod
     only where used (they don't import recipes/payload) — gmail/generic/
     content stayed 0.7–2.7KB. NOT a regression; verified the worker's
     import resolves.
  3. urlMatch.ts is our own matcher; the hub queries ALL tabs and filters
     with it rather than trusting tabs.query({url}) pattern parsing — keeps
     routing deterministic and unit-tested.
  4. Jira recipe selectors are BEST-EFFORT, commented as PENDING GATE 2.
     The fixture recipe is AUTHORITATIVE — Phase 6 builds the mock page to
     match it exactly.
- **Phase 6** — delivered; **e2e smoke suite GREEN (3/3)** against the
  actually-loaded extension, plus tsc clean + 79 unit tests + all bundles
  build. Adversarial fixture SPA (tests/fixtures/spa: 800ms delayed render,
  React-faithful controlled-input shim that reverts naive .value writes and
  builds the submitted ticket from the MODEL, pointer-gated combobox,
  spinner→success with readBack id, pushState link), fixture server on
  :4599, dev-only dist-test/ build, Playwright harness that resolves the
  extension id from the live service worker.
  Deviations / hard-won facts (record these — they cost real time):
  1. **Browser MUST be Playwright's Chromium (Chrome for Testing) via
     channel:"chromium".** Stable Chrome AND Edge disabled the
     --load-extension flag; `channel:"chrome"` silently loads NO extension
     (chrome://extensions showed []). This is THE gotcha. Prereq:
     `npx playwright install chromium` (the download ECONNRESET-failed twice
     here before succeeding — retry if it fails).
  2. **Hub origin gate refined** (src/background/index.ts): panel-only
     actions are now gated on `fromExtensionPage` (sender.url starts with
     chrome-extension://<id>/) instead of "sender has no tab". This is
     STRICTER (explicitly trusts our UI, distrusts content-script pages) and
     is what lets the harness drive the panel-opened-as-a-tab. Real docked
     panel is unaffected (its sender.url is our extension URL). Content
     scripts (http/https sender.url) are still rejected.
  3. Smoke round-trip opens the panel AS A TAB, calls fixture.bringToFront()
     so getActiveTab() targets the fixture, then sends EXTRACT_REQUEST from
     the panel's extension context — extraction injects generic.js via the
     dev manifest's localhost host permission. This is a genuine
     panel→hub→content→hub→panel round trip, not a fixture poke.
  4. dist-test/ is gitignored, built ONLY by `npm run build:test`, patched
     (name + localhost host perm) by tests/patch-test-manifest.mjs. `npm run
     build` never reads/emits it. Phase 10 must assert its absence from the
     zip.
  5. Cosmetic: tests/e2e/*.ts show editor errors for node globals
     (node:url, process) — tests/ is not in the typecheck tsconfig and
     Playwright transpiles via esbuild without typecheck, so this is
     harmless. Add @types/node + a tests tsconfig later if desired.
  - From here, "verified" for content-script / injection behavior means the
    **Playwright suite passed**, not "it typechecks".
- **Phase 7** — delivered; **full Playwright suite GREEN (7/7)** including 4
  new injection specs, plus tsc clean + 79 unit tests + all bundles build.
  inject.ts (setNativeValue via prototype setter + input/change,
  insertRichText via execCommand+InputEvent fallback, realisticClick full
  pointer sequence, highlight), target.ts executor (sequential, one
  AbortController per run, selectOption via listbox, dry-run skips submit +
  after, runId idempotency = page Set + storage.session), hub dispatchRun +
  makeRunId + STEP/DONE/ERROR relay over the Port.
  Deviations / decisions (flagged):
  1. content.js (index.ts) DELETED. target.js replaces it as the atlassian
     content script (manifest) AND is injected on demand for the fixture.
     Content build entry index→target. If you look for content.js, it's gone.
  2. RUN_RECIPE carries the already-validated `steps` so target.js needs
     neither recipes.ts nor zod — target.js is 7KB, zod-free (verified via
     `import type { AutomationStep }`, fully erased).
  3. Run events (STEP/DONE/ERROR) flow ONLY over the Port; the hub does NOT
     broadcast a terminal STATE_SNAPSHOT for a run. This avoids a race where
     SYNC(done) beats the Port RUN_DONE and the reducer (RUN_DONE requires
     phase "executing") drops the readBack. Panel channels are split:
     runtime=SYNC only, Port=run events.
  4. Hub gained a storage.session.onChanged listener keeping stateCache
     coherent when state is written out of band — enables clean e2e seeding
     AND is a real cache-coherence improvement (prod: hub is sole writer →
     no-op).
  5. storage.session.setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS) in the
     hub so target.js (content script) can read/write the run-idempotency
     record. Note: this exposes storage.session to OUR content scripts (not
     to page JS). Phase 9/10 may scope tighter.
  6. Submit steps carry `submits:true` (recipes). Dry-run hard-skips the
     submit and every step after it.
  7. Idempotency keyed on runId = `${recipeId}:${djb2(JSON.stringify(payload))}`;
     dry-runs are exempt (they submit nothing), so dry-run→real is allowed.
- **Phase 7** — **GATE 2 PASSED** (human-verified against real Jira Cloud).
- **Phase 8** — delivered; **full Playwright suite GREEN (10/10)** including 3
  new resilience specs, plus tsc clean + 80 unit tests + all bundles build.
  webNavigation.onHistoryStateUpdated mid-run abort (NAVIGATION_INTERRUPTED),
  persisted step log (WorkflowState.runSteps, idempotent-by-index), ABORT_RUN
  to the executor, RUN_IN_PROGRESS single-run guard, panel step-log restore
  on reload.
  Deviations / decisions (flagged):
  1. Step-log resilience is done via WorkflowState.runSteps (persisted,
     updated idempotently by stepIndex) + REHYDRATE reading it back — NOT a
     separate onConnect replay message. Avoids a rehydrate/replay race and is
     simpler. Worker-death continuity falls out for free: each STEP wakes the
     worker, which persists runSteps; the panel reads them on reload.
  2. Run-event relay is "always forward to the panel over the Port, but
     PERSIST state transitions only from phase 'executing'" (terminal-first-
     wins for the PERSISTED record). This protects lastError from the
     executor's late ABORTED after a navigation abort, while still letting
     the panel observe every event. The panel reducer dedups (RUN_DONE/
     RUN_ERROR require phase 'executing').
  3. Relay also requires fromTab === state.targetTabId (defense in depth). The
     two DIRECT-injection e2e tests (broken-selector, idempotency) therefore
     seed the hub into executing+targetTabId+runId first (mirroring what
     dispatchRun does in production). This surfaced when Phase 8 hardening
     broke those Phase-7 tests — fixed by seeding, not by loosening the guard.
  4. Worker-death simulation uses PANEL RELOAD (sanctioned fallback: "force
     port disconnects") — Playwright can't cleanly terminate an MV3 worker.
     The run lives in the content script (unaffected) and the idempotency
     guard prevents restart, so "completes exactly once" holds.
  5. Fixture gained ?delay=N (render delay override) for deterministic
     mid-run timing in the resilience tests.
  6. NOT changed: dry-run still ends in "done" phase (not review). The
     dry-run→real-run UX flow (getting back to review) is deferred — Phase 9
     adds the done view + "Start over", which covers it.
- **Phase 9** — delivered; **full Playwright suite GREEN (11/11)** incl. the
  Send-denial e2e, plus tsc clean + 84 unit tests + all bundles build.
  readBack issueKey+issueUrl (fixture + jira), Send-denial law
  (sendGuard.ts + target.ts assertNoSend → SEND_DENIED), DRAFT_REPLY to
  gmail.ts (clicks Reply, inserts templated reply, NEVER Send), done view
  (ticket link + Draft reply + reply-drafted status + Start over).
  Deviations / decisions (flagged):
  1. THE SEND-DENIAL LAW is enforced in target.ts (the executor — where
     hostile/user-edited recipes run), TWO layers: looksLikeSendSelector
     (selector string, unit-tested) + isSendElement (element accessible
     name, e2e-tested via a decoy Send button the recipe targets by testid).
     gmail.ts draftReply simply has NO Send code path. A recipe aiming any
     click at Send aborts with SEND_DENIED.
  2. gmail.ts DRAFT_REPLY selectors (Reply button, compose box) are
     BEST-EFFORT against Gmail's obfuscated DOM — verified at GATE 3. There
     is no Gmail fixture, so the draft-reply FLOW is not e2e-tested; the
     Send-denial LAW is. Draft logic is human-verified at Gate 3.
  3. Hub routes DRAFT_REPLY to the source Gmail tab (sourceTabId if still
     Gmail, else query mail.google.com), forwards to gmail.ts, relays the
     DRAFT_REPLY_DONE result to the panel.
  4. START_OVER resets WorkflowState to INITIAL (clears run + payload);
     storage.local (settings + API key) is untouched. This also unblocks the
     dry-run→real flow: after any run, "Start over" → idle → re-extract.
  5. replyDrafted is panel-local (not persisted) — fine for the transient
     done view.
- **Phase 9** — **GATE 3 PASSED** (human-verified full loop on real tabs).
- **Phase 10** — delivered; **all suites GREEN** (tsc clean, 84 unit tests,
  11/11 e2e, `npm run package` builds the zip + passes the dev-build guards).
  Error taxonomy consolidated in src/shared/errors.ts (helpFor with a
  generic fallback — no raw text in the UI); permission diet
  (host_permissions=Gmail only, atlassian+gemini in
  optional_host_permissions, requested at runtime); Settings completed
  (per-recipe enable/disable with chrome.permissions.request, model choice,
  Test selectors staleness check); target picker filters to enabled
  recipes; README finalized (positioning, ToS, data-flow, limitations, 3
  gates, 90s demo); scripts/package.mjs zips dist/ with dev-build-leakage
  guards.
  Deviations / decisions (flagged):
  1. PERMISSION DIET: install-time host = Gmail only. atlassian AND
     generativelanguage moved to optional_host_permissions. atlassian is
     requested when the Jira recipe is enabled; gemini when the API key is
     saved (both from a user-gesture click, as chrome.permissions.request
     requires). Fresh install therefore prompts only for Gmail.
  2. target.js is NO LONGER statically registered for atlassian (that
     static match would have triggered an install-time atlassian prompt).
     The hub injects target.js on demand via chrome.scripting after the
     atlassian permission is granted — same path as the fixture. gmail.js
     stays statically registered (Gmail is install-time).
  3. "Test selectors" = a new message trio (TEST_SELECTORS_REQUEST →
     TEST_SELECTORS → TEST_SELECTORS_RESULT). target.ts resolves each
     selector with a short timeout and acts on NOTHING; Settings reports
     which resolve. Recipe-staleness early warning.
  4. Packaging uses the platform `tar` (bsdtar → .zip via -a) — no npm dep.
     Guards refuse to ship if dist/manifest is a TEST BUILD or grants
     localhost, and if any dist-test artifact is under dist/.
  5. recipes gained requiredOrigin (the host a recipe needs); enabling a
     recipe requests exactly that origin. Fixture recipe's origin is
     localhost (grantable only under the dev-test manifest), so it can't be
     enabled in a shipped build — correct (it's a test target).
- **GATE 2/3 EVIDENCE CAVEAT (2026-09-06):** Gates 2 and 3 were run BEFORE
  Phase 10. Phase 10 un-registered target.js from the static atlassian match
  (now injected on demand via chrome.scripting after a runtime
  chrome.permissions.request). That shipping on-demand-injection +
  runtime-permission path is unit- and e2e-covered ONLY — it has NOT been
  re-verified against real Jira by a human. Re-verify at the Final Gate.
- **Pre-final-gate hardening (2026-09-06)** — tsc clean, 91 unit tests, 11/11
  e2e, package green.
  1. Gmail draft path is now LOCALE-RESILIENT. Root cause was subtler than
     "no fallback": comma-joined selectors resolve in DOCUMENT order, so a
     fallback appended to the string could outrank the precise English
     selector. Added waitForFirstMatch/resolveInOrder (waitForElement.ts) =
     true LIST-order resolution, then ranked the Gmail lists English-first
     (existing selectors unchanged) with locale-independent fallbacks below:
     `span.ams.bkH` + a positional last resort scoped to the last
     div[data-message-id], excluding [aria-haspopup] and anything
     isSendElement flags. Compose adds div.editable + last-editable.
     resolveInOrder is pure (stub root) → 7 unit tests lock LIST-over-
     DOCUMENT order; no jsdom needed.
  2. REPLY BUTTON CANNOT BE MATCHED SEMANTICALLY. Gmail gives it no
     data-testid and no distinguishing role — the fallbacks are class-based
     and positional BY NECESSITY, not preference. Still unverified on a
     non-English Gmail (no fixture); English path is unchanged and is what
     Gate 3 covered.
  3. package.mjs guards extended: DEV_ARTIFACT_RULES (source maps, fixture/
     spa/e2e paths, dist-test, *.spec/*.test) applied BOTH to a dist/ walk
     and to a post-zip `tar -tf` readback of the actual archive. Each rule
     was negative-tested by planting an artifact and confirming the refusal.
- **FINAL GATE RUN #1 — 3 DEFECTS FOUND (2026-09-10).** Diagnosed and changed;
  **NOT verified — awaiting the human's re-gate.** tsc clean, 107 unit tests,
  11/11 e2e, dist rebuilt.
  1. D1 extraction. TWO independent causes, both real. (i) gmail.js is
     manifest-registered, so it exists only in documents loaded AFTER the
     extension; reloading the extension orphans it → sendMessage rejects and a
     bare `catch {}` swallowed it = "only works after a refresh". Hub now
     re-injects + retries once. (ii) extractOpenThread read
     `document.querySelector('[role="main"]')` (FIRST in document order, no
     visibility test) and resolved subject/body via two INDEPENDENT
     document-wide queries, and awaited only the h2 — whose immediate-hit
     check a stale h2 satisfies instantly — then read the body synchronously.
     = "doesn't pick up a new thread". Now visible-container-scoped +
     awaits div[data-message-id] + fails typed on empty body.
     NOT a cause: gmail.ts has no module-scope state and no injection guard
     (checked; target.ts/generic.ts have guards, Gmail doesn't use them).
  2. D2 synthesis. It never "stopped" — it FAILED INVISIBLY. synthesize()
     already returned {code, detail}; runSynthesis persisted only .code and
     DISCARDED .detail (HTTP status + API error body), and the whole synthesis
     path had ZERO console statements. Separately, `case "SYNTHESIZE"` had no
     try/catch around an un-awaited async IIFE → any throw = unhandled
     rejection, sendResponse never fires, panel pends forever; App.tsx then had
     `if (reply?.type === …)` with NO else, so a dead channel rendered nothing.
     All three closed. Taxonomy split (AUTH/MODEL/BAD_REQUEST/RATE_LIMIT/
     SERVER/TIMEOUT/NETWORK/BAD_RESPONSE/SCHEMA/CRASHED + ORIGIN codes) in
     shared/diagnostics.ts, classification unit-tested. SYNTHESIS_ERROR →
     SYNTHESIS_SCHEMA (gemini.test.ts updated).
     DEFAULT_MODEL gemini-2.5-flash CONFIRMED valid — unchanged.
     Key round-trip CONFIRMED clean: same "swivel:apiKey" both sides, trim on
     write only, masked preview reads storage. No truncation.
  3. D3 permissions. NO_GEMINI_PERMISSION existed in ERROR_HELP but was
     emitted NOWHERE — the pre-check was never wired, so a missing origin
     surfaced as "check your internet connection". Now: contains() pre-flight
     for the not-granted case + classifyFetchFailure(granted && opaque fetch
     failure ⇒ ORIGIN_BLOCKED) for the granted-but-site-access-off case the
     gate actually hit. Same treatment for the target origin before a run.
     Settings shows grant state per origin + a "Test key" live probe.
  UNVERIFIABLE WITHOUT A BROWSER (do not treat as settled): which cause
  produced which D1 symptom; whether multiple [role="main"] really coexist in
  Gmail; whether permissions.contains() returns true under a withheld toggle;
  whether detached `fetch` actually threw (bound it defensively either way).
- **FINAL GATE RUN #2 — panel render regression (2026-09-10).** Diagnosed and
  changed; **NOT verified.** tsc clean, 117 unit tests, 11/11 e2e, dist rebuilt.
  ROOT CAUSE, single line: `PHASE_TRANSITIONS.idle` was `["extracting"]`, so
  SYNC(source_ready) arriving at a fresh idle panel was REJECTED — the reducer
  returns the previous state, `extracted` is never copied in, and every render
  branch gated on it (`{state.extracted && …}`, the Synthesize button on phase
  sourceReady) stays unmounted. The panel never sees "extracting": it dispatches
  no optimistic phase, and the hub persists "extracting" without broadcasting.
  So source_ready is the FIRST snapshot an idle panel ever gets. The keyboard
  command makes this reachable by design, not just by race.
  1. Fixed the table: idle → sourceReady is legal. NOT loosened further — the
     guard still rejects idle → executing (verified by test).
  2. ONE SOURCE OF TRUTH for success: "Source captured ✓" was set from the HUB
     status while phase came from the reducer, hence a success tick over an
     empty panel. The tick is DELETED — success is the captured-source view
     rendering. New willAcceptSync() lets the caller detect a dropped SYNC and
     report PANEL_SYNC_REJECTED instead of faking success.
  3. Stale-shape defence: getState() now MERGES over INITIAL_WORKFLOW_STATE
     instead of casting (`as WorkflowState` lied about fields written by older
     builds; storage.session outlives an extension reload). REHYDRATE tolerates
     missing runSteps/lastErrorDetail and now restores errorDetail.
  4. Repeat extraction is COALESCED per tab (in-memory map): panel button,
     keyboard command, and rapid clicks are three independent triggers with no
     guard, and concurrent runs interleaved their setState calls. Coalesced not
     rejected — extraction is read-only, unlike a run (which keeps its hard
     RUN_IN_PROGRESS refusal).
  NOT the cause (checked): no shape break from lastErrorDetail /
  SYNTHESIS_SCHEMA / HUB_NO_RESPONSE; the broadcast fires and the listener
  receives it.
  Tests: tests/panelSync.test.ts — **verified to FAIL 5/10 against the pre-fix
  table**, so this class of regression is now catchable without a browser.
  LESSON: panelMachine had 30 tests and none covered the happy path from a
  fresh idle panel. Transition tables need a test per LEGAL edge, not just the
  illegal ones.
- **FINAL GATE RUN #3 — same bug class, one step later (2026-09-10).**
  Diagnosed and changed; **NOT verified.** tsc clean, 122 unit tests, 11/11
  e2e, dist rebuilt.
  ROOT CAUSE FOUND (the general one, not another edge): **the hub broadcasts
  only SETTLED statuses.** It writes "extracting"/"synthesizing" with setState
  and NO broadcast, and it NEVER writes "routing" at all — Phase 7 replaced
  that path (dispatchRun → "executing" directly), leaving the comment at
  index.ts:626 stale. So the panel's real observed sequence is
  `idle → sourceReady → review → executing → done(Port)`, while the table was
  written against the idealised sequence WITH the transients. Every
  "skip-the-transient" edge was therefore missing, and each one fails
  identically: operation succeeds, snapshot silently dropped, view never
  mounts.
  1. Fixed sourceReady → review (the reported bug) AND review → executing —
     which was the NEXT failure, already loaded: fixing only the reported edge
     would have moved the same symptom to the Automate button. Also added the
     error→settled retry edges and review/done → sourceReady (re-extract).
  2. executing stays DELIBERATELY narrow (["done"] + idle/error valves) — a
     stray mid-run snapshot must not blank the step log. Test asserts it.
  3. Parallel-truth notes eliminated everywhere, per gate run #2's rule:
     "Payload ready ✓" (same pattern as "Source captured ✓"), the
     Automating…/Dry-run-started info note (now gated on willAcceptSync), and
     the duplicate "Reply drafted ✓" tick (the done view already renders it
     from the same flag). Remaining notes are failures, in-progress states,
     and instructions only.
  4. willAcceptSync is generic over mapStatus, so it already covered these —
     it just wasn't WIRED into runSynthesize/automate. Now it is; a dropped
     SYNC reports PANEL_SYNC_REJECTED instead of faking success.
  Tests: panelSync.test.ts walks the COMPLETE path in one test + asserts each
  forward edge + the executing protection. **Verified to FAIL 3/15 against the
  pre-fix table** (incl. the not-yet-reported review → executing edge).
  LESSON (supersedes run #2's): don't test transition tables edge-by-edge as
  bugs surface — derive the table from what the hub ACTUALLY broadcasts, and
  walk the whole path in one test.
- **GATE 5 — Jira recipe rewritten to the captured modernised dialog
  (2026-09-10).** Changed; **NOT verified.** tsc clean, 127 unit tests, 12/12
  e2e, dist rebuilt.
  1. Selectors replaced from the human's live capture. Summary = fill on
     `[data-testid="issue-create-commons…input-field.textfield"], #summary-field,
     input[name="summary"]`. Description = fillRichText on `#ak-editor-textarea`
     (ProseMirror; the placeholder span is contenteditable=false and must never
     be the target — the id leads so that's structurally impossible). Create =
     `[data-testid="issue-create-modernised.ui.footer.create-button"]` plus a
     `[data-testid$="ui.footer.create-button"]` suffix fallback that survives
     the next "modernised"-style rename. Deliberately NO suffix match for
     summary — every base field shares `input-field.textfield`.
  2. PRIORITY: no step. The capture enumerated every dialog button and priority
     is not among them (hidden behind an uncaptured disclosure). Writing an
     `optional` step would need TWO invented selectors, and an always-skipping
     step is indistinguishable from a silently-wrong one — it just trains you
     to ignore skips. Recorded loudly in-file instead, with the two ways to
     enable it (capture the disclosure, or fold priority into the description).
     Unit test asserts the absence so re-adding a guess must change the test.
  3. NEW `optional` step flag + executor support. Skips ONLY
     SELECTOR_NOT_FOUND/OPTION_NOT_FOUND; SEND_DENIED and aborts are never
     skippable, and zod REFUSES optional on a `submits` step. Applied to: the
     open-dialog click (dialog may already be open) and every POST-SUBMIT step
     — once Create is clicked the issue EXISTS, so failing the run over a
     missing read-back reports a falsehood.
  4. Post-submit DOM is UNCAPTURED — success flag + `a[href*="/browse/"]`
     read-backs are unchanged guesses, now non-fatal. Need a capture of the
     post-create DOM to fix properly.
  5. FIXTURE corrected — and a measured browser fact worth keeping:
     **`document.execCommand("insertText")` fires NO beforeinput in Chromium**;
     it inserts natively and returns true, so insertRichText's fallback never
     runs. My first fixture modelled PM as beforeinput-only and thus FAILED a
     correct implementation. Real ProseMirror reads DOM mutations back via its
     DOMObserver, so the fixture now does that (MutationObserver → model minus
     placeholder), keeps a contenteditable=false placeholder, and still
     supports the synthetic-beforeinput fallback without double-inserting.
     Submit reads the MODEL.
- **GATE 6 — STOP-CLASS: a dry run reported "Ticket created" (2026-09-10).**
  Changed; **NOT verified.** tsc clean, 142 unit tests, 12/12 e2e, dist rebuilt.
  COULD A TICKET HAVE BEEN CREATED? No — not by this code path. In dry run the
  executor hard-skips the `submits` step and everything after it, so
  realisticClick is never called on Create; the only DOM write a dry run makes
  is highlight() (an inline outline it then restores).
  ROOT CAUSE: DoneView printed a HARDCODED "Ticket created ✓" whenever phase
  === "done", and dryRun existed nowhere in panel state, WorkflowState, or
  AUTOMATION_DONE — it was a parameter to automate() and nothing else. One
  completion path served both modes, so the panel could not have known.
  1. AUTOMATION_DONE now carries RunOutcome {dryRun, submitted, stepsExecuted,
     stepsSkipped, highlighted} from the executor — the only component that
     knows. `submitted` becomes true ONLY where a submits-step completes.
  2. describeRunOutcome() (panelMachine, PURE) is the single decider of what
     may be claimed: dry run → "nothing was submitted"; !submitted → "finished
     without submitting"; submitted+key → created; submitted+no key → warns
     about a possible duplicate on retry. Null outcome (stale target.js still
     resident) → never assumes success. DoneView renders ONLY this.
  3. GENERAL DEFECT, 4th instance — audited: also fixed the step log showing a
     green ✓ for SKIPPED steps. New distinct "skipped" status (dry-run submit
     skips + absent optional steps), rendered "–". A tick for work that never
     happened is the same lie in miniature.
  4. (d) ordering: "Dry run started…" was written by automate() AFTER its await
     resolved — which can be after the run already finished (hub broadcasts
     executing, content script completes a dry run in ms, RUN_DONE lands over
     the Port first). Note deleted; the executing view now states the mode from
     WorkflowState.runDryRun (hub truth, survives rehydrate).
  Tests: tests/runOutcome.test.ts asserts on the `claimsCreation` PROPERTY, not
  UI copy, incl. an exhaustive sweep over all flag combinations; e2e asserts
  the dry-run AUTOMATION_DONE carries dryRun:true/submitted:false at the wire.
  STILL UNKNOWN: why no fields appeared highlighted. Dry run is SUPPOSED not to
  fill (it highlights, and highlight() self-reverts after 1.5s) — so "Summary
  empty" is correct behaviour, not evidence the steps never ran. Need the step
  log from the next run to tell whether steps executed, skipped, or failed.
- **GATE 7 — silent executor + optional masking a prerequisite (2026-09-11).**
  Changed; **NOT verified.** tsc clean, 149 unit tests, 12/12 e2e, dist rebuilt.
  DEFECT A (executor reports nothing): could not be pinned to ONE cause,
  because FOUR independent silent-drop paths each produce that exact symptom —
  and every one was silent, which is why it was undiagnosable from outside.
  All four fixed and made loud:
  1. target.ts `if (!window.__swivelTargetLoaded)` SKIPPED listener
     registration on re-injection. The flag lives on the isolated world's
     window, which outlives a content-script context — so after an extension
     reload the flag is true, the old listener is dead, and a fresh injection
     attaches NOTHING while reporting success. Replaced with a cleanup hook:
     every injection removes the previous listener and installs its own
     (exactly one live listener, never zero).
  2. dispatchRun's `catch {}` swallowed the first sendMessage rejection with
     no log. Replaced by ensureExecutorReady(): PING → inject if silent → PING
     again; only a live PONG earns the payload. executeScript resolving proves
     the FILE ran, never that a listener is reachable.
  3. Hub relay dropped STEP/DONE/ERROR silently on three guards (not-a-tab,
     fromTab≠targetTabId, runId mismatch). Guards kept — all are correct — but
     every drop now logs its reason.
  4. panelMachine withHubFields never copied runId, so the panel kept the id
     adopted from the FIRST step it ever saw. runId is a hash of the payload,
     so any edit between runs changes it and every later step was rejected by
     the STEP guard. Now adopts hub.runId on entering executing.
  WATCHDOG (mandated): FIRST_STEP_TIMEOUT_MS=20s after dispatch; no step
  recorded → abortRun with typed EXECUTOR_SILENT naming the likely cause.
  Cleared on the first relayed event. NOT automatically tested — triggering it
  needs a tab that accepts injection but never answers; verify in-browser.
  DEFECT B (optional masked a prerequisite): step 1's click FAILED
  (SELECTOR_NOT_FOUND on the guessed nav Create selector) and `optional`
  recorded it as a benign skip; step 2 then waited for a dialog that could
  never appear. Compounding it, dry-run downgrades every click to a highlight,
  so that step could NOT have opened the dialog even with a correct selector.
  Re-scoped: zod now REFUSES `optional` on any step at or before the submit —
  a prerequisite must fail loudly. The open-dialog step is REMOVED (a guess
  that dry-run could never execute); the recipe now requires the dialog open
  and says so. Capture snippet for the nav Create control is in recipes.ts.
  DEFECT C: was already implemented the previous turn (describeRunOutcome +
  runOutcome.test.ts + skipped-status). Reported as still outstanding, most
  likely tested against a pre-fix build.
  OPEN UX GAP (flagged, not changed): after a dry run the panel sits in "done"
  and done→review is not a legal edge, so a dry-run→real-run requires Start
  over + re-extract + re-synthesize (another Gemini call). Needs a "Run for
  real" affordance AND the matching edge; deliberately not added mid-gate.
- **AT FINAL GATE — STOPPED.** Needs a human on a fresh Chrome profile:
  install prompts only Gmail; enabling Jira prompts for atlassian.net; Test
  selectors flags a broken selector; the 90s demo runs clean.
- **PROJECT FEATURE-COMPLETE (Phases 1–10).** Only the Final Gate remains.

## GATES (human, in a real browser — cannot be self-verified)

- **GATE 1** (before Phase 4): Phases 1–3 browser debt + real Gemini key.
- **GATE 2** (after Phase 7): dry-run then one real Jira create-issue.
- **GATE 3** (after Phase 9): full email→ticket→drafted-reply loop.
- **FINAL GATE** (after Phase 10): fresh-profile install + permission diet.

## BUILD REALITIES LOCKED IN (don't relitigate)

- Content scripts are per-entry IIFE passes selected by `--mode`
  (index→content.js, gmail→gmail.js, generic→generic.js). Shared code is
  duplicated into each bundle by design — classic scripts share nothing.
- `npm run clean` owns wiping dist/. NO build pass empties dist/
  (emptyOutDir:false everywhere) or the parallel watchers delete each
  other's output.
- generic.js is NOT in manifest content_scripts — the hub injects it with
  chrome.scripting.executeScript, riding activeTab or a host permission.
- One EXTRACT_REQUEST owner per tab: gmail.js on Gmail; generic.js
  (injected) elsewhere. content.js deliberately ignores EXTRACT_REQUEST so
  it can't shadow generic.js's response when both live on a target domain.
