import "server-only";

import type { ManualRefundTaskKind, Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import type { SettlementDirectionValue } from "@/lib/stored-night-price-repair";

/**
 * What CLOSING a manual refund task records, and the one place that entry is
 * composed.
 *
 * Lifted out of `manual-refund-task-resolution.ts` (#3191) when that module -
 * the completion DOOR - crossed its size budget. The seam is a real one rather
 * than a line-count dodge, and it is the same seam that module already draws
 * twice: it validates, claims and returns, while WHERE the money goes lives in
 * `edit-financial-review-settlement.ts` and what a repaired night price does
 * lives in `stored-night-price-repair-store.ts`. This is the third of those -
 * what the closure SAYS about itself - and it is the one a reader auditing the
 * record needs to be able to check without reading the transaction around it.
 *
 * ONE ENTRY, DELIBERATELY, and there is a second entry it does NOT absorb.
 * #3191's stored-night-price record sits beside its own write in
 * `stored-night-price-repair-store.ts`, because it is a different act on a
 * different entity and it can happen on a DISMISSAL - whose entry below says in
 * as many words that nothing moved. Folding it in would put a price change
 * inside a row whose summary denies one.
 */
export async function recordManualRefundTaskClosureAudit({
  task,
  resolution,
  actingMemberId,
  note,
  settlement,
  settlementRoute,
  settlementDirection,
  store,
}: {
  task: {
    id: string;
    bookingId: string;
    paymentId: string | null;
    amountCents: number | null;
    raisedAmountCents: number | null;
    kind: ManualRefundTaskKind | null;
    booking: { memberId: string };
  };
  resolution: "completed" | "dismissed";
  actingMemberId: string;
  note: string | null;
  /** What this closure settled at, or null on a dismissal. */
  settlement: { amountCents: number; amended: boolean } | null;
  settlementRoute: EditReviewSettlementRoute | null;
  settlementDirection: SettlementDirectionValue;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await createAuditLog(
    {
      action:
        resolution === "completed"
          ? "booking-payment.manual-refund-task.complete"
          : "booking-payment.manual-refund-task.dismiss",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: task.booking.memberId,
      targetId: task.bookingId,
      entityType: "ManualRefundTask",
      entityId: task.id,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary:
        resolution === "completed"
          ? "Manual booking refund paid back by hand"
          : "Manual booking refund task dismissed",
      details: note,
      metadata: {
        taskId: task.id,
        bookingId: task.bookingId,
        paymentId: task.paymentId,
        // #3030: three amounts, not one, because "audited amendment" (owner
        // decision D2) is only auditable if the entry says what the figure was
        // before and after. `raisedAmountCents` is what the task was raised
        // with, `previousAmountCents` what it carried when this admin opened it,
        // and `amountCents` what it closed at.
        amountCents: settlement?.amountCents ?? null,
        previousAmountCents: task.amountCents,
        raisedAmountCents: task.raisedAmountCents,
        amountAmended: settlement?.amended ?? false,
        kind: task.kind,
        resolution,
        // #3032: WHICH settlement path this amount went down, and the anchor it
        // settled against. Without these the entry says an amount was closed but
        // not whether that meant a card refund, a ledger mirror of a hand-back,
        // or freshly minted account credit - three materially different claims
        // about the club's money.
        settlementRoute: settlementRoute?.kind ?? null,
        settlementBookingModificationId:
          settlementRoute && settlementRoute.kind !== "local-allocation"
            ? settlementRoute.bookingModificationId
            : null,
        // #3170: WHICH WAY, recorded beside the route. The route says how the
        // money travelled and the direction says who ended up with it, and
        // "additional-charge" is the only route where those two answers differ
        // from every entry written before this issue.
        settlementDirection: settlement ? settlementDirection : null,
      },
    },
    store,
  );
}
