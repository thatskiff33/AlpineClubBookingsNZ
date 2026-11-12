"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { getDefaultBookingMessages } from "@/lib/booking-message-definitions";
import { Button } from "@/components/ui/button";

// Only reached when no caller passes the club's wording (unit tests); the
// booking page always renders the club's own message for this key (#4958).
const DEFAULT_CONFIRM_DESCRIPTION =
  getDefaultBookingMessages()["booking.detail.switchToInternetBankingConfirm"];

/**
 * Lets the owner of a card (Stripe) PAYMENT_PENDING booking switch to Internet
 * Banking instead. Posts to /api/payments/switch-to-internet-banking, then does
 * a full document reload so the page re-renders with the emailed-invoice
 * reference (the detail page already shows the Internet Banking card for an IB
 * booking). Only rendered when the Internet Banking module is on.
 *
 * The reload is deliberately a hard `window.location.reload()` rather than a
 * soft `router.refresh()`: the switch changes payment.source to
 * INTERNET_BANKING, and a fresh server render then deterministically shows the
 * Internet Banking card and drops the switch affordance. A soft refresh raced
 * the server re-render and intermittently flashed the pre-switch layout back for
 * a paint or left the button stuck on "Switching…" (render inconsistency #1148;
 * the soft-refresh version regressed the E2E for #1371 F28).
 *
 * The switch cannot be undone from the booking page (the card form goes and a
 * card payment is refused), so it posts only after the member confirms in the
 * shared dialog, whose wording is the club's (#4958).
 */
export function SwitchToInternetBankingButton({
  bookingId,
  confirmDescription = DEFAULT_CONFIRM_DESCRIPTION,
  description = "Prefer to pay by bank transfer? We'll email you a Xero invoice.",
}: {
  bookingId: string;
  description?: string;
  confirmDescription?: string;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function switchToInternetBanking() {
    if (busy) return;
    const confirmed = await confirm({
      title: "Switch to internet banking?",
      description: confirmDescription,
      confirmLabel: "Switch to internet banking",
      cancelLabel: "Keep paying by card",
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/payments/switch-to-internet-banking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to switch to internet banking right now.");
      }
      // Hard reload: guarantees a fresh server render of the Internet Banking
      // card and removes the switch affordance. `busy` stays true until the
      // reload navigates, so the button can never re-fire or stick.
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to switch to internet banking right now."
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t pt-4">
      {confirmDialog}
      <p className="mb-2 text-sm text-muted-foreground">{description}</p>
      <Button variant="outline" onClick={switchToInternetBanking} disabled={busy}>
        {busy ? "Switching..." : "Pay by internet banking instead"}
      </Button>
      {error ? (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
