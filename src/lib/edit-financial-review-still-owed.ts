import "server-only";

import {
  BookingStatus,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
} from "@prisma/client";

import { hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import type { ClubTimeZone } from "@/lib/club-time";
import { capturedShareOwedAfterCancellation } from "@/lib/edit-financial-review-cancel-netting";
import { chooseEditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { MANUAL_REFUND_TASK_RESOLUTION_SELECT } from "@/lib/manual-refund-task-resolution-select";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";

/**
 * #3835: what a review share on a CANCELLED booking will actually give back,
 * shown on the settle dialog BEFORE the officer completes it - so a bank
 * transfer is made for the netted figure, not the typed share.
 *
 * `route` says how it goes: by card, by hand (bank transfer), or as credit
 * minted against the payment. `refusal` is the sentence the completion would
 * refuse with, where it would.
 */
export type EditReviewStillOwedPreview =
  | {
      shareCents: number;
      /** The whole still owed: `captureCents` to the card or by hand, `creditCents` as account credit. */
      stillOwedCents: number;
      captureCents: number;
      creditCents: number;
      route: "card" | "hand-back" | "account-credit";
    }
  | { shareCents: number; refusal: string };

/** The rollback that keeps the preview a read: the route choice may backfill legacy rows. */
class PreviewRollback extends Error {
  constructor(readonly preview: EditReviewStillOwedPreview | null) {
    super("edit-review still-owed preview rollback");
  }
}

/**
 * The figure the completion would settle a `shareCents` refund at, worked out
 * by the completion's own route choice and netting (`chooseEditReviewSettlementRoute`,
 * `capturedShareOwedAfterCancellationCents`) - one rule, never a copy of it.
 * Run in a transaction that is always rolled back, so nothing it reads is
 * written. Null where there is nothing to preview: not an open financial
 * review, not a cancelled booking, or the credit-only route (#3791's give-back).
 *
 * Not taken under `lock(1)`: it is advice for the officer, and the completion
 * re-derives the figure under the lock, so a sibling completed in between moves
 * the completion's figure, never the money behind this one.
 */
export async function previewEditReviewStillOwed({
  taskId,
  shareCents,
  clubZone,
}: {
  taskId: string;
  shareCents: number;
  clubZone: ClubTimeZone;
}): Promise<EditReviewStillOwedPreview | null> {
  try {
    await prisma.$transaction(async (tx) => {
      const task = await tx.manualRefundTask.findUnique({
        where: { id: taskId },
        select: MANUAL_REFUND_TASK_RESOLUTION_SELECT,
      });
      if (
        !task ||
        task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW ||
        task.status !== ManualRefundTaskStatus.OPEN ||
        task.booking.status !== BookingStatus.CANCELLED
      ) {
        throw new PreviewRollback(null);
      }
      try {
        const route = await chooseEditReviewSettlementRoute({
          task,
          amountCents: shareCents,
          hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(task.booking),
          direction: ManualRefundTaskDirection.REFUND_TO_MEMBER,
          clubZone,
          store: tx,
        });
        if (route?.kind === "stripe-refund" || route?.kind === "local-allocation") {
          const kind = route.kind === "stripe-refund" ? "card" : "hand-back";
          const { refundCents: captureCents, creditBackCents: creditCents } = route;
          throw new PreviewRollback({ shareCents, stillOwedCents: captureCents + creditCents, captureCents, creditCents, route: kind });
        }
        if (route?.kind === "account-credit" && route.allocateAgainstPaymentId !== null) {
          // Minted against the payment and given back alike, it all reaches the member as credit.
          const owed = await capturedShareOwedAfterCancellation({
            bookingId: task.bookingId, taskId: task.id, booking: task.booking, shareCents, clubZone, store: tx,
          });
          const stillOwedCents = owed.captureCents + owed.creditCents;
          throw new PreviewRollback({ shareCents, stillOwedCents, captureCents: 0, creditCents: stillOwedCents, route: "account-credit" });
        }
        throw new PreviewRollback(null);
      } catch (error) {
        if (error instanceof ManualBookingPaymentError) throw new PreviewRollback({ shareCents, refusal: error.message });
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.preview;
    throw error;
  }
  return null;
}
