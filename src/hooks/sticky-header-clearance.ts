/**
 * STICKY-HEADER CLEARANCE FOR THE ATTENTION PRIMITIVES (#2934, #4945).
 *
 * The scroll-margin rule `use-scroll-to-feedback.ts` applies before it reveals a
 * target, and the test for when a centred reveal would lose the top of a tall
 * alert. Moved here whole from that module, with no change to either, when it
 * outgrew its size budget; the primitives that call them stay there.
 */

/**
 * Where the target lands in the viewport: under the sticky header, centred, or
 * — for a return to where the admin already was — wherever it moves least.
 */
export type AttentionBlock = "start" | "center" | "nearest";

const FEEDBACK_SCROLL_MARGIN_REM = 5;
const FEEDBACK_SCROLL_MARGIN_TOP = `${FEEDBACK_SCROLL_MARGIN_REM}rem`;

/**
 * Elements whose inline `scroll-margin-top` THIS module wrote, so a later
 * centred reveal of the same permanently mounted alert can take it back off
 * (`applyStickyHeaderClearance`).
 */
const clearanceWrittenHere = new WeakSet<HTMLElement>();

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
export function applyStickyHeaderClearance(
  element: HTMLElement,
  block: AttentionBlock,
) {
  if (block === "center") {
    // The same alert may have been revealed from its top edge a moment ago (see
    // `exceedsCentredView`), which left 5rem on it; centring would then land it
    // 2.5rem above the middle it asked for. Only a margin written here is
    // removed, never one the surface declared.
    if (clearanceWrittenHere.has(element)) {
      element.style.scrollMarginTop = "";
      clearanceWrittenHere.delete(element);
    }
    return;
  }
  const declared =
    (typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(element).scrollMarginTop
      : "") || element.style.scrollMarginTop;
  // Compare as a NUMBER: the unset value is `"0px"` in a browser and `"0"` in
  // jsdom, and a declared one arrives in whatever unit the class used.
  if (Number.parseFloat(declared) > 0) return;
  element.style.scrollMarginTop = FEEDBACK_SCROLL_MARGIN_TOP;
  clearanceWrittenHere.add(element);
}

/**
 * True when centring the element would push its top edge under the sticky
 * header (or off the top of the screen), because it is taller than the room the
 * viewport leaves once the header's clearance is kept at both ends.
 *
 * A centred element taller than the viewport loses its top and bottom equally.
 * For a recovery alert that is the wrong half to lose: the first line is the
 * sentence that explains everything below it, such as several clashing guests
 * on the member booking wizard (#4945). Such an element is revealed from its
 * top edge instead. jsdom has no layout, so a measured height of 0 never
 * qualifies and tests that want the fallback stub `getBoundingClientRect`.
 */
export function exceedsCentredView(element: HTMLElement) {
  if (
    typeof window === "undefined" ||
    typeof element.getBoundingClientRect !== "function"
  ) {
    return false;
  }
  const rootFontPx =
    typeof window.getComputedStyle === "function"
      ? Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        )
      : Number.NaN;
  const clearancePx = (rootFontPx > 0 ? rootFontPx : 16) * FEEDBACK_SCROLL_MARGIN_REM;
  return element.getBoundingClientRect().height > window.innerHeight - 2 * clearancePx;
}
