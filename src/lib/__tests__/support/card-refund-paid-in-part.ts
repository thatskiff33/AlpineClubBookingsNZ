import type { Mock } from "vitest";

import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { buildBookingCancellationRefundIdempotencyKey, buildCardRefundStillOwedRecoveryKey } from "@/lib/payment-recovery-keys";

type Fake = Mock<(...args: any[]) => any>;

/** The Prisma reads `readCancelledCardRefund` makes, as a page test's fakes for them. */
export interface CardRefundReadFakes {
  /** `paymentRecoveryOperation.findMany` */
  rows: Fake;
  /** `paymentRecoveryOperation.findUnique` */
  row: Fake;
  /** `manualRefundTask.findFirst`: a row's "Paid another way" close record */
  closeRecord: Fake;
  /** `manualRefundTask.findUnique`: a record by its id */
  record: Fake;
  /** `payment.findMany` */
  payments: Fake;
}

/**
 * #4516 (round-3 review 1, `INV-PAY-122`): A MEMBER'S CARD CANCEL WHOSE REFUND DIED, PAID BACK IN PART "PAID ANOTHER
 * WAY" WITH THE REST STILL OWED - the cancel's row closed by a record for what was paid back, and the rest on a row
 * of its own keyed by that record (`card_refund_still_owed_<record>`), born dead. `restClosed`: a later close paid
 * that rest in full. Wired onto a page test's fakes, so the page's own readers find the rows the close writes.
 */
export function givenCardRefundPaidInPart(
  fakes: CardRefundReadFakes,
  { bookingId, refundCents, paidBackCents, restClosed }: { bookingId: string; refundCents: number; paidBackCents: number; restClosed: boolean },
): void {
  const dead = { attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null, allocationPlan: null, paymentId: "pay-1" };
  const cancel = { ...dead, id: "op-cancel", idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId), amountCents: refundCents, status: "SUCCEEDED", succeededAt: new Date("2026-06-20T00:00:00.000Z") };
  const rest = { ...dead, id: "op-rest", idempotencyKey: buildCardRefundStillOwedRecoveryKey("close-1"), amountCents: refundCents - paidBackCents, status: restClosed ? "SUCCEEDED" : "PENDING", succeededAt: null };
  fakes.rows.mockImplementation(async ({ where }: { where: { OR?: unknown; idempotencyKey?: unknown } }) =>
    where.OR ? [cancel] : JSON.stringify(where.idempotencyKey ?? "").includes("still_owed") ? [rest] : []);
  fakes.row.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === cancel.id ? cancel : null));
  fakes.closeRecord.mockImplementation(async ({ where }: { where: { occurrenceKey?: { in?: string[] } } }) => {
    const closes = (id: string) => where.occurrenceKey?.in?.some((key) => key.split(":")[1] === id) ?? false;
    if (closes(cancel.id)) return { amountCents: paidBackCents, raisedAmountCents: paidBackCents };
    return restClosed && closes(rest.id) ? { amountCents: rest.amountCents, raisedAmountCents: rest.amountCents } : null;
  });
  fakes.record.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id === "close-1" ? { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(cancel.id, { xeroRefundNote: "now" }) } : null);
  fakes.payments.mockResolvedValue([]);
}
