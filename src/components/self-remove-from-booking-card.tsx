"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Lets a member who was put on somebody ELSE's booking take themselves off it
 * from the booking they are looking at (#2250).
 *
 * Before this the only entry point in the whole app was the booking wizard's
 * night-conflict card, so a member could only discover the action while trying
 * to make a clashing booking of their own.
 *
 * Eligibility is NOT re-derived here. `canSelfRemove` and `blockedReason` are
 * computed on the server by `evaluateGuestSelfRemoval`, the same rule the
 * removal service enforces. When the member is not eligible the action is
 * HIDDEN rather than disabled (a disabled button's `title` never fires — the
 * shared button variants set `disabled:pointer-events-none`) and the reason is
 * stated in the reading order instead.
 *
 * NO `router.refresh()` ON SUCCESS, deliberately — the one place in this repo
 * where the house pattern (`cancel-booking-button.tsx`,
 * `delete-booking-button.tsx`) does not apply. Once the guest row is gone the
 * member no longer satisfies the detail route's own guard
 * (`isLinkedGuestViewer`), so re-rendering the server component would redirect
 * them to /bookings and replace the confirmation they just earned with a list.
 * The booking summary above therefore still shows the party and total as they
 * were; the success card says so and offers the way out, rather than silently
 * leaving stale figures on screen.
 */
export function SelfRemoveFromBookingCard({
  bookingId,
  guestId,
  ownerFirstName,
  canSelfRemove,
  blockedReason,
}: {
  bookingId: string;
  /** The viewer's own `BookingGuest` row on this booking. */
  guestId: string;
  ownerFirstName: string;
  canSelfRemove: boolean;
  blockedReason: string | null;
}) {
  const [step, setStep] = useState<"idle" | "removing" | "removed" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const { confirm, confirmDialog } = useConfirm();
  // The confirm dialog returns focus to the trigger when it closes, but the
  // outcome that follows renders elsewhere on the page. Move focus to it so a
  // keyboard or screen-reader user is not dropped back to <body>.
  const outcomeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step === "removed" || step === "error") {
      outcomeRef.current?.focus();
    }
  }, [step]);

  async function handleRemove() {
    const confirmed = await confirm({
      title: "Take yourself off this booking?",
      description: `Your place is released and the rest of the booking stays as it is. ${ownerFirstName} is emailed about the change and their total is updated. You cannot undo this yourself — you would have to ask ${ownerFirstName} to add you back.`,
      confirmLabel: "Yes, take me off",
      cancelLabel: "Keep my place",
      destructive: true,
    });
    if (!confirmed) return;

    setErrorMessage("");
    setStep("removing");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/guests/${guestId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(
          typeof data.error === "string"
            ? data.error
            : "We could not take you off this booking. Please try again.",
        );
        setStep("error");
        return;
      }
      setStep("removed");
    } catch {
      setErrorMessage(
        "We could not take you off this booking. Please try again.",
      );
      setStep("error");
    }
  }

  if (step === "removed") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle headingLevel={2} className="text-success-11">
            You are off this booking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="status"
            className="space-y-3 outline-none"
          >
            <p>
              {/* The owner email is sent best-effort and is legitimately
                  skipped for a placeholder address or a suppressed recipient,
                  so this promises the attempt, not the delivery. */}
              Your place has been released and {ownerFirstName} will be emailed
              about the change. If you change your mind, ask {ownerFirstName} to
              add you back.
            </p>
            <p>
              The booking details above still show the party and total as they
              were before you came off — open your bookings to see the change.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/bookings">Back to my bookings</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle headingLevel={2}>You are a guest on this booking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          {ownerFirstName} made this booking and added you to it. It is not your
          booking to change
          {canSelfRemove
            ? ", but you can take your own place off it if you are no longer coming."
            : "."}
        </p>

        {!canSelfRemove ? (
          blockedReason ? (
            <p className="rounded-md border border-border bg-muted px-3 py-2">
              {blockedReason}
            </p>
          ) : null
        ) : (
          <>
            {step === "error" ? (
              <div
                ref={outcomeRef}
                tabIndex={-1}
                role="alert"
                className="rounded-md border border-danger-6 bg-danger-3 p-3 text-danger-11 outline-none"
              >
                {errorMessage}
              </div>
            ) : null}
            {/* The button stays mounted while the request is in flight — the
                label carries the progress visually and this live region
                announces it, instead of swapping the focused control out for a
                paragraph. */}
            <Button
              variant="outline"
              size="sm"
              disabled={step === "removing"}
              onClick={() => void handleRemove()}
            >
              {step === "removing"
                ? "Taking you off this booking..."
                : "Remove me from this booking"}
            </Button>
            <p aria-live="polite" className="sr-only">
              {step === "removing" ? "Taking you off this booking..." : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
