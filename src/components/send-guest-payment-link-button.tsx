"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";

/**
 * Split-booking guest-portion affordance (#1967). Shown with the
 * switch-to-Internet-Banking control (pre-switch) and on the booking page
 * after the member's own place is settled by internet banking: because paying
 * the member's own place by internet banking leaves no card on file for the
 * later guest charge, this lets the booker email themselves a secure payment
 * link for the guest portion. It posts to
 * /api/bookings/[id]/send-guest-payment-link, a true send/RE-SEND: an existing
 * link is revoked and a fresh one sent (raw tokens are never stored, so a new
 * mint is the only way to re-send), while a link minted within the last minute
 * short-circuits server-side — pressing the button twice never fans out
 * duplicate emails or leaves two live links.
 */
export function SendGuestPaymentLinkButton({ bookingId }: { bookingId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);

  async function sendLink() {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const res = await fetch(
        `/api/bookings/${bookingId}/send-guest-payment-link`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error || "Unable to send the payment link right now."
        );
      }
      // #2258: a booking can have several provisional children, and some may not
      // have been emailed. Claiming unqualified success would leave the booker
      // believing every guest is covered when they are not — so name the
      // shortfall, without naming its cause. The server sends only this
      // aggregate to a non-admin; the cause-specific counts are admin-only.
      const notDelivered = Number(data.notDelivered ?? 0);
      const shortfall =
        notDelivered > 0
          ? ` ${notDelivered} of your guest bookings could not be emailed — please contact the club about ${notDelivered === 1 ? "it" : "them"}.`
          : "";
      if (data.sent > 0) {
        setSentOnce(true);
        setDone(
          `We've emailed you a secure link to pay for your guests. Any earlier link no longer works.${shortfall}`
        );
      } else if (data.justSent > 0) {
        setSentOnce(true);
        // The cooldown branch needs the shortfall too: a second click on a
        // booking with a partial send must not report unqualified success.
        setDone(
          `A payment link was sent moments ago — check your email (and spam folder). You can request a fresh one in a minute.${shortfall}`
        );
      } else {
        setDone("Your guests' payment is already taken care of.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to send the payment link right now."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <Button type="button" variant="outline" onClick={sendLink} disabled={busy}>
        {busy
          ? "Sending..."
          : sentOnce
            ? "Re-send the payment link"
            : "Email me a payment link for my guests"}
      </Button>
      {/* #4949: mounted before the request, so the confirmation is announced. */}
      <p role="status" className={done ? "mt-2 text-sm text-success-11" : "sr-only"}>
        {done}
      </p>
      <FocusedActionError
        id={`send-guest-payment-link-${bookingId}-error`}
        error={error}
        className="mt-2"
      />
    </div>
  );
}
