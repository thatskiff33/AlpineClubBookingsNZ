import { createAuditLog } from "@/lib/audit";
import { releaseReservationByOperator } from "@/lib/member-money";
import type { BookingJournalContext } from "@/lib/member-money/doors";
import { prisma } from "@/lib/prisma";

/**
 * The OPERATOR release (#4516, Ledger M4c; plan section 8, the rollback rules): an owner releases one card refund
 * reservation nothing can answer, with its funding, and the release is audited in the same transaction. The owner
 * runs it from `pnpm run member-money:refund-reservations --release <id> --note "<why>"`; the context is resolved
 * before the transaction (`INV-LOCK-004`). No provider call.
 */
export async function releaseCardRefundReservationByOperator(context: BookingJournalContext,
  input: { reservationId: string; note: string }): Promise<{ bookingId: string; attemptKey: string; amountCents: number }> {
  return prisma.$transaction(async (tx) => {
    const result = await releaseReservationByOperator(tx, context, { reservationId: input.reservationId });
    await createAuditLog({ category: "payment", action: "booking-payment.card-refund.reservation-released-by-operator", targetId: result.bookingId,
      entityType: "MemberMoneyRefundReservation", entityId: input.reservationId, severity: "critical", outcome: "success",
      summary: "An owner released a card refund reservation nothing could answer; its funding was reversed.", details: input.note,
      metadata: { attemptKey: result.attemptKey, amountCents: result.amountCents } }, tx);
    return result;
  });
}
