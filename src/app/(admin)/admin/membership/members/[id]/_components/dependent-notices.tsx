"use client";

import type { ReactNode } from "react";
import type { DependentEmailSourceState } from "@/hooks/use-dependent-email-source";
import { cn } from "@/lib/utils";

/**
 * ONE treatment for every "why you cannot add a dependent here" / "where this
 * dependent's mail will actually go" line (#2282 review).
 *
 * Three surfaces state these reasons — the Dependents card, the member detail
 * header toolbar, and the Add Dependent dialog — and they had three different
 * treatments: a bare `<p>` with no programmatic association on two of them, and
 * a `role="status"` warning box on the third. That mattered, because the control
 * the reason explains is `disabled`, which takes it out of the tab order: a
 * keyboard user never lands on it, and `buttonVariants` sets
 * `disabled:pointer-events-none`, so a native `title` tooltip never fires
 * either. The reason has to be attached to the button, not merely near it.
 *
 * So this component does two things at once and every caller gets both:
 *
 *  - the message carries an `id`, which the caller passes to its control as
 *    `aria-describedby` — the association the bare `<p>` was missing; and
 *  - the wrapper is `role="status"` and is mounted UNCONDITIONALLY, with only
 *    its content gated, the same shape as `AdminViewOnlySectionBanner`. A polite
 *    live region has to exist in the accessibility tree before its content
 *    changes; one injected already-populated is announced by some
 *    screen-reader/browser pairings and silently dropped by others.
 *
 * Honest limit: the member detail page returns a skeleton while it refetches, so
 * these cards unmount and remount around a save rather than having their content
 * swapped in place. The live region therefore helps within a mounted card, not
 * across a refetch; the `aria-describedby` association is what carries the
 * reason in every case, and that is the half the review was about.
 */
export function DependentNotice({
  id,
  tone = "muted",
  className,
  children,
}: {
  /** Referenced by the explained control's `aria-describedby`. */
  id: string;
  /** `warning` for "this cannot be done", `muted` for a statement of fact. */
  tone?: "warning" | "muted";
  className?: string;
  /** `null`/`undefined` renders the empty live region and nothing visible. */
  children?: ReactNode;
}) {
  return (
    <div role="status">
      {children ? (
        <p
          id={id}
          className={cn(
            "rounded-md px-2 py-1 text-xs",
            tone === "warning"
              ? "border border-warning/20 bg-warning-muted text-warning"
              : "text-muted-foreground",
            className,
          )}
        >
          {children}
        </p>
      ) : null}
    </div>
  );
}

/**
 * WHO THE "Notification email recipient" CHOICE ACTUALLY REACHES (#2282
 * review).
 *
 * The picker lists PARENTS, and both link dialogs pre-select one. The write
 * then resolves that choice with `resolveInheritedEmailSourceId`, which walks up
 * past a parent who cannot be the club's contact of record — a young parent, an
 * archived one, one whose only address is a club-internal placeholder — and
 * stores the nearest adult ancestor instead. So the screen could say "Tui Rangi
 * (Primary parent)" while the stored contact of record was Nan Rangi, with
 * nothing on screen saying so. This states the resolved answer, fetched from the
 * server with that same walk.
 *
 * The `null` answer is a refusal, not a detail: it is the exact condition both
 * write paths 422 on, so the caller disables its save and this names the way
 * out rather than letting the admin meet it on submit.
 */
export function DependentNotificationRoutingNotice({
  id,
  state,
  selectedParentId,
  selectedParentName,
  ownEmailOptionLabel,
}: {
  id: string;
  state: DependentEmailSourceState;
  selectedParentId: string;
  selectedParentName: string;
  /** The picker's own wording for "do not inherit", quoted back verbatim. */
  ownEmailOptionLabel: string;
}) {
  const tone: "warning" | "muted" =
    state.status === "error" ||
    (state.status === "ready" && state.source === null)
      ? "warning"
      : "muted";

  return (
    <DependentNotice id={id} tone={tone}>
      {state.status === "loading"
        ? "Checking where club notifications would go…"
        : state.status === "error"
          ? state.error
          : state.status === "ready"
            ? state.source === null
              ? `No adult at or above ${selectedParentName} can receive club email, so notifications cannot be routed through them. Choose “${ownEmailOptionLabel}”, or record an email address for an adult in the family first.`
              : state.source.id === selectedParentId
                ? `Club notifications will go to ${state.source.firstName} ${state.source.lastName} (${state.source.email}).`
                : `Club notifications will go to ${state.source.firstName} ${state.source.lastName} (${state.source.email}), not ${selectedParentName} — the club's contact of record has to be an adult with an address the club can use, so mail routes on up the family.`
            : null}
    </DependentNotice>
  );
}
