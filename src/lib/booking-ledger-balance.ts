/**
 * WHAT A BOOKING'S LINES COME TO (#3580, programme #3527).
 *
 * The ledger's whole point is that the balance is DERIVED. This module is the
 * one place it is derived, and it is pure: it takes lines and returns figures,
 * reads nothing, and knows nothing about Prisma. Every future reader — the
 * member statement, the confirmation email, the Xero renderers, the census
 * that guards the projection (#3583) — sums through here rather than writing
 * its own `reduce`, which is what stops a second answer existing.
 *
 * Nothing calls it outside its own tests until C5 (#3584).
 */

/** The fields a sum needs. Anything wider is the caller's business. */
export type BookingLedgerLineForBalance = {
  side: "CHARGE" | "SETTLEMENT" | "ADJUSTMENT";
  amountCents: number;
};

export type BookingLedgerBalance = {
  /** What the stay cost, net of every reversal. */
  chargedCents: number;
  /** What has moved to settle it — captures, receipts, credit, minus refunds. */
  settledCents: number;
  /** What a person decided on top, with their reason on the line. */
  adjustedCents: number;
  /**
   * `charged + adjusted - settled`. Positive: the member owes. Negative: the
   * club owes the member. Zero: settled.
   */
  owedCents: number;
};

function sumSide(
  lines: readonly BookingLedgerLineForBalance[],
  side: BookingLedgerLineForBalance["side"],
): number {
  let total = 0;
  for (const line of lines) {
    if (line.side === side) total += line.amountCents;
  }
  return total;
}

/**
 * The four figures, from one pass' worth of lines.
 *
 * A REVERSAL NEEDS NO SPECIAL CASE, and that is the design working: a
 * reversing line carries the opposite sign, so it cancels its original inside
 * the same sum. There is no "net of reversals" step to forget.
 */
export function bookingLedgerBalance(
  lines: readonly BookingLedgerLineForBalance[],
): BookingLedgerBalance {
  const chargedCents = sumSide(lines, "CHARGE");
  const settledCents = sumSide(lines, "SETTLEMENT");
  const adjustedCents = sumSide(lines, "ADJUSTMENT");
  return {
    chargedCents,
    settledCents,
    adjustedCents,
    owedCents: chargedCents + adjustedCents - settledCents,
  };
}

/** What the booking's price comes to: the charge side plus agreed adjustments. */
export function bookingLedgerPriceCents(
  lines: readonly BookingLedgerLineForBalance[],
): number {
  const balance = bookingLedgerBalance(lines);
  return balance.chargedCents + balance.adjustedCents;
}
