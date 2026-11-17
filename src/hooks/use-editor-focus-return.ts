"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { DIALOG_SELECTOR } from "@/hooks/use-inert-outside-popup";
import {
  captureFocusReturn,
  elementByMarker,
  focusAndKeepInView,
  isHTMLElement,
  isPageRoot,
  RETURN_FOCUS_REGION_ATTRIBUTE,
  RETURN_FOCUS_TRIGGER_ATTRIBUTE,
  revealEditor,
  useReturnAttention,
  type FocusReturnAnchor,
} from "@/hooks/use-scroll-to-feedback";

/**
 * FOCUS INTO AND BACK OUT OF AN EDITOR A SURFACE OPENS ITSELF (#4087, #4115).
 *
 * The reveal and return halves of the attention rule, as one hook for a staged
 * section (`useSectionEditState` runs it) or a list whose per-row editor is its
 * own component. Every focus and scroll here goes through the primitives in
 * `use-scroll-to-feedback.ts`, the one home of that rule (#2934); this module
 * decides only WHICH element they act on.
 */

/**
 * What counts as a control the admin can edit, for the reveal into an opened
 * editor (#4115): the native form fields and the ARIA widgets the admin
 * primitives render in their place — a Radix checkbox, switch or select
 * trigger is a `button` carrying one of these roles. A plain button is not
 * one: Save, Cancel and Add row are actions, not the thing being edited.
 */
const EDITABLE_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"])',
  "select",
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...[
    "checkbox",
    "combobox",
    "radio",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
  ].map((role) => `[role="${role}"]`),
].join(", ");

/**
 * An unchecked native radio whose group already has a checked one: Tab lands
 * on the checked radio of a group and skips the rest, so the reveal does too.
 * The group is every radio sharing its `name` and its form owner.
 */
function isRadioTabSkips(element: HTMLElement) {
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.type !== "radio" || !element.name || element.checked) return false;
  return Array.from(
    element.ownerDocument.querySelectorAll('input[type="radio"]'),
  ).some(
    (other) =>
      other instanceof HTMLInputElement &&
      other !== element &&
      other.checked &&
      other.name === element.name &&
      other.form === element.form,
  );
}

/**
 * Whether a keyboard user could Tab to `element` and change it. `tabIndex < 0`
 * drops what Tab skips among the ARIA widgets: the hidden native input a Radix
 * checkbox or select keeps for form submission, and the unchecked radios of a
 * roving ARIA radio group. A native radio group gets Tab's own rule instead
 * ({@link isRadioTabSkips}), since every native radio has `tabIndex` 0.
 */
function isEditableControl(element: Element): element is HTMLElement {
  if (!isHTMLElement(element)) return false;
  if (!element.matches(EDITABLE_CONTROL_SELECTOR)) return false;
  if (element.matches(":disabled")) return false;
  if (element.tabIndex < 0) return false;
  if (isRadioTabSkips(element)) return false;
  if (
    element.getAttribute("aria-disabled") === "true" ||
    element.getAttribute("aria-readonly") === "true" ||
    (element as HTMLInputElement).readOnly === true
  ) {
    return false;
  }
  return !element.closest('[aria-hidden="true"], [inert], [hidden]');
}

function editableControlsIn(region: HTMLElement | null): HTMLElement[] {
  if (!region) return [];
  return Array.from(region.querySelectorAll(EDITABLE_CONTROL_SELECTOR)).filter(
    isEditableControl,
  );
}

/** What {@link captureEditorOpening} recorded as an editor was opened. */
export interface EditorOpening {
  /** The marker on the section the editor opens in. */
  regionId: string;
  /** The controls that were ALREADY editable before it opened. */
  editableBefore: ReadonlySet<Element>;
  /**
   * The open dialog the opening control sits in, when the section's own card is
   * outside it ({@link openingDialog}): the card is then hidden behind the modal,
   * and the editor the opening reveals is the one in the dialog. `null` for the
   * ordinary section whose Edit sits in its own card.
   */
  dialog: HTMLElement | null;
  /**
   * Where focus was when the opening ran, if that is where the admin opened
   * the editor from: `null` for the page, or the opening control itself. A
   * focus anywhere else — the admin moved on while a delayed opening awaited
   * a fetch — is recorded as `false`, and the reveal moves nothing.
   */
  openedFrom: HTMLElement | null | false;
}

/**
 * The dialog an opening control sits in, when the section's card is a separate
 * surface from it: neither around the control nor inside the dialog (#5183).
 * The analytics card is the one section like it: its card on the integrations
 * hub is a button, and Edit lives in the dialog the button opens, so the
 * reveal has to act in the dialog. Found from the control the opening started
 * on: the one carrying this opening's trigger marker, or else whatever holds
 * focus (a mouse click in a browser that does not focus buttons leaves nothing
 * focused, and the marker still leads to it).
 */
function openingDialog(
  triggerId: string | undefined,
  active: Element | null,
  region: HTMLElement | null,
): HTMLElement | null {
  const opener =
    elementByMarker(RETURN_FOCUS_TRIGGER_ATTRIBUTE, triggerId) ??
    (isHTMLElement(active) && !isPageRoot(active) ? active : null);
  const dialog = opener?.closest(DIALOG_SELECTOR);
  if (!isHTMLElement(dialog)) return null;
  return region?.contains(opener) || dialog.contains(region) ? null : dialog;
}

/**
 * Record which of the marked section's controls are already editable, and
 * where focus is, from the explicit action that opens its editor — before the
 * render that opens it. A scope select, a row's toggle or anything else the
 * admin could already change is then not mistaken for what the opening made
 * editable.
 *
 * Focus counts as still on the opening control when it is on the page (the
 * pressed control is gone, or nothing was focused), on the control carrying
 * this opening's trigger marker, or on a control inside the section that is
 * not itself editable. Anything else means the admin has moved on — an
 * opening that ran after an `await` ("Create override" seeds the editor from
 * a fetch first) found them typing elsewhere — and the reveal leaves them be.
 */
// test seam
export function captureEditorOpening(
  regionId: string,
  triggerId?: string,
): EditorOpening {
  if (typeof document === "undefined") {
    return {
      regionId,
      editableBefore: new Set(),
      dialog: null,
      openedFrom: false,
    };
  }
  const region = elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, regionId);
  const active = document.activeElement;
  let openedFrom: EditorOpening["openedFrom"] = false;
  if (isPageRoot(active)) {
    openedFrom = null;
  } else if (
    isHTMLElement(active) &&
    ((triggerId !== undefined &&
      active.getAttribute(RETURN_FOCUS_TRIGGER_ATTRIBUTE) === triggerId) ||
      (region?.contains(active) && !isEditableControl(active)))
  ) {
    openedFrom = active;
  }
  const dialog = openingDialog(triggerId, active, region);
  return {
    regionId,
    editableBefore: new Set(editableControlsIn(dialog ?? region)),
    dialog,
    openedFrom,
  };
}

/**
 * Whether the reveal may move focus now: the opening started where the admin
 * was, focus has not moved off it since (it is still there, or the render
 * dropped it to the page), and `scope`, where the reveal would act, is not
 * hidden behind a modal. A section whose Edit lives in a dialog rendered
 * outside it is `aria-hidden` while the dialog is open, so the reveal acts in
 * that dialog instead ({@link EditorOpening.dialog}). The dialog's own focus
 * scope does not do it: a browser drops focus from a control that has become
 * disabled, as Edit does when the editor's Save takes its place, and Radix's
 * focus scope notices only a removed node, so focus would be left on the page
 * behind the modal (#5183).
 */
// test seam
export function mayRevealOpenedEditor(
  opening: EditorOpening | null,
  scope: HTMLElement | null,
): boolean {
  if (!opening || opening.openedFrom === false) return false;
  if (typeof document === "undefined") return false;
  if (scope?.closest('[aria-hidden="true"], [inert]')) return false;
  const active = document.activeElement;
  return isPageRoot(active) || active === opening.openedFrom;
}

/**
 * REVEAL, for a staged section or list editor (#4115). Focus the first control
 * the opening made editable — mounted by it, or enabled by it — in document
 * order; when it made none (an editor with no form fields, or one rendered
 * outside the section), focus the section itself, the region its title names.
 * The first candidate that actually TAKES focus wins.
 *
 * An Edit that sits in a dialog outside the section's card (the analytics
 * card's) reveals inside that dialog instead, and a dialog editor that made no
 * control editable leaves focus to the dialog: the card behind the modal is
 * never a fallback. If that dialog has closed by the time the editor renders,
 * nothing is revealed (#5183).
 *
 * The scroll is `block: "nearest"`, unlike `revealEditor`'s `"start"`: the
 * admin pressed Edit (or Add, or a row's Edit) inside this section, so it is
 * already where they are looking, and the control moves only as far as it must
 * to be on screen. It moves focus off the opening control even when that
 * stays mounted — a row's Edit is not where the admin is going next — but off
 * nothing else ({@link mayRevealOpenedEditor}).
 */
// test seam
export function revealOpenedEditor(opening: EditorOpening | null) {
  if (!opening || typeof document === "undefined") return;
  const region = elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, opening.regionId);
  // The dialog stays the scope even if it has closed since: `editableBefore` was
  // taken from its controls, so the region cannot stand in for it (a control that
  // was already editable there would read as newly opened). A closed dialog has
  // no connected control to focus, so nothing is revealed.
  const scope = opening.dialog ?? region;
  if (!scope || !mayRevealOpenedEditor(opening, scope)) return;
  for (const control of editableControlsIn(scope)) {
    if (opening.editableBefore.has(control)) continue;
    if (focusAndKeepInView(control)) return;
  }
  if (!opening.dialog) focusAndKeepInView(region);
}

/**
 * Everything a surface needs to move focus into an editor it opens and back
 * out when it closes — `useSectionEditState` uses it for Edit, and a list
 * section whose per-row editor is its own component uses it directly.
 *
 *  - `capture(key)` from the action that opens the editor. It records where to
 *    return to and, once the editor has rendered, REVEALS it (#4115): focus
 *    goes to the first control the opening made editable, or to the section
 *    (`revealOpenedEditor`), or, for an Edit in a dialog outside the section's
 *    card, to the first control editable in that dialog. `revealTarget`
 *    replaces that with a `revealEditor` of the given element; it exists for
 *    the two sections whose card reveal predates #4115, and a new section
 *    omits it. Neither moves focus the admin has moved elsewhere, nor into a
 *    section hidden behind a modal (`mayRevealOpenedEditor`);
 *  - `close()` from every user action that closes it (Cancel, a successful
 *    save, a save conflict that closes the stale editor) — never from a scope
 *    change or a background refresh, which are not the admin leaving it;
 *  - `triggerProps(key)` on an opening control that is NOT mounted while the
 *    editor is open (Edit, Add), so its replacement can be found; a control
 *    that stays mounted (a per-row Edit) is returned to directly;
 *  - `regionProps` on the section's card, the fallback when the trigger is
 *    gone or disabled. It makes the card a `region` named by `titleProps`,
 *    which goes on the card's visible title, so a keyboard user who lands on
 *    the card hears its name rather than "group" (#2934) — or, for a card with
 *    no visible title of its own, by `regionLabel`.
 *
 * A list row's direct write (toggle, delete) returns through
 * `useRowActionFocusReturn` instead, by these same markers; why its anchor
 * handling is its own is written there (#4116, #4115).
 */
export function useEditorFocusReturn({
  regionLabel,
  revealTarget,
}: { regionLabel?: string; revealTarget?: RefObject<HTMLElement | null> } = {}) {
  const id = useId();
  const titleId = `${id}title`;
  const anchorRef = useRef<FocusReturnAnchor | null>(null);
  const [closeKey, setCloseKey] = useState(0);
  useReturnAttention(anchorRef, closeKey);

  // The reveal: keyed on the count of opens ONLY, so a re-render with the
  // editor already open moves nothing — not even one that hands in a new
  // `revealTarget` — and each open consumes its own record. The target is
  // read from a latest-ref, refreshed by the effect declared first.
  const openingRef = useRef<EditorOpening | null>(null);
  const revealTargetRef = useRef(revealTarget);
  const [openKey, setOpenKey] = useState(0);
  useEffect(() => {
    revealTargetRef.current = revealTarget;
  });
  useEffect(() => {
    if (!openKey) return;
    const opening = openingRef.current;
    openingRef.current = null;
    const target = revealTargetRef.current;
    if (target) {
      const region = opening
        ? elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, opening.regionId)
        : null;
      if (mayRevealOpenedEditor(opening, region)) revealEditor(target);
      return;
    }
    revealOpenedEditor(opening);
  }, [openKey]);

  const capture = useCallback(
    (key = "edit") => {
      anchorRef.current = captureFocusReturn({
        triggerId: `${id}${key}`,
        regionId: id,
      });
      openingRef.current = captureEditorOpening(id, `${id}${key}`);
      setOpenKey((count) => count + 1);
    },
    [id],
  );
  const close = useCallback(() => setCloseKey((count) => count + 1), []);
  const triggerProps = useCallback(
    (key = "edit") => ({ [RETURN_FOCUS_TRIGGER_ATTRIBUTE]: `${id}${key}` }),
    [id],
  );
  const regionProps = useMemo(
    () => ({
      [RETURN_FOCUS_REGION_ATTRIBUTE]: id,
      role: "region" as const,
      ...(regionLabel
        ? { "aria-label": regionLabel }
        : { "aria-labelledby": titleId }),
    }),
    [id, regionLabel, titleId],
  );
  const titleProps = useMemo(() => ({ id: titleId }), [titleId]);
  return useMemo(
    () => ({ capture, close, triggerProps, regionProps, titleProps }),
    [capture, close, triggerProps, regionProps, titleProps],
  );
}
