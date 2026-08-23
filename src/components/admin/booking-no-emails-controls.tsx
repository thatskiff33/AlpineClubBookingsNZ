"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";

/**
 * The per-booking "No emails" switch (#2259, owner decision D10).
 *
 * D10 makes everything suppressible, but pays for it with a compensating
 * control the admin cannot skip: turning the switch ON requires an explicit
 * confirmation that they will tell the member themselves. That is why this is a
 * two-button dialog (the house idiom — see `confirm-pending-guests-button.tsx`)
 * and NOT a checkbox: a checkbox is missable, and the consequence here is that a
 * member is never told their booking was cancelled.
 *
 * The dialog is deliberately asymmetric. Turning the switch ON asks for the
 * acknowledgement; turning it OFF asks only for a plain confirm, because
 * restoring the club's normal behaviour needs no undertaking and a stuck switch
 * must always be clearable.
 *
 * Rendered only for admins — the member view of this booking never mounts it.
 * A member must never learn the switch exists.
 */
/**
 * When notifications were switched off for this booking.
 *
 * A real INSTANT, projected through the club's PERSISTED timezone (CT-4, #2870;
 * INV-CONFIG-002) rather than the container's `TZ`. `instantDate` keeps the
 * medium "16 Apr 2026" shape this line has always shown; only the zone's
 * AUTHORITY moved. The zone reaches this browser as data through
 * `ClubTimeProvider` - never from the viewer's own clock.
 */
function useHoldStampFormatter() {
  const clubTime = useClubTime();
  return (value: string) => clubTime.instantDate(new Date(value));
}

export function BookingNoEmailsControls({
  bookingId,
  noEmails,
  noEmailsAt,
  setByName,
  hasLiveWaitlistOffer,
  isWaitlisted = false,
}: {
  bookingId: string;
  noEmails: boolean;
  /** ISO timestamp of when the current episode began, for display. */
  noEmailsAt: string | null;
  /** Name of the admin who turned it on, when known. */
  setByName: string | null;
  /**
   * Whether the booking is sitting on a live, unexpired waitlist offer
   * (`bookingHasLiveWaitlistOffer`, evaluated server-side by the page).
   *
   * Turning the switch on does NOT retract that offer: the bed stays held, the
   * expiry clock keeps running, and the member is never told. The admin has to
   * be told that before they confirm, so the warning is rendered from this prop
   * rather than from the POST response — by the time the response arrives the
   * decision has already been made. The response's own
   * `hasLiveWaitlistOffer` is the authoritative after-the-fact reading and
   * drives the toast below, so a page that has gone stale still surfaces it.
   */
  hasLiveWaitlistOffer: boolean;
  /**
   * Whether the booking is still WAITLISTED (no offer made yet). Candidacy
   * exclusion means a silenced entry is passed over for offers entirely, so
   * nothing is withheld and nothing is recorded — the banner can never show
   * this consequence, so the dialog has to state it before the admin commits.
   */
  isWaitlisted?: boolean;
}) {
  const formatHoldStamp = useHoldStampFormatter();
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/no-emails, which requires bookings:edit —
  // a view-only bookings admin sees the control disabled (#1997/#2160).
  const canEdit = useAdminAreaEditAccess("bookings");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(nextNoEmails: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/no-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The acknowledgement is only meaningful when enabling; the route
        // refuses an enable without it with a 400.
        body: JSON.stringify(
          nextNoEmails
            ? { noEmails: true, acknowledged: true }
            : { noEmails: false },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : "Failed to update the No emails setting";
        setError(message);
        toast.error(message);
        return;
      }

      setDialogOpen(false);
      if (nextNoEmails) {
        toast.success(
          "All emails are now off for this booking. Tell the member yourself.",
        );
        if (data.hasLiveWaitlistOffer === true) {
          toast.warning(
            "This booking is holding a live waitlist offer. The bed stays held and the offer keeps counting down, but the member will not be told.",
          );
        }
      } else {
        toast.success(
          "Emails are back on for this booking. Anything withheld while the switch was on is not re-sent.",
        );
      }
      router.refresh();
    } catch {
      const message = "Failed to update the No emails setting";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const setOnDetail = noEmails
    ? [
        setByName ? `Turned on by ${setByName}` : "Turned on",
        noEmailsAt
          ? ` on ${formatHoldStamp(noEmailsAt)}`
          : "",
        ".",
      ].join("")
    : "";

  return (
    <div className="space-y-2">
      {noEmails && (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
          <p className="font-medium">All emails are off for this booking</p>
          <p>
            {setOnDetail} Nothing is sent to the member about this booking —
            including cancellation notices and payment reminders. You are
            responsible for telling them directly.
          </p>
        </div>
      )}
      {/* The dialog carries its own copy of the error (it renders above the
          page and would hide this one); this is the resting-state slot. */}
      {error && !dialogOpen && (
        <div
          role="alert"
          className="rounded-md bg-danger-3 p-3 text-sm text-danger-11"
        >
          {error}
        </div>
      )}
      <ViewOnlyActionButton
        canEdit={canEdit}
        variant="outline"
        onClick={() => {
          setError("");
          setDialogOpen(true);
        }}
        disabled={busy}
      >
        {noEmails ? "Turn emails back on" : "Turn off all emails"}
      </ViewOnlyActionButton>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => !busy && setDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noEmails
                ? "Turn emails back on for this booking?"
                : "Turn off all emails for this booking?"}
            </DialogTitle>
            <DialogDescription>
              {noEmails
                ? "The club will start emailing the member about this booking again. Messages withheld while the switch was on are NOT re-sent — if the member still needs to know about them, tell them yourself."
                : "No emails will be sent for this booking, including cancellation notices and payment reminders. The member will not be told anything about it. You are responsible for telling the member directly."}
            </DialogDescription>
          </DialogHeader>
          {/*
            Warned BEFORE the admin confirms, because it changes the decision.

            Note what this does and does not say. Candidacy exclusion means a
            live offer can only PREDATE the switch, so the offer email already
            went out and the member HAS been told and CAN still accept. What
            they will not get is the expiry notice or an acceptance
            confirmation. Saying "they cannot accept" would be worse than
            saying nothing: an officer who believed the bed was dead might
            reassign it out from under a member who is still entitled to it.
          */}
          {!noEmails && hasLiveWaitlistOffer && (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              <p className="font-medium">
                This booking is holding a live waitlist offer
              </p>
              <p>
                The member was already emailed this offer and can still accept
                it, so do not reassign the bed. The offer keeps counting down
                and turning emails off does not retract it — but the member
                will now get no expiry warning and no confirmation if they do
                accept, so follow it up yourself.
              </p>
            </div>
          )}
          {/*
            The consequence the banner is structurally blind to: a silenced
            WAITLISTED entry is skipped for offers entirely, so no offer is
            made, nothing is withheld, and no row is ever recorded. If it is not
            said here it is said nowhere.
          */}
          {!noEmails && isWaitlisted && (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              <p className="font-medium">
                This booking will be passed over for waitlist offers
              </p>
              <p>
                While emails are off it is skipped when beds are handed out, so
                no offer is made at all. It keeps its place in the queue and
                does not hold anyone else up, and nothing will appear in the
                withheld list to remind you — there is no offer to withhold.
              </p>
            </div>
          )}
          {/*
            Nit fix: the error used to render behind the dialog's own overlay,
            so a failed write looked like nothing happening at all.
          */}
          {error && (
            <div
              role="alert"
              className="rounded-md bg-danger-3 p-3 text-sm text-danger-11"
            >
              {error}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDialogOpen(false);
                // Clear on cancel: a stale error from a previous attempt must
                // not sit under the resting-state button as if it were current.
                setError("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant={noEmails ? "default" : "destructive"}
              disabled={busy}
              onClick={() => void submit(!noEmails)}
            >
              {busy
                ? "Saving..."
                : noEmails
                  ? "Turn emails back on"
                  : "Yes — I will tell the member myself"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
