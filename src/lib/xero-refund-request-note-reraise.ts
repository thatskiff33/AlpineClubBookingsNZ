/**
 * #4214 (owner decision, 17 Oct 2026): THE OFFICER RE-RAISES A REFUND
 * REQUEST'S OWN XERO CREDIT NOTE THAT XERO VOIDED.
 *
 * A refund request's own note (`INV-PAY-118`) that Xero records VOIDED or
 * DELETED stops covering the request (#4195, `INV-ADDPAY-041`), and nothing
 * raises a replacement automatically: every retry door refuses
 * (`isRetryOfVoidedRefundRequestNote`), because the officer voided it for a
 * reason. Xero Operations lists each such request, whatever its rows' states
 * (SUCCEEDED, PARTIAL, a FAILED row that names its note, a stale FAILED row),
 * and this module's `reraiseVoidedRefundRequestNote` is the ONE path that
 * queues a fresh note for it.
 *
 * The re-raise queues the request's note row through the shared builder
 * (`refundRequestCreditNoteQueuedRow`) under the after-void key
 * (`refundNoteKeyAfterVoidParts`), for the amount the voided note recorded,
 * and the outbox raises it as it raises any request's note. It writes no money
 * column; the refund itself never moved when the note was voided.
 *
 * Two officers can never queue two notes: the transaction locks the request's
 * own note links (`SELECT 1 … FOR UPDATE`, the row the inbound void and
 * `keepStoredRequestNoteVoid` lock), re-reads them under that lock, and
 * refuses while a live note exists or any of the request's note rows is still
 * active. See docs/CONCURRENCY_AND_LOCKING.md -> "Re-raising a voided
 * refund-request note (#4214)".
 */
import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { readRefundRequestIdFromOperation, readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { refundRequestCreditNoteQueuedRow } from "@/lib/xero-refund-request-credit-note-outbox";
import {
  isRefundCreditNoteLinkCancelledInXero,
  isRetryOfVoidedRefundRequestNote,
  readRefundCreditNoteLinkStatus,
  recordedRefundNoteFigure,
  refundNoteKeyAfterVoidParts,
  refundRequestOwnNotes,
} from "@/lib/xero-refund-note-status";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import { startXeroSyncOperation } from "@/lib/xero-sync";

/** The outbox statuses a row is still in flight under (the active-correlation index's set). */
const ACTIVE_ROW_STATUSES = new Set(["PENDING", "RUNNING", "WAITING_PAYMENT"]);

/** One refund request whose own note Xero voided, with no live note replacing it. */
export interface VoidedRefundRequestNote {
  paymentId: string;
  bookingId: string | null;
  refundRequestId: string;
  voidedNotes: Array<{ xeroObjectId: string; xeroObjectNumber: string | null; status: string | null }>;
  /** What the voided note recorded; null when it cannot be read, and then nothing is re-raised. */
  amountCents: number | null;
  /** The request's note row still in flight (a re-raise already queued), if any. */
  activeOperationId: string | null;
}

export class RefundRequestNoteReraiseError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "RefundRequestNoteReraiseError";
    this.status = status;
  }
}

type Reader = Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">;

/**
 * The amount every voided note of the request recorded, or null when one
 * cannot be read or two disagree (fail closed: an officer raises it by hand).
 */
async function voidedNotesAmountCents(paymentId: string, voidedIds: readonly string[], db: Reader): Promise<number | null> {
  const links = await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: REFUND_REQUEST_CREDIT_NOTE_ROLE, xeroObjectId: { in: [...voidedIds] } },
    select: { xeroObjectId: true, metadata: true },
  });
  const figures = new Set<number | null>();
  for (const link of links) figures.add(await recordedRefundNoteFigure(paymentId, link, "amountCents", db));
  const [only] = [...figures];
  return figures.size === 1 && typeof only === "number" && Number.isInteger(only) && only > 0 ? only : null;
}

/** The request's own outbound note-create rows on the payment, read from payload or key. */
async function requestNoteRows(paymentId: string, refundRequestId: string, db: Reader) {
  const rows = (await db.xeroSyncOperation.findMany({
    where: { direction: "OUTBOUND", localModel: "Payment", localId: paymentId, entityType: "CREDIT_NOTE", operationType: "CREATE" },
    select: { id: true, status: true, requestPayload: true, correlationKey: true, idempotencyKey: true, manuallyResolvedAt: true },
    orderBy: { createdAt: "asc" },
  })) ?? [];
  return rows.filter((row) => readRefundRequestIdFromOperation(row) === refundRequestId);
}

/**
 * Every refund request whose own note Xero voided with no live note of its own
 * replacing it (`refundRequestOwnNotes`), for Xero Operations. Read-only.
 */
export async function listVoidedRefundRequestNotes(db: Reader & Pick<Prisma.TransactionClient, "payment"> = prisma): Promise<VoidedRefundRequestNote[]> {
  const links = (await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", xeroObjectType: "CREDIT_NOTE", role: REFUND_REQUEST_CREDIT_NOTE_ROLE },
    select: { localId: true, xeroObjectId: true, xeroObjectNumber: true, metadata: true },
    orderBy: [{ localId: "asc" }, { xeroObjectId: "asc" }],
  })) ?? [];
  const groups = new Map<string, { paymentId: string; refundRequestId: string }>();
  for (const link of links) {
    const refundRequestId = readRefundRequestIdFromPayload(link.metadata);
    if (!refundRequestId || !isRefundCreditNoteLinkCancelledInXero(link.metadata)) continue;
    groups.set(JSON.stringify([link.localId, refundRequestId]), { paymentId: link.localId, refundRequestId });
  }
  const result: VoidedRefundRequestNote[] = [];
  for (const { paymentId, refundRequestId } of groups.values()) {
    const { live, cancelledIds } = await refundRequestOwnNotes(paymentId, refundRequestId, db);
    if (live || cancelledIds.length === 0) continue;
    const voided = new Set(cancelledIds);
    const rows = await requestNoteRows(paymentId, refundRequestId, db);
    const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
    result.push({
      paymentId,
      bookingId: payment?.bookingId ?? null,
      refundRequestId,
      voidedNotes: links
        .filter((link) => link.localId === paymentId && voided.has(link.xeroObjectId))
        .map((link) => ({ xeroObjectId: link.xeroObjectId, xeroObjectNumber: link.xeroObjectNumber, status: readRefundCreditNoteLinkStatus(link.metadata) })),
      amountCents: await voidedNotesAmountCents(paymentId, cancelledIds, db),
      activeOperationId: rows.find((row) => ACTIVE_ROW_STATUSES.has(row.status))?.id ?? null,
    });
  }
  return result;
}

/**
 * #4214: queue a fresh note for a refund request whose own note Xero voided.
 * Refused (409) unless, under the request's link locks, the request has a
 * voided note, no live note, no note row still in flight, no row an officer
 * resolved by hand under the key it would use, and one readable amount. The
 * queued row and its audit entry commit together.
 */
export async function reraiseVoidedRefundRequestNote(params: {
  paymentId: string;
  refundRequestId: string;
  actingMemberId: string;
}): Promise<{ operationId: string; amountCents: number; correlationKey: string; voidedNoteIds: string[] }> {
  const { paymentId, refundRequestId, actingMemberId } = params;
  return prisma.$transaction(async (tx) => {
    // The request's own note links, in one fixed order: the rows the inbound
    // void and a status-less link write lock (#4195). Two officers queue here
    // one after the other, and the second reads what the first committed.
    await tx.$executeRaw`
      SELECT 1 FROM "XeroObjectLink"
      WHERE "localModel" = 'Payment' AND "localId" = ${paymentId} AND "xeroObjectType" = 'CREDIT_NOTE'
        AND "role" = ${REFUND_REQUEST_CREDIT_NOTE_ROLE} AND "metadata"->>'refundRequestId' = ${refundRequestId}
      ORDER BY "xeroObjectId"
      FOR UPDATE`;
    const { live, cancelledIds } = await refundRequestOwnNotes(paymentId, refundRequestId, tx);
    if (live) {
      throw new RefundRequestNoteReraiseError(
        `This refund request already has a live Xero credit note (${live.xeroObjectNumber ?? live.xeroObjectId}), so no fresh note is raised.`,
      );
    }
    if (cancelledIds.length === 0) {
      throw new RefundRequestNoteReraiseError("This refund request has no Xero credit note recorded as voided, so there is nothing to raise again.");
    }
    const rows = await requestNoteRows(paymentId, refundRequestId, tx);
    if (rows.some((row) => ACTIVE_ROW_STATUSES.has(row.status))) {
      throw new RefundRequestNoteReraiseError("A credit note for this refund request is already queued or being sent to Xero.");
    }
    const afterVoid = await refundNoteKeyAfterVoidParts(paymentId, { refundRequestId }, tx);
    const amountCents = await voidedNotesAmountCents(paymentId, cancelledIds, tx);
    if (amountCents === null) {
      throw new RefundRequestNoteReraiseError(
        "The voided note's amount cannot be read, so no fresh note is raised. Raise the replacement by hand in Xero.",
      );
    }
    const row = refundRequestCreditNoteQueuedRow({ paymentId, refundRequestId, amountCents, afterVoid, createdByMemberId: actingMemberId });
    // INV-INT-025: a resolution fences this key even if its recorded amount
    // is unreadable. The request reader also recognises keys without a payload.
    if (rows.some((previous) => isResolvedInXero(previous) &&
      (previous.correlationKey === row.correlationKey || previous.idempotencyKey === row.idempotencyKey))) {
      throw new RefundRequestNoteReraiseError("An officer resolved this refund request's fresh credit note by hand in Xero, so no new note is queued.");
    }
    const operation = await startXeroSyncOperation({ ...row, store: tx });
    await createAuditLog(
      {
        action: "xero.refund_request_note.reraised",
        category: "xero",
        memberId: actingMemberId,
        targetId: paymentId,
        entityType: "XeroSyncOperation",
        entityId: operation.id,
        details: JSON.stringify({ refundRequestId, paymentId, amountCents, voidedNoteIds: cancelledIds, correlationKey: row.correlationKey }),
      },
      tx,
    );
    return { operationId: operation.id, amountCents, correlationKey: row.correlationKey, voidedNoteIds: cancelledIds };
  });
}

/**
 * #4214: which of these outbox rows are a refund request's own note create
 * whose request's note Xero voided with nothing live replacing it
 * (`isRetryOfVoidedRefundRequestNote`), so Xero Operations shows the reason in
 * place of a Retry the door would refuse. One check per payment and request.
 */
export async function voidedRequestNoteOperationIds(
  operations: ReadonlyArray<Parameters<typeof isRetryOfVoidedRefundRequestNote>[0] & { id: string }>,
  db: Reader = prisma,
): Promise<Set<string>> {
  const verdicts = new Map<string, Promise<boolean>>();
  const ids = new Set<string>();
  for (const operation of operations) {
    const refundRequestId = readRefundRequestIdFromOperation(operation);
    if (!refundRequestId || operation.localModel !== "Payment" || operation.entityType !== "CREDIT_NOTE" || operation.operationType !== "CREATE") continue;
    const key = JSON.stringify([operation.localId, refundRequestId]);
    if (!verdicts.has(key)) verdicts.set(key, isRetryOfVoidedRefundRequestNote(operation, db));
    if (await verdicts.get(key)) ids.add(operation.id);
  }
  return ids;
}
