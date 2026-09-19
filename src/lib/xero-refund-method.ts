/**
 * How a booking's money went back to the member, as the ONE home for the words
 * a Xero refund or credit document carries (`INV-PAY-101`, #3529).
 *
 * A treasurer reconciling Xero needs to tell three things apart, because each
 * moves money differently: a card refund leaves the Stripe account, a bank
 * transfer leaves the club's ordinary bank account, and account credit moves
 * nothing at all. Until #3529 every refund note read "Refund for booking …",
 * every account-credit note "Account credit from booking …", and a hand-back
 * settled by bank transfer after a booking-edit review carried the CARD
 * wording, because the review leg mapped every non-credit route to `"card"`.
 *
 * The method is a property of the SETTLEMENT DECISION and travels from where
 * that decision is made — the cancel path, the edit-review route, the hand-back
 * completion — into the outbox payload and on to the builder. It is never
 * inferred from `Payment.source` where the caller knows better: an
 * internet-banking payment can be refunded as credit or by transfer, and a card
 * payment can be refunded as credit. `defaultRefundMethodForPaymentSource` is
 * the one fallback, for queued rows written before the field existed.
 *
 * Pure: no database, no provider, no clock. The three strings below are the
 * owner's exact wording (20 September 2026) and nothing else may spell them —
 * `xero-refund-method.test.ts` holds a census over `src/`.
 */

import { PaymentSource } from "@prisma/client";
import type { AccountMappingKey } from "@/lib/xero-account-mapping-keys";

export const REFUND_METHODS = ["card", "internet-banking", "account-credit"] as const;

export type RefundMethod = (typeof REFUND_METHODS)[number];

export const REFUND_METHOD_WORDING: Readonly<Record<RefundMethod, string>> = {
  card: "Refund against original credit card",
  "internet-banking": "Refund requested via internet banking",
  "account-credit": "Account Credit",
};

export function describeRefundMethod(method: RefundMethod): string {
  return REFUND_METHOD_WORDING[method];
}

export function isRefundMethod(value: unknown): value is RefundMethod {
  return (
    typeof value === "string" &&
    (REFUND_METHODS as readonly string[]).includes(value)
  );
}

/** A stored payload field, or null when absent or not one of the three. */
export function parseRefundMethod(value: unknown): RefundMethod | null {
  return isRefundMethod(value) ? value : null;
}

/**
 * The fallback for a caller that carries no method — a queued row from before
 * the field existed, or a repair re-driving one. A Stripe payment's money can
 * only have left through Stripe; anything else that reaches the cash-refund
 * builder went back by bank transfer. Account credit never reaches this: the
 * unapplied-note builder is account credit by construction.
 */
export function defaultRefundMethodForPaymentSource(
  source: PaymentSource | null | undefined,
): CashRefundMethod {
  return source === PaymentSource.INTERNET_BANKING ? "internet-banking" : "card";
}

/**
 * The booking-edit services' two-way `settlementMethod` ("card" | "credit") is
 * the MEMBER's choice between money back and credit kept; this is what it
 * means on the document. "Money back" is a card refund only where the payment
 * is a captured Stripe payment (`refundedThroughStripe`, the services' own
 * `hasSucceededPayment`); a booking paid another way and reduced "to card"
 * has its money returned by the club itself, so the note says a bank transfer
 * (review of #3537). Unknown reads as card, which every pre-#3529 row was. A
 * caller that knows the route outright passes the method instead.
 */
export function refundMethodForSettlementMethod(
  settlementMethod: "card" | "credit" | null | undefined,
  refundedThroughStripe?: boolean | null,
): RefundMethod {
  if (settlementMethod === "credit") return "account-credit";
  return refundedThroughStripe === false ? "internet-banking" : "card";
}

/** The two methods that settle a cash refund note: money actually left. */
export type CashRefundMethod = Exclude<RefundMethod, "account-credit">;

/**
 * Which bank account a cash refund note is SETTLED against — the credit-note
 * payment that records money leaving. Account credit records no payment, so
 * it is not in the domain. The internet-banking key has NO fallback: unset,
 * the note is raised without a settling payment (owner decision, #3529), and
 * `resolveRefundSettlement` in `xero-invoice-payments` is where that is
 * decided.
 */
export function refundSettlementMappingKey(
  method: CashRefundMethod,
): Extract<AccountMappingKey, "stripeBankAccount" | "bankTransferRefundAccount"> {
  return method === "card" ? "stripeBankAccount" : "bankTransferRefundAccount";
}

/** The short booking reference every Xero booking document already uses. */
function bookingRef(bookingId: string): string {
  return bookingId.slice(0, 8);
}

/**
 * The line-item description of a refund or credit document. `stay` is the
 * lodge-night range already formatted for the document (the builder owns the
 * date rendering, `INV-DATE-019`); `modificationId` marks a note raised by a
 * booking edit rather than a cancellation.
 */
export function buildRefundDocumentDescription(params: {
  method: RefundMethod;
  bookingId: string;
  stay?: { checkIn: string; checkOut: string } | null;
  modificationId?: string | null;
}): string {
  const head = `${describeRefundMethod(params.method)} - Booking ${bookingRef(params.bookingId)}`;
  if (params.modificationId) {
    return `${head} - booking change ${bookingRef(params.modificationId)}`;
  }
  if (params.stay) {
    return `${head} (${params.stay.checkIn} - ${params.stay.checkOut})`;
  }
  return head;
}

/** The document's `reference` field: the wording and the booking, nothing else. */
export function buildRefundDocumentReference(params: {
  method: RefundMethod;
  bookingId: string;
}): string {
  return `${describeRefundMethod(params.method)} - Booking ${bookingRef(params.bookingId)}`;
}

/**
 * The reference on the credit-note PAYMENT that settles a cash refund note —
 * the line the treasurer sees on the bank account. `clubName` is passed in so
 * this module stays free of configuration reads.
 */
export function buildRefundPaymentReference(params: {
  method: CashRefundMethod;
  clubName: string;
  paymentId: string;
}): string {
  return `${describeRefundMethod(params.method)} - ${params.clubName} payment ${params.paymentId.slice(0, 8)}`;
}
