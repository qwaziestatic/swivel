/*
 * tests/fixtures/spa/app.js — the ADVERSARIAL mock SPA.
 *
 * Framework-free, but engineered to behave like React/Lightning so that any
 * shortcut in the Swivel injection engine (inject.ts, Phase 7) is caught
 * HERE, in CI, instead of live Jira catching it in the demo. Three traps:
 *
 *  1. Delayed render (~800ms): nothing to select until the form appears, so
 *     the engine's waitForElement is exercised for real.
 *
 *  2. Controlled inputs: a React-faithful value tracker. A naive
 *     `el.value = x` goes through an INSTANCE-level value setter that also
 *     records the value as "known", so a following input event sees no
 *     change and the model is NOT updated — and the display is reverted.
 *     Only the prototype-level native setter (which bypasses the instance
 *     override) followed by a real input event updates the model. The
 *     submitted ticket is built from the MODEL, never from el.value, so a
 *     shortcut produces an empty/stale ticket and the test fails.
 *
 *  3. Pointer-gated combobox: opens only after a full pointer sequence
 *     (pointerdown → … → click). A bare element.click() is ignored.
 */

(function () {
  "use strict";

  // Render delay is overridable via ?delay=N so resilience tests can widen
  // the window in which the form is not yet present (Phase 8).
  const params = new URLSearchParams(location.search);
  const DELAY_MS = Number(params.get("delay")) || 800;
  const SUBMIT_MS = 600;

  /** Install a React-like controlled-input tracker on an input/textarea. */
  function makeControlled(el) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    let model = "";
    let known = ""; // the value the "framework" believes is current

    // Instance-level override: a naive assignment updates `known` too, which
    // is exactly why a subsequent input event won't register as a change.
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        known = String(v);
        desc.set.call(this, v);
      },
    });

    el.addEventListener("input", () => {
      const raw = desc.get.call(el); // the real DOM value
      if (raw !== known) {
        // A genuine change: real typing, or the native-setter path (which
        // left `known` stale). Accept it.
        model = raw;
        known = raw;
      } else {
        // No tracked change — revert the display to the model. This is what
        // punishes a naive `el.value = x` (which set known === raw).
        desc.set.call(el, model);
      }
    });

    el.__model = () => model;
  }

  function renderForm() {
    document.getElementById("loading").remove();
    const app = document.getElementById("app");
    app.innerHTML = `
      <form data-testid="ticket-form" onsubmit="return false">
        <label for="title">Title</label>
        <input id="title" data-testid="title-input" />

        <label for="customer">Customer ID</label>
        <input id="customer" data-testid="customer-input" />

        <label>Priority</label>
        <div class="combobox" data-testid="priority-combobox" role="combobox"
             aria-expanded="false" tabindex="0">Select priority…</div>
        <div data-testid="listbox-host"></div>

        <label>Description</label>
        <!-- ProseMirror-style: model-backed, placeholder is contenteditable=false.
             See setupRichTextEditor — direct DOM writes are reconciled away. -->
        <div data-testid="description-editor" contenteditable="true" role="textbox"
             aria-label="Description area, start typing to enter text."></div>

        <button type="button" data-testid="submit-button">Create ticket</button>
        <!-- Decoy "Send" control: named only by aria-label, so a hostile
             recipe targeting it by testid must be caught by the executor's
             element-level Send guard, not the selector string. -->
        <button type="button" data-testid="decoy-send" aria-label="Send" class="decoy">Send</button>
      </form>
      <p style="margin-top:1rem">
        <a href="/other" data-testid="route-link">Go to another view (pushState)</a>
      </p>
    `;

    makeControlled(app.querySelector('[data-testid="title-input"]'));
    makeControlled(app.querySelector('[data-testid="customer-input"]'));

    setupCombobox(app);
    setupRichTextEditor(app);
    setupSubmit(app);
    setupRouteLink(app);
  }

  // --- ProseMirror-style rich text editor ----------------------------------
  //
  // WHY THIS IS NOT JUST A BARE CONTENTEDITABLE (Gate 5): the real Jira target
  // uses the Atlassian Editor (ProseMirror). The properties that actually
  // matter for our injection path, and that this fixture reproduces:
  //
  //   1. IT IS NOT AN INPUT. There is no `.value`, so the `fill` step's
  //      native-setter path cannot work on it — only `fillRichText` can. This
  //      is the distinction the Jira recipe hinges on.
  //   2. It keeps a SEPARATE document model from the DOM, and the submitted
  //      record is built from the MODEL. Text that only ever touched the DOM
  //      projection does not count.
  //   3. It carries a contenteditable="false" PLACEHOLDER inside the editor,
  //      so a recipe that mistakenly targets the placeholder gets a realistic
  //      no-op instead of appearing to work.
  //
  // HOW THE MODEL IS MAINTAINED — corrected after measuring the real browser
  // rather than assuming. My first version had the model accept text ONLY via
  // beforeinput, on the theory that ProseMirror ignores DOM writes. Measured
  // in Chromium: document.execCommand("insertText") fires NO beforeinput at
  // all — it inserts natively and returns true, so insertRichText's
  // beforeinput fallback never runs. A beforeinput-only model would therefore
  // have failed a CORRECT implementation.
  //
  // ProseMirror actually works the other way round: its DOMObserver READS
  // observed DOM mutations back into the model (that is how ordinary typing
  // and IME work at all). So this mirrors that — MutationObserver → read the
  // editor's text, minus the placeholder, into the model.
  const PLACEHOLDER_TEXT = "Describe the problem…";
  let descriptionModel = "";

  function setupRichTextEditor(app) {
    const ed = app.querySelector('[data-testid="description-editor"]');

    const placeholderEl = () => ed.querySelector('[data-testid="description-placeholder"]');

    const addPlaceholder = () => {
      if (placeholderEl()) return;
      const ph = document.createElement("span");
      ph.setAttribute("contenteditable", "false"); // exactly like Jira's
      ph.setAttribute("data-testid", "description-placeholder");
      ph.className = "placeholder";
      ph.textContent = PLACEHOLDER_TEXT;
      ed.insertBefore(ph, ed.firstChild);
    };

    /** The model text = everything in the editor EXCEPT the placeholder. */
    const readFromDOM = () => {
      const ph = placeholderEl();
      let text = ed.textContent;
      if (ph && text.startsWith(ph.textContent)) text = text.slice(ph.textContent.length);
      return text;
    };

    const sync = () => {
      const next = readFromDOM();
      if (next === descriptionModel) return;
      descriptionModel = next;
      if (descriptionModel) {
        const ph = placeholderEl();
        if (ph) ph.remove();
      } else {
        addPlaceholder();
      }
    };

    new MutationObserver(sync).observe(ed, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // The OTHER injection path: a synthetic beforeinput that carries the text
    // but performs no default action (insertRichText's fallback, used when
    // execCommand reports failure). Nothing mutates, so the observer above
    // would never see it. Apply it here — but only if the DOM really did not
    // change, so a browser that DOES fire beforeinput for execCommand cannot
    // cause a double insert.
    ed.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertText" || typeof e.data !== "string") return;
      const before = readFromDOM();
      const data = e.data;
      queueMicrotask(() => {
        if (readFromDOM() !== before) return; // native insertion already landed
        const ph = placeholderEl();
        if (ph) ph.remove();
        ed.appendChild(document.createTextNode(data));
        sync();
      });
    });

    ed.__model = () => descriptionModel;
    addPlaceholder();
  }

  // --- Pointer-gated priority combobox -------------------------------------
  const PRIORITIES = ["low", "medium", "high", "urgent"];
  let priorityModel = "";

  function setupCombobox(app) {
    const combo = app.querySelector('[data-testid="priority-combobox"]');
    const host = app.querySelector('[data-testid="listbox-host"]');
    let armed = false; // set by pointerdown; a bare click() never arms it

    combo.addEventListener("pointerdown", () => {
      armed = true;
    });
    combo.addEventListener("click", () => {
      if (!armed) return; // ignore synthetic clicks with no pointer sequence
      armed = false;
      if (host.querySelector('[role="listbox"]')) {
        closeListbox(host, combo);
        return;
      }
      openListbox(host, combo);
    });
  }

  function openListbox(host, combo) {
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    for (const p of PRIORITIES) {
      const opt = document.createElement("div");
      opt.setAttribute("role", "option");
      opt.textContent = p; // exact match target for selectOption
      opt.addEventListener("click", () => {
        priorityModel = p;
        combo.textContent = p;
        closeListbox(host, combo);
      });
      list.appendChild(opt);
    }
    host.appendChild(list);
    combo.setAttribute("aria-expanded", "true");
  }

  function closeListbox(host, combo) {
    host.innerHTML = "";
    combo.setAttribute("aria-expanded", "false");
  }

  // --- Submit → spinner → success screen -----------------------------------
  function setupSubmit(app) {
    const btn = app.querySelector('[data-testid="submit-button"]');
    btn.addEventListener("click", () => {
      const title = app.querySelector('[data-testid="title-input"]').__model();
      const customer = app.querySelector('[data-testid="customer-input"]').__model();
      // Read the MODEL, not the DOM — a naive write that only touched the
      // projection must not show up in the submitted ticket.
      const description = app
        .querySelector('[data-testid="description-editor"]')
        .__model()
        .trim();

      // Spinner first, then success — so waitForGone(spinner) has real work.
      app.innerHTML = `<p class="spinner" data-testid="submit-spinner">Submitting…</p>`;
      setTimeout(() => {
        const id = "FIX-" + Math.floor(1000 + Math.random() * 9000);
        app.innerHTML = `
          <div data-testid="success-screen">
            <h2>Ticket created</h2>
            <p>ID: <b data-testid="ticket-id">${id}</b></p>
            <a data-testid="issue-link" href="/browse/${id}">${id}</a>
            <dl>
              <dt>Title</dt><dd data-testid="submitted-title">${escapeHtml(title)}</dd>
              <dt>Customer</dt><dd data-testid="submitted-customer">${escapeHtml(customer)}</dd>
              <dt>Priority</dt><dd data-testid="submitted-priority">${escapeHtml(priorityModel)}</dd>
              <dt>Description</dt><dd data-testid="submitted-description">${escapeHtml(description)}</dd>
            </dl>
          </div>`;
      }, SUBMIT_MS);
    });
  }

  // --- pushState route change (Phase 8 navigation tests) -------------------
  function setupRouteLink(app) {
    const link = app.querySelector('[data-testid="route-link"]');
    link.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState({}, "", "/other");
      document.getElementById("app").innerHTML =
        '<p data-testid="other-view">Another view (client-side routed).</p>';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  // Deliberate delay: the form does not exist at load time.
  setTimeout(renderForm, DELAY_MS);
})();
