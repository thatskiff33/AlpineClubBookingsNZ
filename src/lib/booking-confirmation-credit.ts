import { bookingWorthCents } from "@/lib/booking-payment-state";
import { PaymentSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import {
  type AppliedCreditSummary,
  type ConfirmationSettlementMethod,
} from "@/lib/booking-money-lines";

/**
 * #2328: the applied-account-credit facts a booking confirmation must state,
 * read off the booking's OWN PERSISTED RECORDS.
 *
 * Why this exists at all. A member who puts $120.00 of account credit towards a
 * $300.00 stay is charged $180.00, but every confirmation send passed the
 * booking's `finalPriceCents` as the email's total, so the message read
 * "Total Paid: $300.00" with nothing to explain the $120.00 the card never saw.
 * Thirteen call sites across twelve modules had the same hole, and none of them
 * carried the credit figure, because it is recorded somewhere else entirely.
 *
 * Why `sendBookingConfirmedEmail` calls this itself, rather than each send site
 * threading the figure in. Thirteen sites is thirteen chances to forget, and the
 * fourteenth — written next year — would reintroduce the bug silently, because
 * a missing credit line looks exactly like a booking that used no credit. The
 * sender already has the one input this needs (the booking id it is required to
 * be given), and every site calls it AFTER its settlement transaction has
 * committed, so there is nothing a site could tell us that the booking's own
 * rows do not already say more reliably.
 *
 * Why it READS rather than RE-COMPUTES. `calculateBookingCreditApplication`
 * decides what credit to apply at booking time; re-running it at send time
 * would answer "what would we apply now", against a balance and a price that
 * have both moved since. The truth is the ledger:
 * `deriveBookingAppliedCreditCents` sums this booking's `BOOKING_APPLIED` rows
 * — the same derivation the card/Internet-Banking effective-price guards, the
 * #1887 reprice clamp and the $0 settlement all key on — so the email quotes
 * exactly the money the club actually took off the member's balance, including
 * any later clamp offset. See `src/lib/member-credit.ts` for why that sum, and
 * not `Payment.creditAppliedCents`, is the authority.
 *
 * The settlement method comes from the same booking's persisted Payment row, so
 * the second line of the pair ("Paid by card" / "Paid by bank transfer" /
 * "Paid by cash or bank transfer") states how the club was really paid. A
 * manually-recorded cash settlement (#2262) is stored as an ordinary
 * `INTERNET_BANKING` payment with `manuallyMarkedPaidAt` set, so that stamp —
 * never the source alone — is what identifies it.
 *
 * Call this AFTER the settlement transaction has committed (every confirmation
 * send site does), so the ledger rows and the Payment row it reads are the
 * settled ones.
 *
 * The two degraded shapes are INDEPENDENT, and only one of them renders nothing
 * (#2328 review — an earlier version of this sentence ran them together):
 *  - **No credit spent on this booking** (`amountCents === 0`, the overwhelming
 *    majority). The pair renders NOTHING AT ALL, whatever the Payment row says,
 *    so the confirmation is byte-for-byte what it was before #2328.
 *  - **No Payment row for this booking yet.** That says nothing about credit —
 *    the ledger is read separately and may well report a spend. It degrades the
 *    SETTLEMENT METHOD only, to "card"
 *    (`resolveConfirmationSettlementMethod`), so a booking with credit applied
 *    but no Payment row DOES render the pair, with a "Paid by card" label
 *    resting on a fallback rather than on evidence. The combination is not
 *    expected: every send site settles before it sends. Where it would matter
 *    most — a stay fully covered by credit, whose Payment row carries no source
 *    at all — the label is method-neutral anyway ("Nothing more to pay"), by
 *    the same reasoning; see `NOTHING_SETTLED_LABEL` in
 *    `booking-money-lines.ts`.
 *
 * `expectedTotalCents` is the total the CALLER is about to print. Passing it
 * costs nothing and makes a two-instant read observable: this function reads
 * the booking fresh, while the caller's total is a snapshot taken earlier, so a
 * reprice landing in between would produce a pair that reconciles against
 * neither figure. Nothing is corrected — the caller's figure is still what
 * renders — the mismatch is only logged.
 */
export async function loadBookingAppliedCredit(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  expectedTotalCents?: number,
): Promise<AppliedCreditSummary> {
  const [amountCents, booking] = await Promise.all([
    deriveBookingAppliedCreditCents(bookingId, db),
    // One read for both facts: how the rest was settled, and the price the
    // booking carries RIGHT NOW (for the staleness check below).
    db.booking.findUnique({
      where: { id: bookingId },
      select: {
        finalPriceCents: true,
        payment: { select: { source: true, manuallyMarkedPaidAt: true, changeFeeCents: true } },
      },
    }),
  ]);

  // #3750: callers print the booking's worth (price plus a recorded change
  // fee), so that is what a moved price is measured against.
  if (
    expectedTotalCents !== undefined &&
    booking &&
    bookingWorthCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment?.changeFeeCents ?? null,
    }) !== expectedTotalCents
  ) {
    // #2328 (review): the credit figure is read HERE, at send time, while the
    // total was snapshotted by the caller before its settlement transaction —
    // and most confirmation sends are fire-and-forget, so the gap is real
    // wall-clock time. A reprice inside that gap yields a pair whose
    // "total − credit = settled" arithmetic reconciles with neither the price
    // the member is reading nor the price now stored. No known path does this
    // (a reprice re-sends its own confirmation), so this is a watchpoint, not a
    // fix: the caller's total is still what renders, because that is the figure
    // the rest of the message was composed from.
    logger.warn(
      {
        bookingId,
        emailTotalCents: expectedTotalCents,
        bookingFinalPriceCents: booking.finalPriceCents,
        appliedCreditCents: amountCents,
      },
      "Booking price moved between the confirmation's total and its applied-credit read (#2328)",
    );
  }

  return {
    amountCents,
    settlementMethod: resolveConfirmationSettlementMethod(booking?.payment ?? null),
  };
}

/**
 * Pure half of the above, so the three-way mapping is unit-testable away from
 * the database. `null` (no Payment row) falls back to "card": it is the shape
 * every Stripe booking has before its row is written. The fallback describes
 * the METHOD only and never suppresses the credit lines — see the caller's
 * docblock for why those two are independent.
 */
export function resolveConfirmationSettlementMethod(
  payment: { source: PaymentSource; manuallyMarkedPaidAt: Date | null } | null,
): ConfirmationSettlementMethod {
  if (!payment) return "card";
  if (payment.manuallyMarkedPaidAt) return "manual";
  return payment.source === PaymentSource.INTERNET_BANKING
    ? "bank_transfer"
    : "card";
}
