"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { promoActionPayload, type PromoAction } from "@/components/edit-booking/hooks/use-promo-selection";
import type { Guest } from "@/components/edit-booking/types";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
import {
  changeRequestPromoChangeSchema,
  type ChangeRequestPromoChange,
} from "@/lib/booking-change-request-promo";

/**
 * #4533: what Edit Booking says on a FINISHED stay, in place of a Save that
 * cannot apply.
 *
 * A finished stay is locked to Save (`getBookingEditPolicy`), for officers too:
 * its corrections run inside the change-request approval (#3750). The promo
 * control still validated and showed the discount, so an officer chose a code
 * and Save simply did nothing. This card says why, and — for a promo code, the
 * one change an officer can raise for a finished stay — sends it as a promo
 * correction request and opens it in the queue, where approving applies it.
 *
 * Rendered by the panel only for an officer on a finished stay with a pending
 * edit (`editPolicy.finishedStayPromoCorrection`).
 */

/**
 * The officer's promo choice as a correction request carries it — Edit
 * Booking's own promo fields (`promoActionPayload`), read through the request's
 * schema — or null for no choice, a removal, or targets for guests being added.
 */
export function promoActionAsCorrection(
  promoAction: PromoAction,
  remainingGuests: readonly Pick<Guest, "id">[],
): ChangeRequestPromoChange | null {
  const parsed = changeRequestPromoChangeSchema.safeParse(promoActionPayload(promoAction, remainingGuests));
  return parsed.success ? parsed.data : null;
}

export const FINISHED_STAY_SAVE_LOCKED_MESSAGE =
  "This stay has finished, so Save can't change it.";

export function FinishedStayPromoCorrectionCard({
  bookingId,
  promoChange,
  otherChanges,
  promoRemoved,
}: {
  bookingId: string;
  /** The promo code(s) the officer chose, as Edit Booking would send them; null when none. */
  promoChange: ChangeRequestPromoChange | null;
  /** The edit also changes something other than the promo code. */
  otherChanges: boolean;
  /** The officer chose to remove the promo code. */
  promoRemoved: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const canSend = Boolean(promoChange) && !otherChanges && !submitting;

  async function send() {
    if (!promoChange || otherChanges) return;
    setSubmitting(true);
    setError("");
    setPendingRequestId(null);
    try {
      const response = await fetch(`/api/bookings/${bookingId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promoChange }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof data?.error === "string" && data.error ? data.error : "The request could not be sent. Try again.");
        if (typeof data?.requestId === "string") setPendingRequestId(data.requestId);
        return;
      }
      router.push(buildBookingRequestsHref("changes", { requestId: String(data.id) }));
    } catch {
      setError("The request could not be sent. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="finished-stay-promo-correction">
      <CardHeader>
        <CardTitle>{FINISHED_STAY_SAVE_LOCKED_MESSAGE}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Changes to a stay that has finished are made by approving a change
          request, so the fee rules, settlement and Xero all run the way they
          do for any other correction.
        </p>
        {promoRemoved ? (
          <p role="status">A promo code can&rsquo;t be removed from a finished stay.</p>
        ) : promoChange ? (
          <>
            <p>
              To apply this promo code, send it as a promo correction request.
              Approving it in Booking change requests applies the code exactly
              as Save would (who it is assigned to and its limits still apply),
              counts it as used, and settles the reduction — as account credit
              unless you choose a refund.
            </p>
            {otherChanges ? (
              <p role="status">
                Only the promo code can be sent as a correction from here. Undo
                the other changes first.
              </p>
            ) : null}
            <Button type="button" onClick={send} disabled={!canSend}>
              {submitting ? "Sending..." : "Send as a promo correction request"}
            </Button>
          </>
        ) : (
          <p role="status">
            Only a promo code can be sent as a correction from here. A guest or
            date correction is made by approving the member&rsquo;s change
            request.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
            {pendingRequestId ? (
              <>
                {" "}
                <Link
                  className="underline"
                  href={buildBookingRequestsHref("changes", { requestId: pendingRequestId })}
                >
                  Open the pending request
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
