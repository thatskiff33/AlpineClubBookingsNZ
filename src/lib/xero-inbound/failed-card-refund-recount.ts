/**
 * #4370 (`INV-PAY-128`, `INV-PAY-151`; owner decision 11 Nov 2026, option (a)):
 * WHAT THE INBOUND RECOUNT TAKES OFF A PAYMENT FOR CARD REFUNDS STRIPE FAILED
 * LATER. A card refund's credit note records an instruction Stripe accepted,
 * not money that stayed returned: when Stripe fails the refund the note stays
 * in Xero, and the recount (`repairRefundedPaymentBusinessState`) would count
 * it again at every later credit-note event. Each failed refund comes off once:
 *
 * - **reversed**: through its live reversal invoice, at the cents #4369's
 *   net-coverage reader takes off (`readCardRefundReversalCentsByPayment`). A
 *   voided or deleted reversal takes off nothing, as it adds its note's
 *   coverage back there;
 * - **never reversed** (a failure from before #4369, or one no close has
 *   answered yet): through the failure record - the refunds the ledger writer
 *   recorded as failed after they counted (`failedRefundIds` on a card refund
 *   row's slices, or a row of its own, `card_refund_failed_later_<refund>`),
 *   at their `PaymentRefund` amounts, less every reversal ever raised on the
 *   payment, voided ones included, so a failure a reversal answered is never
 *   taken off a second time. Never more than the payment's refund notes cover
 *   above the cash still standing (`readRefundNoteCoverageAboveCashCents`, the
 *   reader a "Paid another way" close's card cover shares), with none of the
 *   close's adjustments for documents still queued: this follows what Xero
 *   holds. A failure whose note was never raised, or whose money a later refund
 *   or close has paid back under a note of its own, so takes off nothing.
 *
 * A payment with no failed-later refund and no reversal reads 0 and is absent
 * from the map: it recounts exactly as before. Where the notes' cover above
 * cash cannot be read (a hand-resolved note with no readable amount), the
 * whole unreversed failure comes off: a failed-later refund is a card refund,
 * so a lower total is kept off and alerted by the raise-only floor (#1353),
 * never written, and never raised over the failure either.
 *
 * Reads only, in one read-only snapshot (`withReadOnlySnapshot`): no lock, no
 * Xero call. Neither the reversal-link writer nor a refund note's link writer
 * moves a Payment column, so the caller's compare-and-set claim (#3979) cannot
 * see a reversal or a note linked mid-read. The one snapshot keeps the live,
 * raised and coverage reads agreeing, and with them the caller's own read of
 * the refund notes it counts (`readNotesCounted`): the subtraction is sized
 * against the same notes the raw total adds, never a note linked in between.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CARD_REFUND_OPERATION_WHERE, cardRefundSliceFailedRefundIds, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { cardRefundFailedLaterRefundId } from "@/lib/payment-recovery-keys";
import { readRefundNoteCoverageAboveCashCents } from "@/lib/refund-note-coverage-above-cash";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";
import { readCardRefundReversalCentsByPayment } from "@/lib/xero-resolved-in-xero-fences";

export async function readFailedCardRefundRecountCentsByPayment<NotesCounted>(
  payments: ReadonlyArray<{ id: string; bookingId: string; refundedAmountCents: number }>,
  readNotesCounted: (db: Prisma.TransactionClient) => Promise<NotesCounted>,
): Promise<{ notesCounted: NotesCounted; centsByPayment: Map<string, number> }> {
  // One snapshot: one reading is the database at one moment.
  return withReadOnlySnapshot(prisma, (tx) => readFailedCardRefundRecountCentsOnce(tx, payments, readNotesCounted));
}

/**
 * #4449: the same reads on a writer's own locked transaction (the kept settle,
 * the note sync's allocation write), never on a second connection beside it.
 * They reach bank-transfer payments too: a card capture an edit took on one
 * can be refunded, given its own note (#4312) and failed later.
 *
 * That transaction runs at READ COMMITTED, and a refund note's link write
 * takes no Payment row, so it can commit between these statements: the notes
 * counted without it and the cover above cash with it would take a failure off
 * that nothing counted. So the whole reading is taken again until two readings
 * in a row agree: a reading torn by a commit agrees with the one before or
 * after it only where the torn part gives the same answer on either side of
 * that commit. At most `IN_TRANSACTION_READINGS` readings: past that it
 * throws, rolling the writer back, and its event is retried. The notes are
 * read in a fixed order, so two readings of the same rows compare equal.
 */
const IN_TRANSACTION_READINGS = 4;

export async function readFailedCardRefundRecountCentsIn<NotesCounted>(
  tx: Prisma.TransactionClient,
  payments: ReadonlyArray<{ id: string; bookingId: string; refundedAmountCents: number }>,
  readNotesCounted: (db: Prisma.TransactionClient) => Promise<NotesCounted>,
): Promise<{ notesCounted: NotesCounted; centsByPayment: Map<string, number> }> {
  let previous = await readFailedCardRefundRecountCentsOnce(tx, payments, readNotesCounted);
  for (let reading = 2; reading <= IN_TRANSACTION_READINGS; reading += 1) {
    const next = await readFailedCardRefundRecountCentsOnce(tx, payments, readNotesCounted);
    if (sameReading(previous, next)) return next;
    previous = next;
  }
  throw new Error(`Failed-later card refund reads kept changing inside the writer's transaction (#4449): ${payments.map((payment) => payment.id).join(", ")}`);
}

function sameReading(
  a: { notesCounted: unknown; centsByPayment: Map<string, number> },
  b: { notesCounted: unknown; centsByPayment: Map<string, number> },
): boolean {
  const cents = (map: Map<string, number>) => JSON.stringify([...map].sort(([x], [y]) => x.localeCompare(y)));
  return JSON.stringify(a.notesCounted) === JSON.stringify(b.notesCounted) && cents(a.centsByPayment) === cents(b.centsByPayment);
}

async function readFailedCardRefundRecountCentsOnce<NotesCounted>(
  tx: Prisma.TransactionClient,
  payments: ReadonlyArray<{ id: string; bookingId: string; refundedAmountCents: number }>,
  readNotesCounted: (db: Prisma.TransactionClient) => Promise<NotesCounted>,
): Promise<{ notesCounted: NotesCounted; centsByPayment: Map<string, number> }> {
  const paymentIds = payments.map((payment) => payment.id);
  // Sequential: one transaction's connection runs one statement at a time.
  // The caller's notes first, on the same client every read below shares.
  const notesCounted = await readNotesCounted(tx);
  const centsByPayment = new Map<string, number>();
  if (payments.length === 0) return { notesCounted, centsByPayment };
  const liveReversalCents = await readCardRefundReversalCentsByPayment(paymentIds, tx, "live");
  const raisedReversalCents = await readCardRefundReversalCentsByPayment(paymentIds, tx, "raised");
  const failedLaterCents = await readFailedLaterCardRefundCentsByPayment(paymentIds, tx);
  for (const payment of payments) {
    const unreversedCents = Math.max(0, (failedLaterCents.get(payment.id) ?? 0) - (raisedReversalCents.get(payment.id) ?? 0));
    const aboveCashCents = unreversedCents > 0 ? await readRefundNoteCoverageAboveCashCents(payment, tx) : 0;
    const failureRecordCents = aboveCashCents === null ? unreversedCents : Math.min(unreversedCents, Math.max(0, aboveCashCents));
    const cents = (liveReversalCents.get(payment.id) ?? 0) + failureRecordCents;
    if (cents > 0) centsByPayment.set(payment.id, cents);
  }
  return { notesCounted, centsByPayment };
}

/**
 * The cents of each payment's card refunds Stripe failed after they counted,
 * each refund once however many rows or slices record it. A refund Stripe
 * refused outright never counted, took no note, and is not recorded here.
 */
async function readFailedLaterCardRefundCentsByPayment(paymentIds: readonly string[], db: Prisma.TransactionClient): Promise<Map<string, number>> {
  const centsByPayment = new Map<string, number>();
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId: { in: [...paymentIds] }, ...CARD_REFUND_OPERATION_WHERE },
    select: { paymentId: true, idempotencyKey: true, allocationPlan: true },
  });
  const failedRefundIds = new Set<string>();
  for (const operation of operations) {
    // A failed-later row's own refund, read from its key: its slices name it too where it
    // has a plan, and the Set keeps it once; a row with no readable plan has only its key.
    const ownRefundId = cardRefundFailedLaterRefundId(operation.idempotencyKey);
    if (ownRefundId) failedRefundIds.add(ownRefundId);
    for (const slice of parseRefundAllocationPlan(operation.allocationPlan) ?? []) {
      for (const refundId of cardRefundSliceFailedRefundIds(operation, slice)) failedRefundIds.add(refundId);
    }
  }
  if (failedRefundIds.size === 0) return centsByPayment;
  // `stripeRefundId` is unique, so each failed refund is summed once, on its own payment.
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId: { in: [...paymentIds] }, stripeRefundId: { in: [...failedRefundIds] }, status: { in: EXCLUDED_LEDGER_REFUND_STATUSES } },
    select: { paymentId: true, amountCents: true },
  });
  for (const refund of refunds) {
    if (refund.amountCents > 0) centsByPayment.set(refund.paymentId, (centsByPayment.get(refund.paymentId) ?? 0) + refund.amountCents);
  }
  return centsByPayment;
}
