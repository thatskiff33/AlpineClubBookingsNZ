"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/utils";

/**
 * Withdraw a booking's unpaid additional-payment request (#3528,
 * `INV-ADDPAY-040`).
 *
 * Built like its sibling `ResendAdditionalPaymentButton`: a plain `Button`
 * rendered only for an admin who holds the permission the route re-checks
 * (`finance:edit`), with a view-only admin told in prose why it is absent.
 * Unlike the re-send, this retires money instruments, so it asks first, in
 * two steps on the page rather than a browser `confirm()`: the first press
 * shows what will be withdrawn and what will happen; the second does it. The
 * server is the authority on every refusal (already paid, not review-raised,
 * changed under you, provider would not cancel), and each is shown verbatim.
 */
export function WithdrawAdditionalPaymentButton({
  bookingId,
  amountCents,
}: {
  bookingId: string;
  amountCents: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function withdraw() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/additional-payment/withdraw`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to withdraw the payment request right now.");
      }
      setConfirming(false);
      setDone(
        `Payment request of ${formatCents(amountCents)} withdrawn. The member no longer owes it.`,
      );
      // NOT `router.refresh()` here: the panel around this button renders
      // nothing once nothing is owed, so a refresh would unmount this very
      // sentence before the officer had read it. The confirmation stays until
      // they choose to re-read the booking.
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to withdraw the payment request right now.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-success-11">{done}</p>
        <Button type="button" variant="outline" onClick={() => router.refresh()}>
          Refresh the booking
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {confirming ? (
        <div
          className="space-y-2 rounded-md border border-destructive/40 p-3"
          role="group"
          aria-label="Confirm withdrawing the payment request"
        >
          <p className="text-sm">
            Withdraw the request for <strong>{formatCents(amountCents)}</strong>?
            The card request is cancelled, the amount stops showing as owing, and
            any Xero invoice waiting on that payment is retired without being
            sent. The review that raised it stays completed; this withdrawal is
            recorded against the booking.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={withdraw}
              disabled={busy}
            >
              {busy ? "Withdrawing..." : `Withdraw ${formatCents(amountCents)}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirming(false);
                setError("");
              }}
              disabled={busy}
            >
              Keep the request
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          Withdraw payment request
        </Button>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
