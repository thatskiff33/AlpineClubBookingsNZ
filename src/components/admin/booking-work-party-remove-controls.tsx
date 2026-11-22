"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";
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
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubFormat } from "@/components/club-format-provider";
import { formatCents } from "@/lib/pricing";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { apiErrorCodeFromBody, apiErrorMessageFromBody } from "@/lib/api-error-message";
import {
  WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE,
  WORK_PARTY_FIGURES_CHANGED_CODE,
} from "@/lib/work-party-figures-changed";
import type { WorkPartyCorrectionFigures } from "@/lib/work-party-booking-correction";

/**
 * "Remove from work party" (fork triyder/AlpineClubBookingsNZ#130), beside where Add sits on the admin
 * tools card, for a booking added to the wrong work party or by mistake. The
 * dialog runs the real change as a dry run and shows the new total; the
 * difference is owed on the booking, like any edit that raises the price.
 * Credit already given and refunds already paid are left alone. The figures
 * shown are the figures saved — the route refuses if they moved.
 * Bookings edit; a bookings-view admin sees the button disabled.
 */
export function BookingWorkPartyRemoveControls({
  bookingId,
  workParty,
  noEmails = false,
}: {
  bookingId: string;
  /** The work party the booking is on. */
  workParty: { id: string; name: string };
  /** The booking's "No emails" switch: when on, the member is not emailed. */
  noEmails?: boolean;
}) {
  const canEdit = useAdminAreaEditAccess("bookings");
  const format = useClubFormat();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [figures, setFigures] = useState<WorkPartyCorrectionFigures | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The shared removal rule's refusal, from the GET (`workPartyRemovalEligibility`).
  const [refusal, setRefusal] = useState<string | null>(null);
  const money = (cents: number) => formatCents(cents, format);

  async function send(mode: "preview" | "apply", notify?: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetchWithRecentAuth(`/api/admin/bookings/${bookingId}/work-party`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "preview"
            ? { mode, action: "remove", workPartyEventId: workParty.id }
            : {
                mode,
                action: "remove",
                workPartyEventId: workParty.id,
                // Silenced: undefined, so the field is dropped and the mailer
                // withholds and records the send (#2259 H1).
                notifyMember: noEmails ? undefined : notify,
                expectedFigures: figures,
              },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && apiErrorCodeFromBody(data) === WORK_PARTY_FIGURES_CHANGED_CODE) {
        setFigures(data.figures);
        setError(apiErrorMessageFromBody(data, WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE));
        return;
      }
      if (!res.ok) {
        setError(apiErrorMessageFromBody(data, "The booking could not be removed from the work party."));
        return;
      }
      if (mode === "preview") {
        setFigures(data.figures);
        return;
      }
      setOpen(false);
      toast.success("Booking removed from the work party.");
      if (data.followUpFailed) {
        toast.warning(
          "Saved, but a follow-up step (email or accounting) did not complete. Check the booking.",
        );
      }
      router.refresh();
    } catch {
      // fetch also rejects after a commit, so this cannot say nothing moved.
      setError(
        mode === "preview"
          ? "Could not check the new total. Check your connection and try again."
          : unverifiedWriteMessage(
              "the booking was removed from the work party",
              "Reload the booking and check its price and history before trying again.",
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Asks the removal rule first, as Add lists its eligibility; previews only when it allows. */
  async function openDialog() {
    setOpen(true);
    setFigures(null);
    setError("");
    setRefusal(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/work-party`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessageFromBody(data, "Could not load this booking's work party."));
        return;
      }
      if (data.removal && !data.removal.eligible) {
        setRefusal(data.removal.reason ?? "This booking can't be removed from its work party.");
        return;
      }
    } catch {
      setError("Could not load this booking's work party. Check your connection and try again.");
      return;
    } finally {
      setBusy(false);
    }
    void send("preview");
  }

  return (
    <div className="space-y-1">
      <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={openDialog}>
        Remove from work party
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Remove booking from &ldquo;{workParty.name}&rdquo;</DialogTitle>
            <DialogDescription>
              The booking is repriced without the work party&apos;s discount. The
              difference is owed on the booking, like any change that raises the
              price. Credit already given and refunds already paid are not taken
              back.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {busy && !figures && <p className="text-muted-foreground">Checking the new total…</p>}
            {refusal && (
              <p data-testid="work-party-remove-refusal" className="text-muted-foreground">
                {refusal}
              </p>
            )}
            {figures && (
              <div
                className="space-y-1 rounded-md border p-3"
                data-testid="work-party-remove-figures"
                aria-live="polite"
              >
                <p>
                  New total: <strong>{money(figures.newFinalPriceCents)}</strong>{" "}
                  (was {money(figures.previousFinalPriceCents)})
                </p>
                {figures.billedToOrganiserCents > 0 ? (
                  <p>
                    Invoiced to the group organiser: <strong>{money(figures.billedToOrganiserCents)}</strong>
                  </p>
                ) : (
                  <p>
                    Added to what is owed on the booking:{" "}
                    <strong>{money(figures.priceDiffCents)}</strong>
                  </p>
                )}
                {figures.additionalAmountCents > 0 && (
                  <p>
                    Asked of the member now: <strong>{money(figures.additionalAmountCents)}</strong>
                  </p>
                )}
                {noEmails && <BookingNoEmailsNotice />}
              </div>
            )}
            {error && (
              <p role="alert" className="font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {figures ? (
              !noEmails ? (
                <>
                  <Button variant="outline" onClick={() => send("apply", false)} disabled={busy}>
                    Remove without emailing
                  </Button>
                  <Button onClick={() => send("apply", true)} disabled={busy}>
                    {busy ? "Saving…" : "Remove and email member"}
                  </Button>
                </>
              ) : (
                <Button onClick={() => send("apply")} disabled={busy}>
                  {busy ? "Saving…" : "Remove from work party"}
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
