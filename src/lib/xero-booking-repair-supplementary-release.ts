import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import {
  classifyEditReviewChargeCapture,
  isSupplementaryInvoiceChargeRequestRow,
  type SupplementaryInvoiceChargeKind,
} from "./xero-booking-repair-payments";
import type { BookingXeroRepairAction } from "./xero-booking-repair-types";
import type { RepairDependencies } from "./xero-booking-repair-deps";

/**
 * THE MEMBER WHO PAYS WHILE THE SWEEP IS RUNNING (#3187 fix round).
 *
 * The plan that parked this invoice on a PaymentIntent was decided from the
 * snapshot the loader took when the pass STARTED, and the enqueue happens
 * minutes later. In between, the member can pay: the webhook's release runs,
 * finds no `WAITING_PAYMENT` row because none exists yet, and does nothing - and
 * then this pass creates exactly that row, parked on a confirmation that has
 * already been and gone. Nothing re-checks. The 14-day stale reaper is the only
 * thing that ever clears it, and until then the anchor reads
 * `BLOCKED_BY_XERO_OPERATION` at warning severity, "waiting for its additional
 * Stripe payment", so the tool CONCEALS the finding it exists to raise. The
 * sweep acts on requests outstanding for days, so this is the ordinary case.
 *
 * WHY AFTER THE ENQUEUE AND NOT BEFORE IT. Re-reading the request just before
 * queueing would only narrow the window; check-then-write always leaves one.
 * Read AFTERWARDS and there is no window at all - the row the webhook's release
 * needs already exists before anybody looks at the capture, so whichever of the
 * two observes it first, one of them releases it. The write is fenced on
 * `WAITING_PAYMENT` and on this PaymentIntent, so a second release matches
 * nothing, and an invoice a later request has already taken over is not
 * released as this capture's.
 * The end state is byte-identical to the live path's own, because it IS the live
 * path's release function.
 *
 * IT RELEASES ONLY ON `covers-ask`. A capture SHORT of the ask must stay parked:
 * the worker books the invoice's own net as the Stripe receipt, so releasing
 * would assert money the club does not hold - the overstatement
 * `planSupplementaryInvoicePayment` refuses at classify time, arriving by a
 * different door. That case is reported instead. The invoice it leaves behind
 * is not issued: the waiting-invoice reaper's next run (#3641) finds its payment
 * captured, applies the same capture rule, and cancels it unsent with an alert
 * to an officer, so the shortfall is collected by hand.
 */
export async function releaseRepairedSupplementaryInvoiceIfAlreadyPaid(params: {
  action: BookingXeroRepairAction;
  deps: RepairDependencies;
  bookingId: string;
  bookingModificationId: string;
  paymentIntentId: string;
  expectedNetAmountCents: number;
  format: ClubFormat;
  chargeKind: SupplementaryInvoiceChargeKind;
}) {
  const { action, deps } = params;
  // The intent identifies one ledger row. Whether it is still this edit's ask
  // is the same predicate classification used, not a second query spelling.
  const request = await deps.prisma.paymentTransaction.findFirst({
    where: {
      payment: { bookingId: params.bookingId },
      stripePaymentIntentId: params.paymentIntentId,
    },
    orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
    select: {
      status: true,
      amountCents: true,
      kind: true,
      source: true,
      reason: true,
      bookingModificationId: true,
    },
  });

  if (
    !request ||
    !isSupplementaryInvoiceChargeRequestRow(
      request,
      params.bookingModificationId,
      params.chargeKind,
    )
  ) {
    return;
  }

  const capture = classifyEditReviewChargeCapture(
    request,
    params.expectedNetAmountCents
  );

  if (capture === "not-captured") {
    return;
  }

  if (capture === "short-of-ask") {
    action.status = "manual_review";
    action.resultMessage = `${action.resultMessage} The member's card was captured while this sweep ran, but for ${formatCents(request.amountCents, params.format)} against an ask of ${formatCents(params.expectedNetAmountCents, params.format)}. The queued invoice was deliberately NOT released - releasing it would book the full ask as received - so it will be retired unsent, and the difference has to be collected by hand.`;
    return;
  }

  const released =
    await deps.releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
      params.paymentIntentId
    );

  if (released.released > 0) {
    action.resultMessage = `${action.resultMessage} The member's card had already been captured, so the queued invoice was released for sending instead of waiting for a confirmation that has already happened.`;
  }
}
