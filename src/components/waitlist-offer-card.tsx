"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";
import {
  WAITLIST_CONFIRM_AWAITING_OPERATOR_MESSAGE,
  WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_MESSAGE,
  isWaitlistConfirmAwaitingOperator,
  isWaitlistOfferRevoked,
} from "@/lib/waitlist-confirm-recovery-contract";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { formatCents } from "@/lib/utils";

interface WaitlistOfferCardProps {
  bookingId: string;
  expiresAt: string;
  finalPriceCents: number;
  // Cross-lodge offer (ADR-004): the alternate lodge and the price quoted
  // for it. Both null for a same-lodge offer, which renders as before.
  offeredLodgeName?: string | null;
  offeredPriceCents?: number | null;
}

export function WaitlistOfferCard({
  bookingId,
  expiresAt,
  finalPriceCents,
  offeredLodgeName,
  offeredPriceCents,
}: WaitlistOfferCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  // Why the CTA is gone. `status-unverified` = we could not read the outcome, so
  // another confirm might duplicate a write. `offer-consumed` = the server told
  // us the offer no longer exists, so another confirm is guaranteed to fail with
  // "Booking is not in WAITLIST_OFFERED status" (#2623 T8). Both hide the CTA and
  // both offer the reload; only the heading and the copy differ, because the two
  // situations are not the same thing and were previously conflated (the second
  // one simply left the button live).
  const [confirmSuppressed, setConfirmSuppressed] = useState<
    "status-unverified" | "offer-consumed" | null
  >(null);
  const [timeLeft, setTimeLeft] = useState("");
  // Refreshed quote after an OFFER_PRICE_CHANGED rejection; the member
  // re-confirms at this figure.
  const [updatedPriceCents, setUpdatedPriceCents] = useState<number | null>(null);
  const isCrossLodge = offeredPriceCents !== null && offeredPriceCents !== undefined;
  const displayPriceCents = updatedPriceCents ?? offeredPriceCents;

  useEffect(() => {
    function updateCountdown() {
      const now = Date.now();
      const expires = new Date(expiresAt).getTime();
      const diff = expires - now;

      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(`${hours}h ${minutes}m remaining`);
    }

    updateCountdown();
    const interval = setInterval(updateCountdown, 60000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    try {
      const res = await fetch(`/api/bookings/${bookingId}/waitlist-confirm`, {
        method: "POST",
      });

      let data: {
        success?: boolean;
        newBookingId?: string;
        code?: string;
        error?: string;
        updatedPriceCents?: number;
        // #2623 T8 — the server's positive statement that the offer this card is
        // showing has already been consumed.
        offerRevoked?: boolean;
        waitlistPlaceRestored?: boolean;
        awaitingOperatorRecovery?: boolean;
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        showUnconfirmedStatus();
        return;
      }

      if (res.ok && data.success) {
        if (data.newBookingId) {
          // Cross-lodge accept: the entry was replaced by a fresh booking at the
          // offered lodge — hard-navigate there. A full load (not router.push)
          // keeps the F28 guarantee that the CTA can never stick on "Confirming…".
          window.location.assign(`/bookings/${data.newBookingId}`);
          return;
        }
        // Hard reload: the confirm POST succeeded server-side, so re-render the
        // page from the server to its new status (CONFIRMED/PENDING/PAID) with a
        // full document reload. `confirming` stays true until the reload navigates,
        // so the CTA can never stick on "Confirming…". A soft router.refresh()
        // raced the server re-render and could leave the button frozen (#1371 F28).
        window.location.reload();
        return;
      }

      if (res.ok) {
        // A successful HTTP response without the success contract is just as
        // ambiguous as an unreadable response: the write may have landed, so
        // another confirm must remain unavailable until canonical state reloads.
        showUnconfirmedStatus();
        return;
      }

      // #2623 T8 — BEFORE the generic refusal handler, and keyed on the flag
      // rather than the code. `HOSTING_COVERAGE_PARTICIPANT_RETRY` arrives from
      // two places: a phase-one refusal (the claim rolled back, the offer is
      // still live, and keeping the CTA enabled is right) and a phase-two
      // failure (the offer was already consumed). Only the flag distinguishes
      // them, and without it this card invited a second click that could only
      // ever answer "Booking is not in WAITLIST_OFFERED status".
      if (isWaitlistOfferRevoked(data)) {
        showOfferConsumedStatus(
          data.error ||
            (isWaitlistConfirmAwaitingOperator(data)
              ? WAITLIST_CONFIRM_AWAITING_OPERATOR_MESSAGE
              : WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_MESSAGE),
        );
        return;
      }

      if (
        data.code === "OFFER_PRICE_CHANGED" &&
        typeof data.updatedPriceCents === "number"
      ) {
        setUpdatedPriceCents(data.updatedPriceCents);
      }
      setError(data.error || "Failed to confirm booking");
      setConfirming(false);
    } catch {
      showUnconfirmedStatus();
    }
  }

  function showUnconfirmedStatus() {
    // #2668: this sentence was written here first (#2623 T8) and is now the
    // shared wording every unverified write in the app uses. Byte-for-byte the
    // same string it always was — it just no longer lives in one component.
    setError(
      unverifiedWriteMessage(
        "this offer was confirmed",
        "Reload the booking and check its current status before trying again.",
      ),
    );
    setConfirmSuppressed("status-unverified");
    setConfirming(false);
  }

  function showOfferConsumedStatus(message: string) {
    setError(message);
    setConfirmSuppressed("offer-consumed");
    setConfirming(false);
  }

  const isExpired = timeLeft === "Expired";

  return (
    <Card className="border-primary/30 bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">A Spot Has Opened Up!</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isCrossLodge ? (
          <>
            <p className="text-sm text-muted-foreground">
              A spot has become available at{" "}
              <strong>{offeredLodgeName ?? "another of our lodges"}</strong>, one
              of the alternate lodges you said you&apos;d accept.
            </p>
            <p className="text-sm text-muted-foreground">
              The price at this lodge for your stay is{" "}
              <strong>{displayPriceCents !== null && displayPriceCents !== undefined ? formatCents(displayPriceCents) : ""}</strong>
              , which differs from your original booking. Nothing is booked
              until you confirm this price — your original waitlist entry is
              replaced only once you do.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            A spot has become available for your waitlisted booking. Confirm now to secure your place.
          </p>
        )}

        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          {isExpired ? (
            <span className="text-danger-11">This offer has expired</span>
          ) : (
            <span>{timeLeft}</span>
          )}
        </div>

        {(isCrossLodge ? (displayPriceCents ?? 0) > 0 : finalPriceCents > 0) && (
          <p className="text-sm text-muted-foreground">
            You will be prompted to complete payment after confirming.
          </p>
        )}

        <FocusedActionError
          id="waitlist-confirm-error"
          error={error}
          heading={
            confirmSuppressed === "status-unverified"
              ? "Confirmation status could not be verified"
              : confirmSuppressed === "offer-consumed"
                ? "This offer is no longer open"
                : undefined
          }
          action={
            confirmSuppressed !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
              >
                Reload booking status
              </Button>
            ) : undefined
          }
        />

        <div className="flex gap-3">
          {confirmSuppressed === null ? (
            <Button
              onClick={handleConfirm}
              disabled={confirming || isExpired}
            >
              {confirming
                ? "Confirming..."
                : isCrossLodge && displayPriceCents !== null && displayPriceCents !== undefined
                  ? `Confirm at ${offeredLodgeName ?? "this lodge"} for ${formatCents(displayPriceCents)}`
                  : "Confirm Booking"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
