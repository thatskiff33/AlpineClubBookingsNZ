import { readUnnotedLateCaptureCardRefunds } from "@/lib/late-capture-refund-credit-note";
import { findLateCapturePaymentIntents, readLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";

/**
 * #3924 rounds 12 and 13 (`INV-PAY-110`, `INV-PAY-122`): A LATE CAPTURE'S CARD
 * REFUNDS NO NOTE WILL EVER ANSWER, for the repair tool's report-only
 * record-by-hand findings.
 *
 * Every card-refund path reads the capture's receipt as resolved by hand
 * (`readLateCaptureXeroReceipt`), so none raises a card note for it, and what
 * of its card refunds no note in Xero answers
 * (`readUnnotedLateCaptureCardRefunds`) is recorded by hand. Round 13: on
 * that verdict alone, whatever the paid-another-way verdict says - an
 * officer marking a linked change invoice resolved, as its retry's 409 says
 * to; a change invoice resolved by hand before the app sent it (#4038); a
 * kept invoice resolved by hand; or a close whose own note row exists. Main's
 * verdict is deliberately not widened to raise the note instead: rows
 * resolved before #3924 may already have been recorded by hand, and a note
 * would credit them twice.
 *
 * By capture, for the late captures among `paymentIntentIds`
 * (`findLateCapturePaymentIntents`), only where something is left. The repair
 * tool names each capture here in exactly one finding: the kept invoice's
 * (`KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND`), the close's
 * (`PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND`), or else
 * `LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND`. Round 14: with, apart, what a
 * card note sent to Xero without a reply may already answer
 * (`mayBeInXeroCents`), which is never recorded before Xero is checked.
 *
 * #4383: also a capture whose receipt the app recorded for only part of it,
 * where it was refunded above that part (`aboveRecordedCents`): no note
 * answers those cents, and an officer records them by hand only if they
 * recorded the receipt's unrecorded part by hand. Only that figure is read
 * of such a capture: the rest is the note writer's.
 */
export interface LateCaptureCardRefundsByHand {
  byHandCents: number;
  mayBeInXeroCents: number;
  aboveRecordedCents: number;
}

export async function readLateCaptureCardRefundsByHand(
  paymentId: string,
  paymentIntentIds: readonly string[],
): Promise<Map<string, LateCaptureCardRefundsByHand>> {
  const found = new Map<string, LateCaptureCardRefundsByHand>();
  for (const paymentIntentId of await findLateCapturePaymentIntents(paymentIntentIds)) {
    const { kind } = await readLateCaptureXeroReceipt(paymentIntentId);
    if (kind === "none") continue;
    const unnoted = await readUnnotedLateCaptureCardRefunds(paymentId, paymentIntentId);
    const left =
      kind === "resolved-by-hand"
        ? { byHandCents: unnoted.byHandCents, mayBeInXeroCents: unnoted.mayBeInXeroCents, aboveRecordedCents: 0 }
        : { byHandCents: 0, mayBeInXeroCents: 0, aboveRecordedCents: unnoted.aboveRecordedCents };
    if (left.byHandCents > 0 || left.mayBeInXeroCents > 0 || left.aboveRecordedCents > 0) found.set(paymentIntentId, left);
  }
  return found;
}
