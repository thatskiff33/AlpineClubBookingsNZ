"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { scrollToError } from "@/hooks/use-scroll-to-feedback";
import { cn } from "@/lib/utils";

/**
 * Permanently mounted assertive feedback for an action that failed away from
 * the user's current focus. Registering the empty live region up front avoids
 * screen-reader/browser pairs missing an alert that is inserted already
 * populated. When a failure arrives, move focus without the browser's default
 * jump and then scroll the recovery message into view.
 */
export function FocusedActionError({
  id,
  error,
  heading,
  attentionKey,
  action,
  className,
}: {
  id: string;
  error: string;
  heading?: string;
  attentionKey?: number;
  action?: ReactNode;
  className?: string;
}) {
  const errorRef = useRef<HTMLDivElement>(null);

  // A PASSIVE effect, deliberately — do not "tidy" this into `useLayoutEffect`
  // (#2635, measured; see below).
  //
  // A passive effect focuses one event-loop turn after the commit that puts the
  // message in the DOM. Tightening that to a layout effect looks like an
  // improvement — the message and the focus would land in the same frame — and it
  // is what the flake investigation tried first. It regresses the surfaces that
  // raise their failure from inside a closing dialog, and it regresses them to
  // exactly the outcome this component exists to prevent.
  //
  // The reason is Radix's focus scope. Its trap pulls focus back into the dialog
  // the instant anything outside takes it, and its release is a PASSIVE effect
  // cleanup that then restores focus to whatever was focused when the dialog
  // opened. The surfaces batch "close the dialog" and "record the failure" into
  // one commit (see `deletion-requests-client.tsx`), so a layout effect focuses
  // this alert while the closing dialog's content is still mounted: the trap
  // steals the focus back, and the release then hands it to the control that
  // opened the dialog — or to `<body>` under a synthetic click, which does not
  // focus its button. Either way the explanation loses the focus it was given, and
  // that is precisely the failure this component exists to prevent. Waiting for
  // the passive flush means the dialog has already gone and there is nothing to
  // fight.
  //
  // Verified both ways, deterministically, by
  // `src/components/__tests__/focused-action-error-focus-contract.test.tsx`
  // ("wins the focus when the failure comes from a closing dialog") and
  // incidentally by `deletion-requests-client.test.tsx`.
  //
  // What this timing means for TESTS is the whole of #2635: focus lands strictly
  // after the commit, so a synchronous `document.activeElement` assertion taken
  // when the message appears is a race. Assert it with
  // `expectRecoveryAlertToHoldFocus` from `@/lib/__tests__/helpers/focus`.
  //
  // The focus-then-scroll itself is the shared failure primitive (#2934), so the
  // reduced-motion rule and the "focus without the browser's own jump" order
  // are written once, in `@/hooks/use-scroll-to-feedback`.
  useEffect(() => {
    if (!error) return;
    scrollToError(errorRef, { block: "center" });
  }, [attentionKey, error]);

  return (
    <div
      id={id}
      ref={errorRef}
      role="alert"
      aria-atomic="true"
      tabIndex={-1}
      className={
        error
          ? cn(
              "rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11 outline-none",
              className,
            )
          : "sr-only"
      }
    >
      {error ? (
        <>
          {heading ? (
          <>
            <p className="font-medium">{heading}</p>
            <p className="mt-1">{error}</p>
          </>
          ) : (
            error
          )}
          {action ? <div className="mt-3">{action}</div> : null}
        </>
      ) : null}
    </div>
  );
}
