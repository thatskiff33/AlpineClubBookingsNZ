/**
 * #1641'S CARD DOUBLE-PAY FINGERPRINT, as a pure rule — one home for the
 * operator audit that enumerates it (`ib-hold-clearing-audit.ts`) and the
 * booking-ledger census that names it `KNOWN_DEFECT_HISTORY` (#3583,
 * `INV-MONEY-037`). Before #1641 a member who applied account credit to a card
 * booking had the credit consumed while the card was charged the FULL price,
 * so the member paid the applied slice twice. A #1641-fixed booking is charged
 * the effective amount, carries a positive `creditAppliedCents` mirror and has
 * its applied rows stamped, so it fails every clause below.
 *
 * Pure: no client, no logger.
 */
export interface CardAppliedCreditDoublePayRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  paymentStatus: string;
  paymentSource: string;
  /** payment.amountCents mirror (full finalPriceCents on a pre-fix double-pay). */
  amountCents: number;
  /** payment.creditAppliedCents mirror (0 on a pre-fix double-pay). */
  creditAppliedCents: number;
  finalPriceCents: number;
  /** |Σ UN-allocated BOOKING_APPLIED(appliedToBookingId=booking)| — ledger truth. */
  ledgerAppliedCents: number;
}

export interface CardAppliedCreditDoublePayFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  paymentStatus: string;
  paymentSource: string;
  amountCents: number;
  creditAppliedCents: number;
  finalPriceCents: number;
  ledgerAppliedCents: number;
  /** Credit the member already lost — the local restore amount. */
  strandExposureCents: number;
}

/**
 * Pure per-row classification. Returns a finding only for the exact pre-fix
 * double-pay fingerprint (full-price capture + zero mirror + positive unallocated
 * applied ledger); otherwise null. A #1641-fixed booking fails every clause.
 */
export function deriveCardAppliedCreditDoublePayFinding(
  row: CardAppliedCreditDoublePayRow,
): CardAppliedCreditDoublePayFinding | null {
  if (row.ledgerAppliedCents <= 0) {
    return null;
  }
  if (row.creditAppliedCents !== 0) {
    return null;
  }
  if (row.amountCents !== row.finalPriceCents) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    paymentStatus: row.paymentStatus,
    paymentSource: row.paymentSource,
    amountCents: row.amountCents,
    creditAppliedCents: row.creditAppliedCents,
    finalPriceCents: row.finalPriceCents,
    ledgerAppliedCents: row.ledgerAppliedCents,
    strandExposureCents: row.ledgerAppliedCents,
  };
}
