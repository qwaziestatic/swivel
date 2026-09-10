/**
 * src/content/lib/inject.ts — the DOM write primitives.
 *
 * These are the ONLY sanctioned ways Swivel mutates a target page. They
 * exist because modern SPAs (React, Salesforce Lightning, ProseMirror-based
 * editors) do NOT observe naive DOM writes — Charter Law 5. Each function
 * documents exactly why the naive approach fails and why this one works.
 * The adversarial fixture (tests/fixtures/spa) reverts anything that cuts a
 * corner here, so these are verified against a hostile target in CI.
 */

/**
 * Set the value of an <input>/<textarea> so a React/Lightning controlled
 * component actually notices.
 *
 * WHY plain `el.value = x` fails: controlled components install their OWN
 * setter on the element's `value` property (a "value tracker"). Assigning
 * through it updates the element AND the tracker's notion of the current
 * value, so when the framework later handles an input/change event it sees
 * "no change from what I last set" and never runs onChange — the component
 * state stays stale and, on the next render, the DOM value is reverted.
 *
 * The fix: grab the setter from the PROTOTYPE (HTMLInputElement.prototype /
 * HTMLTextAreaElement.prototype), which bypasses the instance-level tracker.
 * The tracker is now out of date, so the bubbling `input` event we dispatch
 * registers as a real change and the framework updates its state. `change`
 * covers listeners that only watch commit.
 */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    // Extremely old engine without the descriptor — best effort.
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Insert text into a contenteditable rich-text editor (Jira description,
 * Gmail compose).
 *
 * WHY execCommand, though deprecated: rich editors (ProseMirror, Draft.js,
 * Lightning's rich text) maintain their OWN document model and reconcile
 * the DOM against it. Setting el.textContent/innerHTML is overwritten on the
 * editor's next render. execCommand('insertText') routes through the
 * browser's editing pipeline, which the editor DOES observe (selection,
 * beforeinput/input, undo stack) — it remains the single most compatible
 * insertion path across editors. The InputEvent fallback covers the rare
 * editor that has moved off execCommand.
 */
export function insertRichText(el: HTMLElement, text: string): void {
  el.focus();

  // Collapse the selection to the end of the editor for a clean append.
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    // Fallback: some editors listen for beforeinput/input directly.
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      })
    );
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  }
}

/**
 * Click an element with a FULL, realistic pointer sequence.
 *
 * WHY not el.click(): many frameworks (and our fixture's combobox) gate
 * their behavior on pointer events — they open menus on pointerdown, track
 * pointerup, etc. A lone synthetic `click` (or el.click()) skips all of
 * that and is ignored. We fire the whole sequence
 * (pointerdown → mousedown → pointerup → mouseup → click), all bubbling,
 * with coordinates at the element's center so any coordinate-sensitive
 * handler behaves.
 */
export function realisticClick(el: Element): void {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, view: window };

  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, button: 0 }));
}

/**
 * Dry-run affordance: briefly outline an element that WOULD be acted on,
 * then restore its prior inline outline so the page is left unchanged.
 * Purely visual; performs no page mutation of record.
 */
export function highlight(el: Element, durationMs = 1500): void {
  const style = (el as HTMLElement).style;
  const prev = style.outline;
  const prevOffset = style.outlineOffset;
  style.outline = "2px solid #6366f1";
  style.outlineOffset = "1px";
  setTimeout(() => {
    style.outline = prev;
    style.outlineOffset = prevOffset;
  }, durationMs);
}
