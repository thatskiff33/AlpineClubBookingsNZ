/**
 * #4370 (`INV-SSOT`, `INV-PAY-128`): HOW FAR A PAYMENT'S REFUND CREDIT NOTES
 * COVER MORE THAN THE CASH STILL STANDING BEHIND THEM. A card refund's note
 * stays in Xero when Stripe fails the refund later, so notes covering more than
 * the refund cash on record (`sumRefundCreditNoteCoverageCents`, net of live
 * reversals, against `resolveRefundNoteEligibleCash`) were raised for refunds
 * that failed since. The one sizing of that excess: a "Paid another way"
 * close's card-note cover (`failedLaterCardNoteCoverCents`) and the inbound
 * recount's subtraction of failures no reversal answers
 * (`readFailedCardRefundRecountCentsByPayment`) both read it.
 *
 * #4383 review (money M1): less the card notes raised before #4383 above what
 * a capped late-capture receipt recorded (`readLateCapturePreCapOverNoteCents`).
 * Those over-notes are the officer's to correct in Xero, never refunds that
 * failed later: read as such, a close would reverse them and the recount take
 * them off, and Xero would be corrected twice.
 *
 * Signed: negative where the notes cover less than the cash. Null when a note
 * an officer resolved by hand has an amount that cannot be read; callers then
 * decide nothing from it.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readLateCapturePreCapOverNoteCents } from "@/lib/late-capture-card-notes-in-xero";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } from "@/lib/xero-resolved-in-xero-fences";

export async function readRefundNoteCoverageAboveCashCents(
  payment: { id: string; bookingId: string; refundedAmountCents: number },
  db: Prisma.TransactionClient = prisma,
): Promise<number | null> {
  const resolved = await readResolvedRefundCreditNoteCoverage(payment.id, db);
  if (resolved.unreadableOperationIds.length > 0) return null;
  const coveredCents = await sumRefundCreditNoteCoverageCents(payment.id, resolved, db);
  const { eligibleCashCents } = await resolveRefundNoteEligibleCash(payment, db);
  const preCapOverNoteCents = await readLateCapturePreCapOverNoteCents(payment.id, db);
  return coveredCents - eligibleCashCents - preCapOverNoteCents;
}
