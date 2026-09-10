# Swivel — The Cross-Tab Automator

Chrome extension (Manifest V3) that turns your browser into an ad-hoc API:
extract context from a source tab (a Gmail thread), structure it into strict
JSON via the Gemini API, and inject it into a *different* open tab (Jira
Cloud) by automating client-side DOM inputs — then draft (never send) a
reply back in Gmail with the new ticket link.

**No backend, no OAuth.** Your existing, already-authenticated browser
session is the auth. Swivel automates the tabs *you* are already logged into.

**Status: feature-complete (Phases 1–10).** See `CLAUDE.md` for the
engineering charter and the phase-by-phase progress log.

## What it does (the loop)

1. **Extract** the open Gmail thread (subject, sender, cleaned body).
2. **Synthesize** it into a structured payload with Gemini (in the service
   worker; the key never touches a page).
3. **Review/edit** the payload in the side panel.
4. **Automate** it into an open Jira Cloud tab — fill fields, pick the
   priority, submit — with a dry-run mode and an explicit confirm gate.
5. **Read back** the new issue key/URL from Jira's success screen.
6. **Draft** a templated reply in the Gmail thread with the ticket link,
   left **unsent** for you to review.

## Positioning & honest limits

- Swivel automates **your own authenticated sessions** for **your own**
  productivity. It is not a bot farm, a scraper, or a bypass of anyone's
  access controls — it can only do what you, logged in, can already do by
  hand.
- **Workplace policy / site terms:** automating a SaaS UI can conflict with
  your employer's policy or a site's terms of service. That's your call to
  make before you use it. Swivel makes the automation explicit and
  confirm-gated precisely so nothing happens without your intent.
- **Sending stays human, permanently.** Swivel drafts email replies; it has
  no code path that can click Gmail's Send, and the executor refuses any
  recipe step that targets a Send control (enforced + tested).
- **Selectors drift.** Jira/Gmail are SPAs with changing DOMs. The Jira and
  Gmail selectors are best-effort; **Settings → Test selectors** reports
  which of a recipe's selectors still resolve, as an early warning.
- **Double-submit is the worst failure**, so it's guarded three ways: a
  dry-run mode, an explicit confirm step, and a runId idempotency guard that
  refuses to submit the same payload twice.

## Data flow (what leaves your browser)

**Exactly one thing leaves your machine: the Gemini API call you configure.**
The extracted email text is sent to `generativelanguage.googleapis.com`
using **your** API key to produce the structured payload. Nothing else is
transmitted anywhere — no telemetry, no server, no third party. The API key
lives in `chrome.storage.local` on your machine, is read only inside the
service worker, and is not a field on any message type (so it structurally
cannot be routed to a web page).

## Install (load unpacked)

```
npm install
npm run build         # → dist/
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`dist/`. A fresh install prompts for **Gmail only**. Then:

- **Settings (⚙) → paste your Gemini API key** — this grants the Gemini
  endpoint permission on save.
- **Settings → Targets → enable "Jira Cloud — Create issue"** — this prompts
  for `atlassian.net` access. Access to a site is requested only when you
  turn its target on.

## Dev loop

```
npm run watch     # clean + build once, then parallel watchers (app + content IIFEs)
npm test          # vitest unit suites (pure logic)

# End-to-end (drives the ACTUAL loaded extension):
npx playwright install chromium   # one-time — Chrome for Testing (see below)
npm run test:e2e                  # build:test → dist-test/ → Playwright
```

After each save, click **Reload** (⟳) on the extension card. If a content
script changed, also reload the page it runs on. No HMR by design (MV3 CSP +
the worker lifecycle fight dev servers).

**Content scripts are separate build passes**: they're injected as *classic*
scripts (no ES modules / chunk imports), so `vite.content.config.ts`
produces one self-contained IIFE per entry (`--mode target|gmail|generic`).
Shared code is duplicated into each — correct and expected. `npm run clean`
wipes `dist/`; no build pass empties it, so the parallel watchers never
delete each other's output.

**e2e needs Chrome for Testing.** `--load-extension` only works in
Playwright's Chromium — recent stable Chrome/Edge disabled that flag. The
harness builds a dev-only `dist-test/` (never the shippable `dist/`),
`--load-extension`s it, and drives the panel through the real extension,
resolving the extension id from the live service worker.

## Permissions (least privilege — Charter Law 7)

Install-time is deliberately minimal; enterprise access is requested at
runtime when you opt in.

| Permission | When | Why |
|---|---|---|
| `sidePanel` | install | The React control center lives in the side panel. |
| `activeTab` | install | Temporary access to the tab you invoked Swivel on — source extraction without broad host access. |
| `scripting` | install | Inject `generic.js` / `target.js` on demand into the tab you're acting on. |
| `tabs` | install | Find the destination tab by URL pattern; read titles for the tab picker. |
| `storage` | install | `storage.session` = workflow state across worker deaths; `storage.local` = your Gemini key + settings. |
| `webNavigation` | install | Detect pushState navigation of the target mid-run → clean abort instead of injecting into a page that routed away. |
| `https://mail.google.com/*` | **install** | Read the open thread; draft (never send) the reply. |
| `https://*.atlassian.net/*` | **runtime** (optional) | Jira Cloud target — requested when you enable the Jira recipe. |
| `https://generativelanguage.googleapis.com/*` | **runtime** (optional) | The worker's Gemini `fetch` (no CORS exemption without it) — requested when you save your key. |

**UX tradeoff:** moving Jira + Gemini to `optional_host_permissions` means a
fresh install asks for the least (just Gmail), and the scary "read your data
on atlassian.net" prompt appears only if/when you actually enable Jira —
right where the intent is. The cost is one extra permission prompt at
enable-time instead of at install.

**Content-script registration:** `gmail.js` is statically registered for
`mail.google.com` (install-time). `target.js` (the injection executor) and
`generic.js` are **not** statically registered — the hub injects them on
demand via `chrome.scripting`, which is why Jira needs no install-time host
permission. The `swivel-extract` command (Ctrl/Cmd+Shift+E) is a user
gesture, which is what makes both `sidePanel.open()` and the on-demand
`activeTab` injection valid from a keypress.

## Security model

- **API key:** `chrome.storage.local`, worker-read only, absent from the
  message union — unroutable to a page. Honest threat model: this protects
  against leakage into pages/messages, **not** against you inspecting your
  own extension.
- **Hub is the only router.** Content scripts and the panel never talk
  directly. The hub validates every sender: panel-only actions require an
  extension-page origin (`chrome-extension://<id>/…`); run events must come
  from the current target tab for the current runId.
- **LLM output is untrusted** — Gemini's JSON is zod-validated before it's
  persisted or shown, with one repair retry.
- **Send-denial law** is enforced in the executor (`sendGuard.ts` +
  `assertNoSend`), in two layers (selector string + element accessible
  name), and unit- + e2e-tested.

## Test & package

- `npm test` — vitest unit suites (cleanText, payload/zod, Gemini with
  mocked fetch, the panel reducer, recipes/URL matching, the Send guard).
- `npm run test:e2e` — Playwright against the adversarial mock SPA in
  `tests/fixtures/spa` (reverts naive `.value` writes, pointer-gated
  combobox, delayed render): full run, dry-run, broken selector, abort,
  navigation interrupt, panel-reload replay, double-click, Send-denial,
  idempotency.
- `npm run package` — production build + zip of `dist/`, with a guard that
  asserts no dev-only (`dist-test`) artifact is included in the shippable
  zip.

## Verification gates (the ones a human ran)

- **Gate 1** — extension loads (Gmail only); extract → synthesize works with
  a real key; worker-death mid-synthesis recovers cleanly.
- **Gate 2** — dry-run the Jira recipe against real Jira Cloud (fix any
  stale selectors via the reported `SELECTOR_NOT_FOUND`), then one real
  create on a throwaway project.
- **Gate 3** — the full loop on real tabs: email → extract → synthesize →
  review → automate → Jira issue created → key read back → **unsent** reply
  draft in Gmail compose.
- **Final gate** — fresh Chrome profile: install prompts only Gmail;
  enabling the Jira recipe prompts for `atlassian.net`; **Test selectors**
  flags a deliberately broken selector; the demo below runs clean.

## 90-second demo script (for the portfolio recording)

1. (0:00) Open a support email in Gmail. Open the Swivel side panel.
2. (0:10) **Extract from this tab** → cleaned subject/sender/body appear.
3. (0:20) **Synthesize → payload** → structured title / customer / priority
   / summary appear in the review form. Tweak one field.
4. (0:35) Target = **Jira Cloud — Create issue**. Leave **Dry run** on →
   **Automate to target…** → **Run dry run**. Watch the fields on the Jira
   tab get outlined; nothing is submitted.
5. (0:50) Turn **Dry run** off → **Automate to target…** → **Confirm & run**.
   The step log goes green; the Jira issue is created.
6. (1:10) The done view shows the **new issue key/link** (read back from
   Jira). Click **Draft reply in Gmail**.
7. (1:20) Switch to Gmail: a reply is open in the compose box with the
   ticket link — **unsent**. **Start over.** (1:30)
