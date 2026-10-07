// #3635 (`INV-INT-025`): the enqueue-side fences for an operation an officer
// resolved in Xero. The retry machinery refuses a resolved ROW; these stop a
// fresh enqueue minting a new document beside the one the officer made by
// hand, because a new row does not carry the old row's mark.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { sumCoveredRefundCreditNoteCents } from "@/lib/xero-sync";

type OperationReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;
type CoverageReader = Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink">;

export interface ResolvedInXeroOperation {
  id: string;
  manuallyResolvedAt: Date;
}

function toResolved(
  row: { id: string; manuallyResolvedAt: Date | null } | null,
): ResolvedInXeroOperation | null {
  return row?.manuallyResolvedAt
    ? { id: row.id, manuallyResolvedAt: row.manuallyResolvedAt }
    : null;
}

/**
 * What the refund credit notes an officer raised by hand in Xero cover on this
 * payment (#3635 round 4, `INV-INT-025`). AMOUNT-based, never a per-payment
 * block: each resolved refund-note create counts its RECORDED amount as
 * covered - the note the officer made stands in for exactly that - so a later,
 * different refund on the same payment still gets its own note, and the
 * hand-made one is never covered twice. The amount is read by the one reader
 * the retry replays with (`parsePaymentCreditNoteRetryInput`).
 *
 * A resolved row whose own note has an active `REFUND_CREDIT_NOTE` link adds
 * nothing to `coveredCents` (#3548 round 3): the link already counts that note
 * in `sumRefundCreditNoteCoverageCents`. That is a crashed row (the note is
 * linked the moment Xero returns it) or a PARTIAL one, resolved by hand. Its
 * keys and id are still reported, so the fences still see it.
 *
 * A resolved row whose amount cannot be read is reported in
 * `unreadableOperationIds`; callers must refuse loudly on it rather than guess.
 */
export interface ResolvedRefundCreditNoteCoverage {
  coveredCents: number;
  correlationKeys: string[];
  operationIds: string[];
  unreadableOperationIds: string[];
}

export async function readResolvedRefundCreditNoteCoverage(
  paymentId: string,
  db: CoverageReader = prisma,
): Promise<ResolvedRefundCreditNoteCoverage> {
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      manuallyResolvedAt: { not: null },
      // A legacy row with no recorded queue type is read too; its payload
      // says whether it was a refund or an account-credit note.
      OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, correlationKey: true, requestPayload: true, xeroObjectId: true },
  });
  const noteIds = [...new Set((rows ?? []).flatMap((row) => (row.xeroObjectId ? [row.xeroObjectId] : [])))];
  const linkedNoteIds = new Set(
    noteIds.length > 0
      ? (
          await db.xeroObjectLink.findMany({
            where: {
              localModel: "Payment",
              localId: paymentId,
              xeroObjectType: "CREDIT_NOTE",
              role: "REFUND_CREDIT_NOTE",
              active: true,
              xeroObjectId: { in: noteIds },
            },
            select: { xeroObjectId: true },
          })
        ).map((link) => link.xeroObjectId)
      : [],
  );
  const coverage: ResolvedRefundCreditNoteCoverage = {
    coveredCents: 0,
    correlationKeys: [],
    operationIds: [],
    unreadableOperationIds: [],
  };
  for (const row of rows ?? []) {
    const recorded = parsePaymentCreditNoteRetryInput(row);
    if (!recorded) {
      coverage.unreadableOperationIds.push(row.id);
      continue;
    }
    if (recorded.kind !== "refund") continue;
    if (!row.xeroObjectId || !linkedNoteIds.has(row.xeroObjectId)) {
      coverage.coveredCents += recorded.amountCents;
    }
    coverage.operationIds.push(row.id);
    if (row.correlationKey) coverage.correlationKeys.push(row.correlationKey);
  }
  return coverage;
}

/**
 * The one answer to "how much of this payment's cash refund do refund credit
 * notes already cover" (#3635, `INV-INT-025`): the active refund-note links
 * plus the recorded amounts of notes an officer resolved by hand in Xero. The
 * enqueue's cap, the credit note's execution-time cap and the refund-gap reader
 * all read it, so the note a kept late capture's refund queues
 * (`creditBackLateCaptureRefunds`) and the gap the self-heal list reports agree.
 * The resolved coverage is a REQUIRED argument, read first by the caller, which
 * must refuse on its `unreadableOperationIds` before trusting this sum.
 */
export async function sumRefundCreditNoteCoverageCents(
  paymentId: string,
  resolved: ResolvedRefundCreditNoteCoverage,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  return (await sumCoveredRefundCreditNoteCents(paymentId, db)) + resolved.coveredCents;
}

/**
 * The payment's LATEST booking-invoice create, when an officer resolved it in
 * Xero; null otherwise. The latest, not any: a newer create means someone chose
 * to raise the invoice again (the force-sync override), and a resolved row never
 * outranks a live one.
 */
export async function findResolvedBookingInvoiceCreate(
  paymentId: string,
  db: OperationReader = prisma,
): Promise<ResolvedInXeroOperation | null> {
  const row = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, manuallyResolvedAt: true },
  });
  return toResolved(row);
}

/**
 * #3635 round 4 (review N3): a queued copy of a document is stale when an
 * officer resolved a sibling for the SAME document (same correlation key)
 * after this copy was queued - the sibling's hand-made document now stands for
 * it. The outbox checks this after it claims a row and before any Xero call. A
 * copy queued AFTER the resolve (a force-sync override, or a later delta with
 * its own key) is not stale.
 */
export async function findResolvedSiblingSince(
  operation: {
    id: string;
    correlationKey: string | null;
    entityType: string;
    operationType: string;
    createdAt: Date;
  },
  db: OperationReader = prisma,
): Promise<ResolvedInXeroOperation | null> {
  if (!operation.correlationKey) return null;
  const row = await db.xeroSyncOperation.findFirst({
    where: {
      id: { not: operation.id },
      correlationKey: operation.correlationKey,
      entityType: operation.entityType,
      operationType: operation.operationType,
      manuallyResolvedAt: { gt: operation.createdAt },
    },
    select: { id: true, manuallyResolvedAt: true },
  });
  return toResolved(row);
}
