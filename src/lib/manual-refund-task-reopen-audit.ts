import type { ManualRefundTaskKind, Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";

/**
 * What putting a DISMISSED money task back on the queue records, and the one
 * place that entry is composed (`INV-SSOT`). Two doors reopen a task: an
 * officer (`manual-refund-task-reopen.ts`, #3498) and the inbound Xero sync
 * when a later PAID event reaches a part-payment review whose covered cash is
 * not known (`part-payment-review-cover.ts`, #3643, `INV-PAY-109`). Both write
 * this entry, so "who undid which dismissal, and why" reads the same way
 * whoever did it; the sync's has no acting member.
 *
 * Not `server-only`, because the inbound sync also runs from scripts.
 */
export async function recordManualRefundTaskReopenAudit({
  task,
  subjectMemberId,
  actingMemberId,
  summary,
  details,
  extraMetadata = {},
  store,
}: {
  task: {
    id: string;
    bookingId: string;
    kind: ManualRefundTaskKind | null;
    amountCents: number | null;
    raisedAmountCents: number | null;
    completedByMemberId: string | null;
    completedAt: Date | null;
    note: string | null;
  };
  /** The booking OWNER, null when it is owned by an Organisation (#3369). */
  subjectMemberId: string | null;
  /** Null when the system reopened it, never an invented actor. */
  actingMemberId: string | null;
  summary: string;
  details: string;
  extraMetadata?: Record<string, string | number | null>;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await createAuditLog(
    {
      action: "booking-payment.manual-refund-task.reopen",
      ...(actingMemberId
        ? { memberId: actingMemberId, actorMemberId: actingMemberId }
        : {}),
      subjectMemberId,
      targetId: task.bookingId,
      entityType: "ManualRefundTask",
      entityId: task.id,
      category: "payment",
      // The same severity as the closure it undoes: it moves no money itself,
      // and it puts a money question back in front of the club.
      severity: "important",
      outcome: "success",
      summary,
      details,
      metadata: {
        taskId: task.id,
        bookingId: task.bookingId,
        kind: task.kind,
        amountCents: task.amountCents,
        raisedAmountCents: task.raisedAmountCents,
        // WHOSE decision was undone, and when they took it. Cleared from the
        // row by the reopen's claim, so this entry is the only place either
        // survives - which is the whole reason they are recorded here.
        dismissedByMemberId: task.completedByMemberId,
        dismissedAt: task.completedAt?.toISOString() ?? null,
        dismissalNote: task.note,
        ...extraMetadata,
      },
    },
    store,
  );
}
