"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The kiosk's per-row writes — Mark Arrived, Mark Departed and the chore ticks —
 * share one busy state and one error surface (#4965).
 *
 * BUSY WHILE IN FLIGHT. On slow lodge Wi-Fi a button that does not change looks
 * like a tap that did not register, so the hut leader taps again. A row's
 * action is refused while its own request is travelling, and the page renders
 * the control disabled with a "Saving…" label. The guard is a ref, not the
 * state: two taps landing before React re-renders both read the same stale
 * state, but they share the ref. Other rows stay usable.
 *
 * AN ERROR STAYS UNTIL IT IS DEALT WITH. It used to be a three-second strip at
 * the top of the page, which a hut leader scrolled down a long guest list never
 * saw, which no screen reader announced, and whose untracked timer could wipe a
 * newer message early — the same mistake #3228 corrected for the Lock control.
 * Now each failure is held against the row that failed and rendered beside it
 * with `role="alert"`, until it is dismissed or that row's next action succeeds.
 * There is no timer.
 */

/**
 * Performs one row's request. Resolves to `null` on success or to the message
 * to show beside the row; a throw shows `failureMessage`.
 */
type RowRequest = () => Promise<string | null>;

export function useKioskRowActions() {
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const publishPending = () => setPending(new Set(inFlight.current));

  const setRowError = (rowId: string, message: string | null) =>
    setErrors((prev) => {
      if (message === null) {
        if (!(rowId in prev)) return prev;
        const rest = { ...prev };
        delete rest[rowId];
        return rest;
      }
      return { ...prev, [rowId]: message };
    });

  const run = async (
    rowId: string,
    action: string,
    failureMessage: string,
    request: RowRequest,
  ) => {
    const key = `${rowId}:${action}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    publishPending();
    let message: string | null;
    try {
      message = await request();
    } catch {
      message = failureMessage;
    } finally {
      inFlight.current.delete(key);
      publishPending();
    }
    setRowError(rowId, message);
  };

  return {
    run,
    isPending: (rowId: string, action: string) =>
      pending.has(`${rowId}:${action}`),
    errorFor: (rowId: string): string | undefined => errors[rowId],
    dismissError: (rowId: string) => setRowError(rowId, null),
    /** A different day is a different list; its rows' failures do not carry over. */
    clearErrors: useCallback(() => setErrors({}), []),
  };
}

/** The failure beside the row it belongs to, announced and dismissible. */
export function KioskRowError({
  message,
  onDismiss,
}: {
  message: string | undefined;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mt-1 flex items-center justify-between gap-3 rounded-lg bg-kiosk-danger-solid px-4 py-1 text-sm font-medium text-kiosk-danger-solid-fg"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="link"
        onClick={onDismiss}
        className="h-auto min-h-[44px] shrink-0 px-3 font-semibold text-kiosk-danger-solid-fg underline"
      >
        Dismiss
      </Button>
    </div>
  );
}

/** The visible label on a row's control while its request is in flight. */
export const KIOSK_ROW_BUSY_LABEL = "Saving…";

/**
 * Mark Arrived / Mark Departed. `doneClassName` is the recorded state's colour,
 * or null while the action is still to do. Busy, it is disabled, says so in
 * words and to assistive technology, and keeps its 44 px target.
 */
export function KioskAttendanceButton({
  label,
  doneClassName,
  busy,
  onClick,
}: {
  label: string;
  doneClassName: string | null;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      className={cn(
        "h-auto min-h-[44px] rounded-lg px-4 py-2 shadow-none hover:shadow-none",
        doneClassName ??
          "bg-kiosk-accent text-kiosk-accent-fg hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active",
      )}
    >
      {busy ? KIOSK_ROW_BUSY_LABEL : label}
    </Button>
  );
}
