// @vitest-environment jsdom

// The reveal into an editor a surface opens itself (#4115): which control
// takes focus, and when the section does instead. The hook that runs it is
// exercised through `useSectionEditState` in its own suite and through the
// list editors in `list-editor-focus-return.test.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureEditorOpening,
  revealOpenedEditor,
} from "@/hooks/use-editor-focus-return";
import { RETURN_FOCUS_REGION_ATTRIBUTE } from "@/hooks/use-scroll-to-feedback";

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revealing an opened editor (#4115)", () => {
  function markedRegion(id = "section") {
    const region = document.createElement("div");
    region.setAttribute(RETURN_FOCUS_REGION_ATTRIBUTE, id);
    document.body.append(region);
    return region;
  }

  function control<K extends keyof HTMLElementTagNameMap>(
    region: HTMLElement,
    tag: K,
    attributes: Record<string, string> = {},
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    element.scrollIntoView = vi.fn();
    region.append(element);
    return element;
  }

  it("focuses the first control the opening made editable, moving only as far as it must", () => {
    const region = markedRegion();
    const scope = control(region, "select", { "aria-label": "Scope" });
    const name = control(region, "input", { disabled: "" });
    const size = control(region, "input", { disabled: "" });

    const opening = captureEditorOpening("section");
    // The render the opening caused: the fields come alive.
    name.disabled = false;
    size.disabled = false;
    revealOpenedEditor(opening);

    // The scope select was editable already, so it is not what Edit opened.
    expect(document.activeElement).toBe(name);
    expect(scope.scrollIntoView).not.toHaveBeenCalled();
    expect(name.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
  });

  it("takes a control the opening MOUNTED, and an ARIA widget standing in for one", () => {
    const region = markedRegion();
    const opening = captureEditorOpening("section");
    const toggle = control(region, "button", {
      role: "switch",
      "aria-checked": "false",
    });
    control(region, "input");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(toggle);
  });

  it("skips what Tab skips or cannot change, then falls back to the section", () => {
    const region = markedRegion();
    const opening = captureEditorOpening("section");
    // A Radix checkbox's hidden form input, a roving radio, a read-only
    // field, an aria-disabled widget, the actions, and an inert subtree.
    control(region, "input", { "aria-hidden": "true", type: "checkbox" });
    control(region, "button", { role: "radio", tabindex: "-1" });
    control(region, "input", { readonly: "" });
    control(region, "button", { role: "checkbox", "aria-disabled": "true" });
    control(region, "input", { type: "submit" });
    control(region, "input", { type: "hidden" });
    control(region, "button");
    const inert = control(region, "div", { inert: "" });
    inert.append(document.createElement("textarea"));
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(region);
    expect(region.getAttribute("tabindex")).toBe("-1");
  });

  it("falls back to the section when the opening made nothing editable", () => {
    const region = markedRegion();
    control(region, "input");
    const opening = captureEditorOpening("section");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(region);
  });

  it("looks only inside its OWN section", () => {
    const other = markedRegion("other");
    const region = markedRegion("section");
    const opening = captureEditorOpening("section");
    control(other, "input");
    const mine = control(region, "input");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(mine);
  });

  it("takes the checked radio of a native group, as Tab does", () => {
    const region = markedRegion();
    const first = control(region, "input", { type: "radio", name: "approval", disabled: "" });
    const second = control(region, "input", { type: "radio", name: "approval", disabled: "" });
    second.checked = true;
    const opening = captureEditorOpening("section");
    first.disabled = false;
    second.disabled = false;
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(second);
  });

  it("takes the first radio of a native group with none checked", () => {
    const region = markedRegion();
    const opening = captureEditorOpening("section");
    const first = control(region, "input", { type: "radio", name: "approval" });
    control(region, "input", { type: "radio", name: "approval" });
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(first);
  });

  it("moves nothing when focus left the opening control before the opening ran", () => {
    const region = markedRegion();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    const opening = captureEditorOpening("section", "trigger");
    control(region, "input");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(elsewhere);
  });

  it("still moves nothing when where the admin went is gone by the reveal", () => {
    // Focus left the opener before the opening ran, and the render then took
    // that control away too: the page holding focus is not a licence to move.
    const region = markedRegion();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    const opening = captureEditorOpening("section", "trigger");
    control(region, "input");
    elsewhere.remove();
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(document.body);
  });

  it("moves nothing when focus moved off the opening control after it ran", () => {
    const region = markedRegion();
    const opener = control(region, "button", {
      "data-return-focus-trigger": "trigger",
    });
    opener.focus();
    const opening = captureEditorOpening("section", "trigger");
    control(region, "input");
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(elsewhere);
  });

  it("moves off a marked opening control that is still mounted", () => {
    const region = markedRegion();
    const opener = control(region, "button", {
      "data-return-focus-trigger": "trigger",
    });
    opener.focus();
    const opening = captureEditorOpening("section", "trigger");
    const field = control(region, "input");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(field);
  });

  it("moves nothing into a section hidden behind a modal", () => {
    const region = markedRegion();
    region.setAttribute("aria-hidden", "true");
    const opening = captureEditorOpening("section");
    control(region, "input");
    revealOpenedEditor(opening);

    expect(document.activeElement).toBe(document.body);

    region.removeAttribute("aria-hidden");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("inert", "");
    document.body.append(wrapper);
    wrapper.append(region);
    revealOpenedEditor(captureEditorOpening("section"));
    expect(document.activeElement).toBe(document.body);
  });

  // The analytics card (#5183): its card is hidden behind the modal, Edit sits in
  // the dialog, and the render Edit causes disables the focused Edit (Save takes
  // its place) rather than removing it, so a browser drops focus to the page and
  // Radix's focus scope, which watches only removed nodes, never sees it.
  describe("an Edit in a dialog outside the section's card (#5183)", () => {
    function cardBehindDialog() {
      const card = markedRegion();
      card.setAttribute("aria-hidden", "true");
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      const edit = control(dialog, "button", {
        "data-return-focus-trigger": "trigger",
      });
      return { card, dialog, edit };
    }

    it("focuses the first control the opening made editable in the dialog, not the hidden card", () => {
      const { card, dialog, edit } = cardBehindDialog();
      const id = control(dialog, "input", { disabled: "" });
      const message = control(dialog, "textarea", { disabled: "" });
      edit.focus();

      const opening = captureEditorOpening("section", "trigger");
      expect(opening.dialog).toBe(dialog);
      // The render the opening caused: the fields come alive and the focused
      // Edit is disabled, which a browser answers by dropping focus to the page.
      id.disabled = false;
      message.disabled = false;
      edit.disabled = true;
      revealOpenedEditor(opening);

      expect(document.activeElement).toBe(id);
      expect(card.contains(document.activeElement)).toBe(false);
      expect(id.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
      });
    });

    it("finds the dialog from the trigger marker when a click focused nothing", () => {
      const { dialog, edit } = cardBehindDialog();
      const field = control(dialog, "input", { disabled: "" });
      edit.blur();

      const opening = captureEditorOpening("section", "trigger");
      field.disabled = false;
      revealOpenedEditor(opening);

      expect(opening.dialog).toBe(dialog);
      expect(document.activeElement).toBe(field);
    });

    it("skips a control the dialog could already edit", () => {
      const { dialog, edit } = cardBehindDialog();
      const scope = control(dialog, "select", { "aria-label": "Scope" });
      const field = control(dialog, "input", { disabled: "" });
      edit.focus();

      const opening = captureEditorOpening("section", "trigger");
      field.disabled = false;
      revealOpenedEditor(opening);

      expect(document.activeElement).toBe(field);
      expect(scope.scrollIntoView).not.toHaveBeenCalled();
    });

    it("never falls back to the hidden card when the dialog's editor made nothing editable", () => {
      const { card, edit } = cardBehindDialog();
      edit.focus();

      revealOpenedEditor(captureEditorOpening("section", "trigger"));

      expect(document.activeElement).toBe(edit);
      expect(card.contains(document.activeElement)).toBe(false);
    });

    it("moves nothing once focus has gone to another control in the dialog", () => {
      const { dialog, edit } = cardBehindDialog();
      const field = control(dialog, "input", { disabled: "" });
      const other = control(dialog, "input");
      edit.focus();

      const opening = captureEditorOpening("section", "trigger");
      field.disabled = false;
      other.focus();
      revealOpenedEditor(opening);

      expect(document.activeElement).toBe(other);
    });

    it("reveals nothing when the dialog has closed by the time the editor renders", () => {
      const { card, dialog, edit } = cardBehindDialog();
      // Editable in the card all along, so it was never in the dialog's baseline.
      const scope = control(card, "select", { "aria-label": "Scope" });
      edit.focus();

      const opening = captureEditorOpening("section", "trigger");
      expect(opening.dialog).toBe(dialog);
      // The dialog closes as the editor opens: the card is no longer behind a modal.
      dialog.remove();
      card.removeAttribute("aria-hidden");
      revealOpenedEditor(opening);

      // Falling back to the card would compare its controls with the dialog's
      // baseline and treat the select as newly opened.
      expect(scope.scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves a section whose card holds its own Edit to the ordinary reveal", () => {
      const card = markedRegion();
      const field = control(card, "input", { disabled: "" });
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      card.append(dialog);
      const edit = control(dialog, "button", {
        "data-return-focus-trigger": "trigger",
      });
      edit.focus();

      const opening = captureEditorOpening("section", "trigger");
      // The dialog is inside the card, so it is not a separate surface.
      expect(opening.dialog).toBeNull();
      field.disabled = false;
      revealOpenedEditor(opening);

      expect(document.activeElement).toBe(field);
    });
  });

  it("moves nothing when there is no record or no marked section", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    revealOpenedEditor(null);
    revealOpenedEditor(captureEditorOpening("missing"));

    expect(document.activeElement).toBe(document.body);
  });
});
