/**
 * The settlement-source and result types of `payment-reconciliation.ts`, moved
 * here verbatim so that module stays within its size ceiling (#5005). The one
 * settlement body and every door that calls it remain in
 * `payment-reconciliation.ts`; nothing here runs.
 */
import type { CapacityCancellationRefund } from "@/lib/booking-card-refund-copy";
import type { ClubFormat } from "@/lib/club-format";

export type MarkBookingPaymentSucceededResult = {
  outcome:
    | "paid"
    | "already_paid"
    | "cancelled_refunded"
    | "cancelled_refund_failed"
    // #1992 — a SECOND, distinct Stripe capture arrived on an already-PAID
    // (or, #4285, COMPLETED) booking (the residual #1967 split-child window). The duplicate capture
    // was auto-refunded (or a durable refund operation is pending for the
    // recovery cron when the inline attempt failed). The booking itself stays
    // settled by the other capture, so callers that only branch on the
    // cancelled_* outcomes keep treating these as "settled".
    | "duplicate_capture_refunded"
    | "duplicate_capture_refund_failed"
    // #4211 (`INV-PAY-043`): a different capture on a PAID or COMPLETED booking with no usable record of
    // its settler, beside another payment holding money (or, #4285, alone and never recorded before) -
    // KEPT, nothing refunded, the admins asked to check by hand. Settled like
    // the two above: no confirmation email, no invoice of its own.
    | "duplicate_capture_kept"
    // #4300 (`INV-PAY-138`): the superseded machinery's; NOT settled, no confirmation or invoice.
    | "superseded_capture";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
  capacityRefund?: CapacityCancellationRefund;
};

/**
 * B5 (#2262) — a booking settlement is now described by its SOURCE, so the one
 * settlement body below serves both the Stripe capture and the admin recording
 * a cash / off-Xero bank transfer. Guard 1 of #2262 is discharged structurally:
 * there is no second path that could drift from this one's lock ordering,
 * capacity check, status fence, bed reconciliation or event recording.
 */
export type StripeSettlementSource = {
  kind: "stripe";
  capturedAt?: Date;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
  /** #3864: for the applied-credit give-back, resolved before the transaction. */
  format: ClubFormat;
};

/**
 * #2397 — the admin's answer to "does this cash also cover the outstanding
 * extra?", asked ONLY when the booking carries one.
 *
 * `expectedAdditionalAmountCents` is the figure the dialog showed, and follows
 * the same law as `expectedAmountCents`: the settle never takes an amount from
 * the client, it re-derives the outstanding extra under the locks and refuses
 * when the two disagree, so an extra that moved since the dialog rendered is
 * never settled at a figure the admin never saw.
 */
export type ManualAdditionalCoverage = {
  /** True = the cash covers the extra too; false = leave it outstanding. */
  covered: boolean;
  expectedAdditionalAmountCents: number;
};

export type ManualSettlementSource = {
  kind: "manual";
  actingAdminMemberId: string;
  note: string | null;
  /**
   * The amount the admin was shown in the dialog. The settlement amount itself
   * is NEVER taken from the client — it is recomputed under the locks — but a
   * mismatch means the price or the applied credit moved since the dialog
   * rendered, so the settle is refused rather than recorded at a figure the
   * admin never agreed to.
   */
  expectedAmountCents: number;
  notifyMember: boolean;
  /**
   * #2397. `null` is not "no opinion": it is the caller's positive claim that
   * the dialog showed NO outstanding extra, and the settle checks that claim
   * under the locks — an extra that exists with `null` here is a 409, exactly
   * as a moved price is. That keeps the common screen unchanged (no extra, no
   * question, no field) without letting a stale client silently settle only the
   * primary on a booking that has since grown an extra.
   */
  additionalCoverage: ManualAdditionalCoverage | null;
};

export type BookingSettlementSource = StripeSettlementSource | ManualSettlementSource;
