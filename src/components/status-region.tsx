"use client";

import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";
import { cn } from "@/lib/utils";

/**
 * When an outcome REPLACES the control that had focus (a form that gives way to
 * its result, a button that is no longer needed), move focus to the result so a
 * keyboard or screen-reader user is not left on `<body>` with the next Tab
 * starting from the top of the page (#4949).
 *
 * `outcomeKey` is the caller's signal that the outcome has arrived: a counter
 * the success path bumps, or a boolean that turns true. Falsy (`0`, `false`,
 * `null`, `""`) moves nothing, and so does a re-render with the same key, so a
 * region that mounts with a message already in it is not a focus event. Pass
 * `0` until the action has completed.
 *
 * The move is a PASSIVE effect on purpose, for the reason `FocusedActionError`
 * documents: it lands after the commit that removed the old control, and after
 * a closing Radix dialog has finished handing focus back, so there is nothing
 * left to fight it.
 */
export function useFocusOnOutcome(
  target: RefObject<HTMLElement | null>,
  outcomeKey: string | number | boolean | null | undefined,
) {
  useEffect(() => {
    if (!outcomeKey) return;
    focusAndKeepInView(target.current);
  }, [outcomeKey, target]);
}

/**
 * Permanently mounted polite feedback for an action that is under way or has
 * succeeded: the success side of what `FocusedActionError` is for failures.
 * It is the one home of the idiom the UX flow map states (#4949): a `role="status"`
 * region mounted BEFORE the request and `sr-only` while empty, so only its text
 * changes. A region inserted already filled is missed by some screen-reader and
 * browser pairs.
 *
 * `visible` says whether the text is also drawn as a box; leave it off for a
 * region that is only there to be read, because the same words are already on
 * screen. `visibleClassName` styles the box. The box is `aria-atomic`, so a
 * change is read as a whole rather than as the fragment that differs.
 *
 * Pass `outcomeKey` (see {@link useFocusOnOutcome}) when the outcome replaces
 * the control that had focus. Pass `ref` when the caller moves focus itself,
 * for a step it already tracks; the region is always programmatically
 * focusable (`tabIndex={-1}`) and never a tab stop.
 */
export function StatusRegion({
  id,
  visible = false,
  visibleClassName,
  outcomeKey,
  ref,
  children,
}: {
  id?: string;
  visible?: boolean;
  visibleClassName?: string;
  outcomeKey?: string | number | boolean | null;
  ref?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const regionRef = ref ?? ownRef;
  useFocusOnOutcome(regionRef, outcomeKey);

  return (
    <div
      id={id}
      ref={regionRef}
      role="status"
      aria-atomic="true"
      tabIndex={-1}
      className={visible ? cn("outline-none", visibleClassName) : "sr-only"}
    >
      {children}
    </div>
  );
}
