// #3635 (`INV-INT-025`): the enqueue-side fences for an operation an officer
// resolved in Xero. The retry machinery refuses a resolved ROW; these stop a
// fresh enqueue minting a new document beside the one the officer made by
// hand, because a new row does not carry the old row's mark.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { countsTowardRefundNoteCoverage, refundNoteIdSets } from "@/lib/xero-refund-note-status";
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
 * #4250 (`INV-INT-025`): nor does a resolved row whose note a link records
 * VOIDED or DELETED in Xero (`refundNoteIdSets(...).cancelled`). Xero no longer
 * holds that note, so it covers nothing - as a cancelled link counts nothing
 * in `sumCoveredRefundCreditNoteCents` - and its amount is never read, so an
 * unreadable one refuses nothing. Its id is still reported, but never its key:
 * the voided refund is raised again (owner decision, 21 Oct 2026), and the
 * re-raise's key can equal it when the note's executed watermark differs from
 * its queued one, so a key fence would refuse the re-raise every night.
 *
 * #4265 (owner decision 26 Oct 2026, `INV-INT-025`): nor does a row that is
 * no coverage of its own (`countsTowardRefundNoteCoverage`): a refund
 * request's note (`INV-PAY-118`), live or voided, or a row closed as covered
 * by another note. Its key and id are still reported, so the request's own
 * fence holds; its amount is never read, so an unreadable one refuses nothing.
 *
 * A resolved row whose amount cannot be read is reported in
 * `unreadableOperationIds`; callers must refuse loudly on it rather than guess.
 */
/**
 * #4421 (`INV-SSOT`, `INV-INT-028`): THE refund-note create rows the resolved
 * coverage reader reads - an outbound credit-note create on a payment, queued
 * as a refund note or with no recorded queue type (a legacy row, whose payload
 * says whether it was a refund or an account-credit note). One spelling for
 * this module's queries and for the "Resolve by hand" shape
 * (`refundNoteResolveShape`), so the rows a resolve asks a note number of are
 * exactly the rows whose resolve counts toward coverage.
 */
export const REFUND_NOTE_CREATE_ROW = {
  direction: "OUTBOUND",
  entityType: "CREDIT_NOTE",
  operationType: "CREATE",
  localModel: "Payment",
} as const;
export const REFUND_NOTE_CREATE_QUEUE_TYPES = [XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, null] as const;

/** The same population, asked of a row already read. */
export function isRefundNoteCreateRow(row: {
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  queueType: string | null;
}): boolean {
  return (
    (Object.keys(REFUND_NOTE_CREATE_ROW) as Array<keyof typeof REFUND_NOTE_CREATE_ROW>).every((key) => row[key] === REFUND_NOTE_CREATE_ROW[key]) &&
    (REFUND_NOTE_CREATE_QUEUE_TYPES as readonly (string | null)[]).includes(row.queueType)
  );
}

export interface ResolvedRefundCreditNoteCoverage {
  coveredCents: number;
  correlationKeys: string[];
  operationIds: string[];
  unreadableOperationIds: string[];
}

export async function readResolvedRefundCreditNoteCoverage(
  paymentId: string,
  db: CoverageReader = prisma,
  /** #3924 round 8: only these rows - one refund's own (`sumRefundCreditNoteCoverageOfRowsCents`). */
  rowsWhere?: Prisma.XeroSyncOperationWhereInput,
): Promise<ResolvedRefundCreditNoteCoverage> {
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      ...REFUND_NOTE_CREATE_ROW,
      localId: paymentId,
      manuallyResolvedAt: { not: null },
      // A legacy row with no recorded queue type is read too; its payload
      // says whether it was a refund or an account-credit note.
      OR: REFUND_NOTE_CREATE_QUEUE_TYPES.map((queueType) => ({ queueType })),
      ...(rowsWhere ? { AND: [rowsWhere] } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, correlationKey: true, idempotencyKey: true, requestPayload: true, responsePayload: true, xeroObjectId: true },
  });
  const noteIds = [...new Set((rows ?? []).flatMap((row) => (row.xeroObjectId ? [row.xeroObjectId] : [])))];
  // #4250 review (concurrency F1): which notes are live and which Xero voided,
  // from ONE read of the payment's refund-note links.
  const links = noteIds.length > 0 ? await refundNoteIdSets(paymentId, db) : null;
  const coverage: ResolvedRefundCreditNoteCoverage = {
    coveredCents: 0,
    correlationKeys: [],
    operationIds: [],
    unreadableOperationIds: [],
  };
  // `operationIds[i]` is the row of `correlationKeys[i]`; rows with no key reported follow.
  const unkeyedOperationIds: string[] = [];
  const report = (row: { id: string; correlationKey: string | null }) => {
    if (row.correlationKey) {
      coverage.operationIds.push(row.id);
      coverage.correlationKeys.push(row.correlationKey);
    } else {
      unkeyedOperationIds.push(row.id);
    }
  };
  for (const row of rows ?? []) {
    const recorded = parsePaymentCreditNoteRetryInput(row);
    if (row.xeroObjectId && links?.cancelled.has(row.xeroObjectId)) {
      if (recorded && recorded.kind !== "refund") continue;
      // #4250 review (money P2): no key - a re-raise's key can equal it.
      unkeyedOperationIds.push(row.id);
      continue;
    }
    // #4265: a refund request's note, or a row closed as covered by another
    // note, covers nothing here; the fences still see its key.
    if (!countsTowardRefundNoteCoverage(row)) {
      if (!recorded || recorded.kind === "refund") report(row);
      continue;
    }
    if (!recorded) {
      coverage.unreadableOperationIds.push(row.id);
      continue;
    }
    if (recorded.kind !== "refund") continue;
    if (!row.xeroObjectId || !links?.active.has(row.xeroObjectId)) {
      coverage.coveredCents += recorded.amountCents;
    }
    report(row);
  }
  coverage.operationIds.push(...unkeyedOperationIds);
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
 * #3924 round 8 (money review, `INV-PAY-122`): THE SAME COVERAGE, ASKED OF ONE
 * REFUND'S OWN NOTE ROWS - the refund-note creates `rowsWhere` selects on this
 * payment (a "Paid another way" close's, `paidAnotherWayCloseNoteRowsWhere`).
 * Counted exactly as `sumRefundCreditNoteCoverageCents` counts the payment: the
 * active link of each note those rows raised, plus the recorded amount of a row
 * resolved by hand whose note has no link and was not voided in Xero (#4250).
 * #4265: only rows that count (`countsTowardRefundNoteCoverage`) - a row closed
 * as covered by another refund's note counts nothing of that note (#4258), nor
 * does a refund request's. So what those notes cover here is exactly their
 * share of the payment's coverage, never more and never less. A resolved row
 * whose amount cannot be read covers nothing, as there.
 */
export async function sumRefundCreditNoteCoverageOfRowsCents(
  paymentId: string,
  rowsWhere: Prisma.XeroSyncOperationWhereInput,
  db: CoverageReader = prisma,
): Promise<number> {
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      ...REFUND_NOTE_CREATE_ROW,
      localId: paymentId,
      AND: [rowsWhere],
    },
    select: { xeroObjectId: true, correlationKey: true, idempotencyKey: true, requestPayload: true, responsePayload: true },
  });
  const noteIds = [
    ...new Set((rows ?? []).flatMap((row) => (row.xeroObjectId && countsTowardRefundNoteCoverage(row) ? [row.xeroObjectId] : []))),
  ];
  const linkedCents = await sumCoveredRefundCreditNoteCents(paymentId, db, noteIds);
  const resolved = await readResolvedRefundCreditNoteCoverage(paymentId, db, rowsWhere);
  return linkedCents + resolved.coveredCents;
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
 * #3635 round 4 (`INV-INT-025`): the response of a copy closed CANCELLED
 * because an officer resolved a sibling for the same document after it was
 * queued - by the outbox at its claim, or by a refund-note create once the
 * fence its sibling held reads lifted (#4692 review).
 */
export function resolvedSiblingCopySkippedPayload(resolvedOperationId: string) {
  return {
    skipped: "resolved-in-xero",
    resolvedOperationId,
    reason: "An officer resolved this document by hand in Xero after this copy was queued, so it was not sent.",
  } as const;
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
