"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";

/**
 * THE ONE HOME FOR "WHERE DOES THE ADMIN'S ATTENTION GO AFTER AN ACTION" (#2934)
 * — and the member's too. Built for the admin tree, it also positions the member
 * booking wizard's failures (`/book`, #4945): a refused create, waitlist join or
 * draft focuses the wizard's error box or "fully booked" card through
 * `scrollToError`, wherever on the page the member pressed the button.
 *
 * An admin action ends in one of four places, and each has one primitive here:
 *
 *  - **failure** → `scrollToError`: the actionable message or invalid control
 *    takes focus and comes into view. Failure always wins over success.
 *  - **reveal** → `revealEditor`: an editor the admin explicitly opened (Edit,
 *    New, a per-row pencil) takes focus and comes into view — never because the
 *    content merely re-rendered. A staged section or list editor gets it without
 *    wiring (#4115): `useEditorFocusReturn`'s `capture`
 *    (`use-editor-focus-return.ts`, which builds on the primitives here, and
 *    which `useSectionEditState`'s `startEditing` calls) sends focus to the
 *    first control the opening made editable, or to the section when it made
 *    none.
 *  - **success / step transition** → `scrollToTop`: the resulting page, card or
 *    step is positioned at its top and takes focus, so the confirmation and the
 *    new state are what a keyboard or screen-reader user lands on.
 *  - **return** → `returnFocus`: closing an editor (Save, Cancel) or failing a
 *    save in a way that dropped focus to the page hands it back to where the
 *    action started — the Edit button, the re-enabled Save, or the section
 *    around them — and moves nothing otherwise (#4087). It acts only while
 *    focus is on the page, so a failure or success position taken in the same
 *    commit still wins.
 *
 * Passive updates — a background refresh, a poll, a re-render with the same
 * message — move nothing. The hooks below encode that: `useActionAttention` fires
 * only when a message ARRIVES and refuses the success position while a failure
 * is showing; `useRevealAttention` fires only when its explicit-action key
 * changes; `useReturnAttention` (and `useEditorFocusReturn`, which wraps it for
 * a surface that opens and closes its own editor, in
 * `use-editor-focus-return.ts`) fires only when its close key changes, and
 * consumes what it was given; that hook's reveal fires only when its `capture`
 * runs, and consumes its record the same way.
 *
 * Every scroll in this module honours `prefers-reduced-motion` through
 * `resolveScrollBehavior`, and every focus is applied with `preventScroll` first
 * so the scroll that follows is the one this module chose rather than the
 * browser's default jump. Nothing here uses a timer: the caller's own state
 * (a message string, an edit nonce) drives the effect, so the transition lands in
 * the commit that produced it.
 *
 * `admin-attention-primitive-contract.test.ts` keeps the admin tree and the
 * `/book` wizard routed through this module — a direct `scrollIntoView` /
 * `scrollTo` or a `requestAnimationFrame`-driven focus outside it fails that
 * census. The standing exclusions are listed in {@link DIRECT_SCROLL_EXCLUSIONS},
 * next to the fact each excludes (`INV-SSOT-001`).
 *
 * WHAT THE CENSUS DOES NOT HOLD, stated here rather than left to be inferred
 * from "the one home": a bare effect-driven `.focus()` passes it, and four
 * admin surfaces still hand-roll their attention that way —
 * `hut-leaders/page.tsx` (failure, twice), `xero/setup/xero-wizard-steps.tsx`
 * (success), `integration-wizard/integration-wizard.tsx` (step transition,
 * with its own arrival-detection ref) and `fees/_components/hut-fees-section.tsx`
 * (the copy notice, with a hand-rolled counter). They are not excluded, they
 * are unconverted. A census over every effect-driven focus was measured and
 * rejected: ten admin effects focus something, and six of them — a caret
 * restore, a combobox, the display builder — are not attention at all, so the
 * list would be ten exemptions enforcing nothing.
 */

type ElementRef = RefObject<HTMLElement | null>;
type ScrollContainerTarget = HTMLElement | ElementRef | null | undefined;
type ScrollErrorTarget = HTMLElement | ElementRef | string | null | undefined;

/**
 * Where the target lands in the viewport: under the sticky header, centred, or
 * — for a return to where the admin already was — wherever it moves least.
 */
export type AttentionBlock = "start" | "center" | "nearest";

export interface AttentionOptions {
  /** Defaults to `"start"`; the recovery alerts centre themselves. */
  block?: AttentionBlock;
}

/**
 * Censused files allowed a direct `scrollIntoView` / `scrollTo` call, with the
 * reason. Each entry is a deep link or a layout concern this module cannot
 * express. Shrinking this list is the ratchet; a new entry is a decision to
 * record here.
 */
export const DIRECT_SCROLL_EXCLUSIONS: ReadonlyArray<{
  file: string;
  reason: string;
}> = [
  {
    file: "src/app/(admin)/admin/members/[id]/page.tsx",
    reason:
      "the /admin/members/[id]#account-credit deep link scrolls once the collapsed Finance accordion has finished expanding — a navigation restore, not an action result",
  },
  {
    file: "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts",
    reason:
      "a successful card booking moves the wizard to its pay step and scrolls the WINDOW to the top (#1084, #4945). The member layout scrolls the document rather than a container, and `scrollToTop` only scrolls the nearest overflow container, so it would focus the step without moving the page. The jump is instant, so reduced motion is not at stake",
  },
];

const FEEDBACK_SCROLL_MARGIN_TOP = "5rem";

export function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function resolveElement(target: ScrollContainerTarget): HTMLElement | null {
  if (!target) return null;
  if (isHTMLElement(target)) return target;
  return target.current;
}

function resolveFeedbackElement(target: ScrollErrorTarget): HTMLElement | null {
  if (!target) return null;
  if (typeof target === "string") {
    const element = document.querySelector(target);
    return isHTMLElement(element) ? element : null;
  }
  return resolveElement(target);
}

function hasScrollableOverflow(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return [style.overflowY, style.overflow].some((value) =>
    ["auto", "scroll", "overlay"].includes(value),
  );
}

// test seam
export function getNearestScrollContainer(
  element: HTMLElement | null,
): HTMLElement | null {
  let current: HTMLElement | null = element;

  while (current) {
    if (hasScrollableOverflow(current)) return current;
    current = current.parentElement;
  }

  return null;
}

/**
 * `"auto"` (an instant jump) when the admin has asked their platform for
 * reduced motion, `"smooth"` otherwise. jsdom has no `matchMedia`; treat its
 * absence as no preference.
 */
// test seam
export function resolveScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "smooth";
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/**
 * Make a region programmatically focusable WITHOUT touching a natively
 * focusable control. `tabIndex` is `-1` for a `div` and `0` for a `select`,
 * `input`, `button` or link, so a bare `setAttribute("tabindex", "-1")` on a
 * control would silently drop it out of the sequential tab order.
 */
function ensureFocusable(element: HTMLElement) {
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
}

/**
 * The clearance a target needs so the sticky admin header does not cover it —
 * read from the surface first, applied by this module only when the surface has
 * not said otherwise.
 *
 * Two traps, both of which this module has stepped in:
 *
 *  - `element.style.scrollMarginTop` reads only the INLINE declaration, so an
 *    element whose clearance comes from a class always reads empty and had its
 *    choice overwritten. The Xero section cards declare `scroll-mt-24` (6rem)
 *    because their collapsible header is taller than the ordinary one, and
 *    `use-xero-connection.ts` reveals exactly those cards. Ask for the COMPUTED
 *    value, which a class reaches.
 *  - The margin is sticky-header clearance, which means something for
 *    `block: "start"` and for `"nearest"` (a target scrolled DOWN into view
 *    lands at the top edge, under the header). Under `block: "center"` it
 *    shifts the centre up by half of itself, so every centred recovery alert
 *    would land lower than it asked.
 */
function applyStickyHeaderClearance(
  element: HTMLElement,
  block: AttentionBlock,
) {
  if (block === "center") return;
  const declared =
    (typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(element).scrollMarginTop
      : "") || element.style.scrollMarginTop;
  // Compare as a NUMBER: the unset value is `"0px"` in a browser and `"0"` in
  // jsdom, and a declared one arrives in whatever unit the class used.
  if (Number.parseFloat(declared) > 0) return;
  element.style.scrollMarginTop = FEEDBACK_SCROLL_MARGIN_TOP;
}

function focusAndReveal(element: HTMLElement, block: AttentionBlock) {
  applyStickyHeaderClearance(element, block);
  ensureFocusable(element);
  element.focus({ preventScroll: true });
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ behavior: resolveScrollBehavior(), block });
  }
}

/**
 * How far below the top of its scroll container a success target may sit and
 * still be reached by scrolling that container to zero. A page wrapper sits at
 * 0; sub-pixel layout rounding is the only reason this is not exactly 0.
 */
const CONTAINER_TOP_TOLERANCE_PX = 4;

/**
 * The target's distance from the top of its container's scrollable CONTENT —
 * not from the top of the viewport, which moves as the container scrolls.
 */
function offsetWithinScrollContainer(
  element: HTMLElement,
  container: HTMLElement,
): number {
  if (
    typeof element.getBoundingClientRect !== "function" ||
    typeof container.getBoundingClientRect !== "function"
  ) {
    return 0;
  }
  const contentTop =
    container.getBoundingClientRect().top - container.scrollTop;
  return element.getBoundingClientRect().top - contentTop;
}

/**
 * SUCCESS / STEP TRANSITION. Position at the top of the resulting page, card or
 * step and focus it, so the confirmation and the new state are what the admin
 * lands on. Call it only for a transition that changed the authoritative screen
 * — never for an inline save whose result stays where it was, a background
 * refresh, or a passive update.
 *
 * "The top of the page OR CARD" is two different scrolls, and doing only the
 * first is a WCAG 2.4.11-shaped defect. A page wrapper IS the top of its scroll
 * container, so scrolling that container to zero puts it and the heading above
 * it on screen. A card can sit screens below the heading — `LodgeCapacityCard`
 * does — and scrolling the container to zero there would focus the card while
 * showing the top of the page: no visible focus ring, a Tab that jumps
 * invisibly, and a magnifier following focus to somewhere the viewport is not.
 * So a target that is not already at the top of its container is REVEALED
 * instead, under the same sticky-header clearance every other reveal gets.
 */
// test seam
export function scrollToTop(target: ScrollContainerTarget) {
  const element = resolveElement(target);
  const container = element ? getNearestScrollContainer(element) : null;

  if (
    element &&
    container &&
    offsetWithinScrollContainer(element, container) > CONTAINER_TOP_TOLERANCE_PX
  ) {
    focusAndReveal(element, "start");
    return;
  }

  if (element) {
    ensureFocusable(element);
    element.focus({ preventScroll: true });
  }
  if (typeof container?.scrollTo === "function") {
    container.scrollTo({ top: 0, behavior: resolveScrollBehavior() });
  }
}

/**
 * FAILURE. Focus the actionable error, summary or invalid control and bring it
 * into view under the sticky admin header (`block: "start"`), or centred for a
 * permanently mounted recovery alert.
 */
// test seam
export function scrollToError(
  errorRefOrSelector: ScrollErrorTarget,
  options: AttentionOptions = {},
) {
  const errorElement = resolveFeedbackElement(errorRefOrSelector);
  if (!errorElement) return;
  focusAndReveal(errorElement, options.block ?? "start");
}

/**
 * REVEAL. Focus an editor the admin has just opened and bring it into view.
 * Call it from the explicit action (or key a `useRevealAttention` on that
 * action's nonce) — never from a render, so a re-render with the editor already
 * open moves nothing.
 */
// test seam
export function revealEditor(target: ScrollContainerTarget) {
  const element = resolveElement(target);
  if (!element) return;
  focusAndReveal(element, "start");
}

/**
 * The data attributes that let a return find its target again after a render
 * replaced it (#4087). A staged section renders Edit only while read-only, so
 * the button that opened the editor is gone by the time it closes; the one
 * rendered in its place carries the same per-instance marker. Each value comes
 * from `useId`, so two sections — or two open at once — never share one.
 */
export const RETURN_FOCUS_TRIGGER_ATTRIBUTE = "data-return-focus-trigger";
export const RETURN_FOCUS_REGION_ATTRIBUTE = "data-return-focus-region";

/**
 * Where a return falls back to when its trigger is gone: a marked section, a
 * landmark, or the page's main region. Shared with the bed-allocation dialogs,
 * which fall back to the same places when their trigger chip has gone.
 */
export const MAIN_REGION_SELECTOR = 'main, [role="main"]';
export const RETURN_FOCUS_REGION_SELECTOR = `[${RETURN_FOCUS_REGION_ATTRIBUTE}], section, [role="region"], ${MAIN_REGION_SELECTOR}`;

/** What {@link captureFocusReturn} recorded when an editor was opened. */
export interface FocusReturnAnchor {
  /** The element focused at capture, or `null` when nothing was. */
  trigger: HTMLElement | null;
  /** The marker the trigger's re-rendered replacement carries. */
  triggerId?: string;
  /** The marker on the section to fall back to. */
  regionId?: string;
  /** The nearest {@link RETURN_FOCUS_REGION_SELECTOR} around the trigger at capture. */
  region: HTMLElement | null;
}

/** `document.body` / `<html>`, or nothing: focus has fallen to the page. */
export function isPageRoot(element: Element | null) {
  return (
    !element ||
    element === document.body ||
    element === document.documentElement
  );
}

/** The mounted element carrying `attribute="id"`, found again after a re-render. */
export function elementByMarker(attribute: string, id: string | undefined) {
  if (!id) return null;
  const match = Array.from(document.querySelectorAll(`[${attribute}]`)).find(
    (element) => element.getAttribute(attribute) === id,
  );
  return isHTMLElement(match) ? match : null;
}

/**
 * Focus `target` if it is mounted, and report whether focus actually LANDED —
 * a disabled, `inert` or hidden element silently refuses it, and the caller's
 * next fallback is only reached by asking.
 *
 * By default a non-focusable target gets `tabindex="-1"` only for the call
 * (the bed-allocation dialogs' behaviour, which leaves no attribute behind).
 * `keepTabIndex` leaves it in place, as every other primitive here does, so a
 * region keeps the focus it was given.
 */
export function focusConnectedTarget(
  target: HTMLElement | null | undefined,
  { keepTabIndex = false }: { keepTabIndex?: boolean } = {},
): boolean {
  if (!target?.isConnected) return false;
  const hadTabIndex = target.hasAttribute("tabindex");
  ensureFocusable(target);
  target.focus({ preventScroll: true });
  if (!hadTabIndex && !keepTabIndex) target.removeAttribute("tabindex");
  return document.activeElement === target;
}

/**
 * Record the focused element, and the markers to find its replacement and its
 * section by, as the place to return to. Call it from the explicit action that
 * opens the editor (or starts a save), before the render that unmounts the
 * control holding focus.
 *
 * With nothing focused — a mouse click in a browser that does not focus
 * buttons — the markers alone still lead back to the section's Edit; with no
 * markers either there is nothing to return to, and it returns `null`.
 */
// test seam
export function captureFocusReturn(
  markers: { triggerId?: string; regionId?: string } = {},
): FocusReturnAnchor | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  const trigger = isHTMLElement(active) && !isPageRoot(active) ? active : null;
  if (!trigger && !markers.triggerId && !markers.regionId) return null;
  const region = trigger?.closest(RETURN_FOCUS_REGION_SELECTOR) ?? null;
  return {
    trigger,
    triggerId: markers.triggerId,
    regionId: markers.regionId,
    region: isHTMLElement(region) ? region : null,
  };
}

/**
 * Focus `target` where it already is, keeping it — and its `tabindex="-1"`,
 * for a region — and scroll only as far as it must to be on screen
 * (`block: "nearest"`, under the sticky header). Reports whether focus LANDED.
 * The return and the reveal into an opened editor both position this way.
 */
export function focusAndKeepInView(target: HTMLElement | null) {
  if (!target?.isConnected) return false;
  applyStickyHeaderClearance(target, "nearest");
  if (!focusConnectedTarget(target, { keepTabIndex: true })) return false;
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: resolveScrollBehavior(), block: "nearest" });
  }
  return true;
}

/**
 * RETURN. Hand focus back to where an editor was opened from when closing it
 * dropped focus to the page. Each candidate is tried in turn and the first
 * that actually TAKES focus wins: the original trigger if it is still mounted,
 * its marked replacement, the marked section, then the section around the
 * trigger at capture. A disabled Edit (a view-only admin) refuses focus, so the
 * section takes it — a region named by its own title, which the section
 * declares through `regionProps` / `titleProps` rather than this module
 * writing names into the DOM.
 *
 * It moves nothing while focus is anywhere else — a failure or success
 * position another primitive already took, or a control the admin moved to
 * while a save was in flight — and nothing when the page itself is all that
 * is left. The scroll is `block: "nearest"`: the target is where the admin
 * left it, so it moves only as far as it must to be on screen.
 */
// test seam
export function returnFocus(anchor: FocusReturnAnchor | null) {
  if (!anchor || typeof document === "undefined") return;
  if (!isPageRoot(document.activeElement)) return;
  if (focusAndKeepInView(anchor.trigger)) return;
  if (
    focusAndKeepInView(elementByMarker(RETURN_FOCUS_TRIGGER_ATTRIBUTE, anchor.triggerId))
  ) {
    return;
  }
  for (const region of [
    elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, anchor.regionId),
    anchor.region,
  ]) {
    if (!region?.isConnected || isPageRoot(region)) continue;
    if (focusAndKeepInView(region)) return;
  }
}

export function useScrollToFeedback() {
  const scrollTop = useCallback((containerRef: ScrollContainerTarget) => {
    scrollToTop(containerRef);
  }, []);
  const scrollError = useCallback(
    (errorRefOrSelector: ScrollErrorTarget, options?: AttentionOptions) => {
      scrollToError(errorRefOrSelector, options);
    },
    [],
  );
  const reveal = useCallback((target: ScrollContainerTarget) => {
    revealEditor(target);
  }, []);

  return useMemo(
    () => ({
      scrollToTop: scrollTop,
      scrollToError: scrollError,
      revealEditor: reveal,
    }),
    [reveal, scrollError, scrollTop],
  );
}

export interface UseActionAttentionOptions {
  /** The failure message; empty or nullish means no failure is showing. */
  error: string | null | undefined;
  /** Where the failure is rendered. */
  errorTarget: ScrollErrorTarget;
  /** How the failure is positioned; the recovery alerts centre themselves. */
  errorBlock?: AttentionBlock;
  /**
   * Bump to re-take attention for an IDENTICAL failure message — a retry that
   * fails the same way. Without it, the same string arriving twice is one
   * arrival, which is the right default for a load error that re-renders.
   */
  attentionKey?: number;
  /**
   * The success signal; empty, `0` or nullish means no transition to position.
   * A message when the surface shows one, otherwise a counter the successful
   * save bumps — `committee/page.tsx` has no success banner and still has a
   * success transition to position.
   */
  success?: string | number | boolean | null;
  /** The page, card or step whose top the success positions at. */
  successTarget?: ScrollContainerTarget;
}

/**
 * The result of an action, as one rule: failure wins, success positions at the
 * top, and neither runs for a passive re-render.
 *
 * Fires the failure position when `error` (or `attentionKey`) ARRIVES — changes
 * to a non-empty value — and the success position when `success` arrives while
 * no failure is showing. A failed save therefore never also runs the success
 * position, even on a surface that leaves an earlier success message standing:
 * the failure is what the admin has to act on next.
 *
 * Two edges, deliberate rather than overlooked. An arrival is CONSUMED whether
 * or not its target was mounted to receive it — the comparison state is written
 * before the test — so a message whose target renders a commit later moves
 * nothing and is not retried; every call site here renders its target in the
 * same commit as the message. And a component that MOUNTS with a message
 * already set counts that as an arrival, which is a passive fire by this
 * issue's definition; no call site does, because a message is the result of an
 * action taken on a mounted surface. Both were true of the per-page effects
 * this replaced, so neither is a regression; they are stated so a future call
 * site that breaks either assumption is recognised rather than debugged.
 */
export function useActionAttention({
  error,
  errorTarget,
  errorBlock,
  attentionKey,
  success,
  successTarget,
}: UseActionAttentionOptions) {
  const previous = useRef<{
    error: string;
    attentionKey: number | undefined;
    success: string | number | boolean;
  }>({ error: "", attentionKey: undefined, success: "" });

  useEffect(() => {
    const currentError = error ?? "";
    const currentSuccess = success ?? "";
    const before = previous.current;
    previous.current = {
      error: currentError,
      attentionKey,
      success: currentSuccess,
    };

    const errorArrived =
      Boolean(currentError) &&
      (currentError !== before.error || attentionKey !== before.attentionKey);
    if (errorArrived) {
      scrollToError(errorTarget, { block: errorBlock });
      return;
    }
    // A live failure keeps the position it took; success never displaces it.
    if (currentError) return;

    const successArrived =
      Boolean(currentSuccess) && currentSuccess !== before.success;
    if (successArrived && successTarget) scrollToTop(successTarget);
    // Targets are refs or elements — stable identities — so the message values
    // and the key are the only things that can make a new attention event.
  }, [attentionKey, error, errorBlock, errorTarget, success, successTarget]);
}

/**
 * Reveal an editor when — and only when — an explicit action opened it.
 *
 * `revealKey` is the caller's count of explicit opens: `formOpenNonce`, or any
 * integer that changes once per user action. A staged section does not need
 * it: `useSectionEditState`'s Edit reveals through `useEditorFocusReturn`.
 * `0` / `null` means "no action yet" and moves nothing, and a re-render with the
 * same key moves nothing either — which is the whole reason the key is a
 * required argument rather than a boolean.
 */
export function useRevealAttention(
  target: ScrollContainerTarget,
  revealKey: number | null | undefined,
) {
  useEffect(() => {
    if (!revealKey) return;
    revealEditor(target);
  }, [revealKey, target]);
}

/**
 * Return focus when — and only when — an explicit action closed an editor.
 *
 * The counterpart of {@link useRevealAttention}: `anchorRef` holds what
 * {@link captureFocusReturn} recorded when the editor opened, and `returnKey`
 * counts the closes. Each close CONSUMES the anchor, so a later close with no
 * fresh open behind it moves nothing.
 */
export function useReturnAttention(
  anchorRef: RefObject<FocusReturnAnchor | null>,
  returnKey: number,
) {
  useEffect(() => {
    if (!returnKey) return;
    const recorded = anchorRef.current;
    anchorRef.current = null;
    returnFocus(recorded);
  }, [anchorRef, returnKey]);
}
