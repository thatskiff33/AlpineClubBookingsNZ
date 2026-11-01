"use client";

import * as React from "react";

/** The marker the `aria-hidden` package (Radix's `hideOthers`) stamps on what it hides. */
const MARKER = "data-aria-hidden";
const HIDDEN_BY_OPEN_POPUP = `[${MARKER}="true"]`;
const DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * Make what an open Radix popup hides `inert` as well as `aria-hidden` (#4466).
 *
 * Radix `Select` and modal `DropdownMenu` content call `hideOthers()` while open:
 * every node outside the popup gets `aria-hidden="true"`, the pointer is blocked
 * and focus is trapped inside. The hidden nodes stay FOCUSABLE, though, and
 * focusable content under `aria-hidden` is WCAG 4.1.2's failure (axe
 * `aria-hidden-focus`, serious): a screen-reader user who escapes the trap lands
 * on controls the accessibility tree says are not there. Radix exposes no option
 * to change it. `inert` is the attribute that says "not focusable, not
 * clickable, not in the tree", which is exactly what Radix already enforces by
 * other means while the popup is open, so mirroring its marks as `inert` changes
 * nothing a user could do and makes the hidden page consistent.
 *
 * Returns a callback ref for the popup's CONTENT element. While that element is
 * in the document, a MutationObserver keeps `inert` in step with Radix's marks:
 * a node Radix marks becomes inert, and a node Radix unmarks (as it does on
 * close) is released at once, before Radix returns focus to the trigger. The
 * moment the content leaves the document everything is released. This mirrors
 * the marks themselves rather than trusting ref or effect timing: Radix does not
 * always detach the ref when a Select closes. Only nodes this hook made inert
 * are ever released.
 *
 * A node that is, holds, or sits inside an open dialog is left alone: a Select
 * opened in a Dialog hides the dialog (or, when its listbox renders inside the
 * dialog, the dialog's other children), and making those inert would leave a
 * scrollable dialog with nothing focusable in it (axe
 * scrollable-region-focusable). Behind an open dialog the page is already
 * modal, which is how assistive tech and axe both read it.
 */
export function useInertOutsidePopup<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T>,
): React.RefCallback<T> {
  const [content, setContent] = React.useState<T | null>(null);
  const madeInert = React.useRef<Element[]>([]);
  const latestForwardedRef = React.useRef(forwardedRef);
  React.useLayoutEffect(() => {
    latestForwardedRef.current = forwardedRef;
  });

  const release = React.useCallback(() => {
    for (const element of madeInert.current) element.removeAttribute("inert");
    madeInert.current = [];
  }, []);

  React.useEffect(() => {
    if (!content) return;
    const sync = () => {
      if (!content.isConnected) {
        release();
        return;
      }
      madeInert.current = madeInert.current.filter((element) => {
        if (element.getAttribute(MARKER) === "true") return true;
        element.removeAttribute("inert");
        return false;
      });
      for (const element of document.querySelectorAll(HIDDEN_BY_OPEN_POPUP)) {
        if (element.hasAttribute("inert") || element.contains(content)) continue;
        if (element.closest(DIALOG) || element.querySelector(DIALOG)) continue;
        element.setAttribute("inert", "");
        madeInert.current.push(element);
      }
    };
    const observer = new MutationObserver(sync);
    // `inert` itself is not observed, so writing it cannot re-trigger the sync.
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [MARKER],
    });
    sync();
    return () => {
      observer.disconnect();
      release();
    };
  }, [content, release]);

  return React.useCallback(
    (element: T | null) => {
      if (element === null) release();
      setContent(element);
      const ref = latestForwardedRef.current;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [release],
  );
}
