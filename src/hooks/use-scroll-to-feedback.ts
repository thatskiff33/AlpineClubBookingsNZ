"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

/**
 * THE ONE HOME FOR "WHERE DOES THE ADMIN'S ATTENTION GO AFTER AN ACTION" (#2934).
 *
 * An admin action ends in one of three places, and each has one primitive here:
 *
 *  - **failure** → `scrollToError`: the actionable message or invalid control
 *    takes focus and comes into view. Failure always wins over success.
 *  - **reveal** → `revealEditor`: an editor the admin explicitly opened (Edit,
 *    New, a per-row pencil) takes focus and comes into view — never because the
 *    content merely re-rendered.
 *  - **success / step transition** → `scrollToTop`: the resulting page, card or
 *    step is positioned at its top and takes focus, so the confirmation and the
 *    new state are what a keyboard or screen-reader user lands on.
 *
 * Passive updates — a background refresh, a poll, a re-render with the same
 * message — move nothing. The hooks below encode that: `useActionAttention` fires
 * only when a message ARRIVES and refuses the success position while a failure
 * is showing; `useRevealAttention` fires only when its explicit-action key
 * changes.
 *
 * Every scroll in this module honours `prefers-reduced-motion` through
 * `resolveScrollBehavior`, and every focus is applied with `preventScroll` first
 * so the scroll that follows is the one this module chose rather than the
 * browser's default jump. Nothing here uses a timer: the caller's own state
 * (a message string, an edit nonce) drives the effect, so the transition lands in
 * the commit that produced it.
 *
 * `admin-attention-primitive-contract.test.ts` keeps the admin tree routed
 * through this module — a direct `scrollIntoView` / `scrollTo` or a
 * `requestAnimationFrame`-driven focus outside it fails that census. The one
 * standing exclusion is listed in {@link DIRECT_SCROLL_EXCLUSIONS}, next to the
 * fact it excludes (`INV-SSOT-001`).
 */

type ElementRef = RefObject<HTMLElement | null>;
type ScrollContainerTarget = HTMLElement | ElementRef | null | undefined;
type ScrollErrorTarget = HTMLElement | ElementRef | string | null | undefined;

/** Where the target lands in the viewport: under the sticky header, or centred. */
export type AttentionBlock = "start" | "center";

export interface AttentionOptions {
  /** Defaults to `"start"`; the recovery alerts centre themselves. */
  block?: AttentionBlock;
}

/**
 * Admin files allowed a direct `scrollIntoView` / `scrollTo` call, with the
 * reason. Each entry is a deep link or a layout concern rather than the result
 * of an admin's action, which is the only thing this module positions for.
 * Shrinking this list is the ratchet; a new entry is a decision to record here.
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
];

const FEEDBACK_SCROLL_MARGIN_TOP = "5rem";

function isHTMLElement(value: unknown): value is HTMLElement {
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

function resolveScrollContainer(
  target: ScrollContainerTarget,
): HTMLElement | null {
  const element = resolveElement(target);
  if (!element) return null;
  return getNearestScrollContainer(element);
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

function focusAndReveal(element: HTMLElement, block: AttentionBlock) {
  if (!element.style.scrollMarginTop) {
    element.style.scrollMarginTop = FEEDBACK_SCROLL_MARGIN_TOP;
  }
  ensureFocusable(element);
  element.focus({ preventScroll: true });
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ behavior: resolveScrollBehavior(), block });
  }
}

/**
 * SUCCESS / STEP TRANSITION. Focus the resulting page, card or step and scroll
 * its nearest scrollable ancestor to the top, so the confirmation and the new
 * state are what the admin lands on. Call it only for a transition that changed
 * the authoritative screen — never for an inline save whose result stays where
 * it was, a background refresh, or a passive update.
 */
// test seam
export function scrollToTop(target: ScrollContainerTarget) {
  const element = resolveElement(target);
  if (element) {
    ensureFocusable(element);
    element.focus({ preventScroll: true });
  }
  const container = resolveScrollContainer(target);
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
  /** The success message; empty or nullish means no transition to position. */
  success?: string | boolean | null;
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
    success: string | boolean;
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
 * `revealKey` is the caller's count of explicit opens: `formOpenNonce`,
 * `section.editRequestKey`, or any integer that changes once per user action.
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
