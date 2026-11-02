// #4421 (owner decision 26 Oct 2026, `INV-INT-028`): "RESOLVE BY HAND" ON A
// PAYMENT REFUND CREDIT-NOTE CREATE RECORDS THE NOTE THE OFFICER MADE.
//
// A FAILED refund-note create that names no note of its own is resolved only
// with the number of the credit note the officer made in Xero. The note is
// checked in Xero by the #4162 hand-made answer's own check
// (`verifyHandMadeRefundNote`) - live, a sales credit note for the payment's
// contact and exactly the row's refund amount - OUTSIDE any transaction, and
// then recorded with the resolve, under `lock(1)` and the Payment row: on the
// row (its id and number) and as the payment's tracked refund-note link
// (`writeHandMadeRefundNoteLink`, the answer's own writer), unless another
// create row or any link here already records it: one note, one refund. With
// the link, the inbound sync marks the note voided if Xero voids it, and every
// coverage reader counts it once.
//
// Refund-request notes (#4391) and every other row resolve exactly as before.
import type { Prisma } from "@prisma/client";

import {
  readPaymentHandMadeNoteExpectation,
  RESOLVED_OPERATION_LINK_KEY,
  verifyHandMadeRefundNote,
  writeHandMadeRefundNoteLink,
  type VerifiedHandMadeRefundNote,
} from "@/lib/bank-refund-void-answer";
import {
  alreadyResolvedWithNoteMessage,
  handMadeNoteAlreadyRecordedMessage,
  RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE,
  RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE,
  RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE,
  RESOLVE_NOTE_RETRY_RAN_MESSAGE,
  RESOLVE_NOTE_SUPERSEDED_MESSAGE,
  RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE,
} from "@/lib/bank-refund-void-follow-up-copy";
import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import type { ClubFormat } from "@/lib/club-format";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import {
  findQueuedLiveCopy,
  findRetryOverlappingMark,
  findRetryRunningOrSince,
  findSupersedingRefundNoteRun,
  QUEUED_LIVE_COPY_REFUSAL,
  retryRunningRefusal,
} from "@/lib/xero-operation-resolve-guards";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { countsTowardRefundNoteCoverage, creditNoteCreateRowsRecordingWhere, refundNoteIdSets } from "@/lib/xero-refund-note-status";
import { stampedUnrecordedNoteId } from "@/lib/xero-refund-note-in-flight";
import { isRefundNoteCreateRow } from "@/lib/xero-resolved-in-xero-fences";

/** The fields of an operation row the shape below reads. */
export type RefundNoteResolveRow = {
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  status: string;
  queueType: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  correlationKey: string | null;
  idempotencyKey: string | null;
  xeroObjectId: string | null;
};

/**
 * What "Resolve by hand" asks of a row:
 * - `other`: not a payment refund-note create that counts as its own refund's
 *   note - another entity, an account-credit note, a refund request's note
 *   (#4391), a row closed as covered by another note - or neither FAILED nor
 *   PARTIAL (the route refuses those anyway). Resolved as before.
 * - `records-note`: the row already names its note (a PARTIAL row, say).
 *   Resolved as before; that note is already on record.
 * - `refused`: a refund-note row naming no note that cannot be resolved here -
 *   a PARTIAL one (review round 2: it would count as covered with no note on
 *   record), or a FAILED one whose amount cannot be read (no note can be
 *   checked against it; Mark non-replayable stops it re-running).
 * - `asks-number`: the number of the note the officer made is required.
 *
 * The population is the coverage reader's (`isRefundNoteCreateRow`, built from
 * the constants `readResolvedRefundCreditNoteCoverage` queries with), read by
 * `parsePaymentCreditNoteRetryInput` and `countsTowardRefundNoteCoverage`, so
 * the row this asks a number of is exactly a row whose resolve counts toward
 * the payment's refund-note coverage. FAILED only (review, money F7).
 *
 * A row a later run already superseded is refused too, but that needs a read
 * (`findSupersedingRefundNoteRun`), so the route and the claim ask it, and the
 * list passes its answer in (`resolveCreditNotePrompt`).
 */
export type RefundNoteResolveShape =
  | { kind: "other" }
  | { kind: "records-note" }
  | { kind: "refused"; paymentId: string; message: string }
  | { kind: "asks-number"; paymentId: string; amountCents: number; creditsInvoiceId?: string };

export function refundNoteResolveShape(row: RefundNoteResolveRow): RefundNoteResolveShape {
  if (!isRefundNoteCreateRow(row) || !row.localId || !countsTowardRefundNoteCoverage(row)) {
    return { kind: "other" };
  }
  const recorded = parsePaymentCreditNoteRetryInput(row);
  if (recorded && recorded.kind !== "refund") return { kind: "other" };
  if (row.xeroObjectId) return { kind: "records-note" };
  if (row.status === "PARTIAL") return { kind: "refused", paymentId: row.localId, message: RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE };
  if (row.status !== "FAILED") return { kind: "other" };
  if (!recorded) return { kind: "refused", paymentId: row.localId, message: RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE };
  return {
    kind: "asks-number",
    paymentId: row.localId,
    amountCents: recorded.amountCents,
    ...(recorded.creditsInvoiceId ? { creditsInvoiceId: recorded.creditsInvoiceId } : {}),
  };
}

/**
 * What the Xero operations panel needs before an officer presses Resolve on a
 * row: whether it asks for the note's number and for what amount (review,
 * money F6), or why it will be refused (review, money F2) - including a row a
 * later run superseded, which the list reads for the page
 * (`findSupersededRefundNoteRowIds`) and passes in.
 */
export function resolveCreditNotePrompt(
  row: RefundNoteResolveRow,
  superseded = false,
): {
  resolveAsksCreditNoteNumber: boolean;
  resolveCreditNoteAmountCents: number | null;
  resolveRefusal: string | null;
} {
  const shape = refundNoteResolveShape(row);
  if (shape.kind === "asks-number" && superseded) {
    return { resolveAsksCreditNoteNumber: false, resolveCreditNoteAmountCents: null, resolveRefusal: RESOLVE_NOTE_SUPERSEDED_MESSAGE };
  }
  return {
    resolveAsksCreditNoteNumber: shape.kind === "asks-number",
    resolveCreditNoteAmountCents: shape.kind === "asks-number" ? shape.amountCents : null,
    resolveRefusal: shape.kind === "refused" ? shape.message : null,
  };
}

/**
 * Before any transaction: check the officer's note in Xero against the row's
 * own refund amount and the payment's contact. A provider call, so no lock is
 * held across it; the claim below re-checks under its locks what the database
 * can change. Refuses (400/409) with a message the officer reads.
 */
export async function verifyResolvedRefundNote(input: {
  shape: Extract<RefundNoteResolveShape, { kind: "asks-number" }>;
  creditNoteNumber: string;
  format: ClubFormat;
}): Promise<VerifiedHandMadeRefundNote> {
  const target = await readPaymentHandMadeNoteExpectation(input.shape.paymentId, input.shape.creditsInvoiceId);
  if (!target) {
    throw new ManualBookingPaymentError("The payment this refund credit note belongs to no longer exists, so there is nothing to check the note against.", 409);
  }
  return verifyHandMadeRefundNote({
    creditNoteNumber: input.creditNoteNumber,
    expectedAmountCents: input.shape.amountCents,
    ...target,
    format: input.format,
  });
}

/** The payment's refund-note link a resolve of `operationId` wrote for `creditNoteId` (`writeHandMadeRefundNoteLink`). */
function linkThisResolveWrote(operationId: string, paymentId: string, creditNoteId: string) {
  return {
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNoteId,
    role: "REFUND_CREDIT_NOTE",
    metadata: { path: [RESOLVED_OPERATION_LINK_KEY], equals: operationId },
  } satisfies Prisma.XeroObjectLinkWhereInput;
}

export type ResolveRecordingClaim = { outcome: "claimed"; resolvedAt: Date } | { outcome: "lost" };

/**
 * THE CLAIM, in one transaction, in the #4162 follow-up's order: `lock(1)`
 * FIRST - the key the hand-made answer's completion (`resolveManualRefundTask`)
 * holds for its whole transaction - then the payment's row
 * (`lockPaymentForRefundedTotal`), then the reads, then the row's
 * status-guarded claim, and the link row last (through the link funnel). So of
 * a resolve and an answer offering the same note, whichever commits second
 * sees the first and refuses: the note is recorded once.
 *
 * Under the locks: the row is re-read (still FAILED, unresolved, naming no
 * note, its amount the note's); no retry of it ran since `readAt`, when the
 * route read it (review, concurrency F1); no other create row and no link
 * records the note - except the link THIS row wrote and a withdrawal retired,
 * which the claim takes back. The mark's instant is taken here, after the
 * lock. Returns `lost` when the row changed (nothing is written then); a 409
 * refusal rolls back everything, the claim included.
 */
export async function claimResolveRecordingRefundNote(input: {
  operationId: string;
  paymentId: string;
  note: VerifiedHandMadeRefundNote;
  readAt: Date;
  reason: string;
  resolvedById: string;
}): Promise<ResolveRecordingClaim> {
  return prisma.$transaction(
    async (tx): Promise<ResolveRecordingClaim> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, input.paymentId);
      const row = await tx.xeroSyncOperation.findUnique({ where: { id: input.operationId }, select: RESOLVE_ROW_SELECT });
      const shape = row ? refundNoteResolveShape(row) : null;
      if (!row || shape?.kind !== "asks-number" || shape.paymentId !== input.paymentId || row.manuallyResolvedAt) {
        return { outcome: "lost" };
      }
      if (shape.amountCents !== input.note.amountCents) {
        throw new ManualBookingPaymentError("This refund credit note's amount changed while you were resolving it. Reload it and check before resolving.", 409);
      }
      // Review round 2: a run that already raised this row's note, at any
      // time - asked first, as the most specific answer - then a retry that
      // ran or is running since the route read the row, then a live copy a
      // self-heal queued since the route's check, all re-read under the locks.
      if (await findSupersedingRefundNoteRun({ id: input.operationId, correlationKey: row.correlationKey, localId: row.localId }, tx)) {
        throw new ManualBookingPaymentError(RESOLVE_NOTE_SUPERSEDED_MESSAGE, 409);
      }
      if (await findRetryRunningOrSince(input.operationId, input.readAt, tx)) {
        throw new ManualBookingPaymentError(RESOLVE_NOTE_RETRY_RAN_MESSAGE, 409);
      }
      if (await findQueuedLiveCopy({ id: input.operationId, ...row }, tx)) {
        throw new ManualBookingPaymentError(QUEUED_LIVE_COPY_REFUSAL, 409);
      }
      // One after the other on the interactive transaction (#1357).
      const recordedByRow = await tx.xeroSyncOperation.findFirst({
        where: { ...creditNoteCreateRowsRecordingWhere(input.note.creditNoteId), id: { not: input.operationId } },
        select: { id: true },
      });
      const links = await tx.xeroObjectLink.findMany({
        where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: input.note.creditNoteId },
        select: { localModel: true, localId: true, role: true, active: true, metadata: true },
      });
      // The link this row wrote and a withdrawal retired is this row's own,
      // taken back below; any other link records the note for something else.
      const ownWithdrawn = (link: (typeof links)[number]) =>
        link.localModel === "Payment" &&
        link.localId === input.paymentId &&
        link.role === "REFUND_CREDIT_NOTE" &&
        !link.active &&
        asRecord(link.metadata)?.[RESOLVED_OPERATION_LINK_KEY] === input.operationId;
      // #4692 review (F4, `INV-INT-035`): the note this row's own stamp names, already linked live on the
      // payment through another row (the original a retry ran for, resolved with it): recorded on this row
      // too, with no second link, so it covers nothing twice - else the row could never be resolved.
      const ownNoteLinkedHere =
        stampedUnrecordedNoteId(row) === input.note.creditNoteId &&
        (await refundNoteIdSets(input.paymentId, tx)).active.has(input.note.creditNoteId);
      if (!ownNoteLinkedHere && (recordedByRow || !links.every(ownWithdrawn))) {
        throw new ManualBookingPaymentError(handMadeNoteAlreadyRecordedMessage(input.note.creditNoteNumber), 409);
      }
      const resolvedAt = new Date();
      const claimed = await tx.xeroSyncOperation.updateMany({
        where: {
          id: input.operationId,
          status: "FAILED",
          manuallyResolvedAt: null,
          xeroObjectId: null,
        },
        data: {
          manuallyResolvedAt: resolvedAt,
          manuallyResolvedReason: input.reason,
          manuallyResolvedById: input.resolvedById,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: input.note.creditNoteId,
          xeroObjectNumber: input.note.creditNoteNumber,
        },
      });
      if (claimed.count !== 1) return { outcome: "lost" };
      if (ownNoteLinkedHere) return { outcome: "claimed", resolvedAt };
      await writeHandMadeRefundNoteLink(tx, {
        paymentId: input.paymentId,
        note: input.note,
        records: { resolvedOperationId: input.operationId },
        refusals: {
          voided: `Credit note ${input.note.creditNoteNumber} was voided in Xero while it was being recorded, so nothing was recorded. A voided note cannot record a refund: make a new credit note in Xero and resolve with its number.`,
          changed: `Credit note ${input.note.creditNoteNumber} changed in Xero while it was being recorded, so nothing was recorded. Reload and try again.`,
        },
      });
      return { outcome: "claimed", resolvedAt };
    },
    { timeout: 30_000 },
  );
}

/**
 * Withdraw a resolve that recorded a note, when a retry turned out to be
 * running beside it (`findRetryOverlappingMark`): the mark, the note on the
 * row and the link it wrote go together, under the claim's own locks
 * (`lock(1)`, then the Payment row, the link last), guarded on this mark and
 * this note, so nothing a later writer put there is cleared. The link is
 * retired (inactive), not deleted; a later resolve of this row with the same
 * note takes it back.
 */
export async function withdrawResolveRecordingRefundNote(input: {
  operationId: string;
  paymentId: string;
  resolvedAt: Date;
  creditNoteId: string;
  previousXeroObjectType: string | null;
}): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, input.paymentId);
      const withdrawn = await tx.xeroSyncOperation.updateMany({
        where: { id: input.operationId, manuallyResolvedAt: input.resolvedAt, xeroObjectId: input.creditNoteId },
        data: {
          manuallyResolvedAt: null,
          manuallyResolvedReason: null,
          manuallyResolvedById: null,
          xeroObjectType: input.previousXeroObjectType,
          xeroObjectId: null,
          xeroObjectNumber: null,
        },
      });
      if (withdrawn.count !== 1) return;
      await tx.xeroObjectLink.updateMany({
        where: linkThisResolveWrote(input.operationId, input.paymentId, input.creditNoteId),
        data: { active: false },
      });
    },
    { timeout: 30_000 },
  );
}

const RESOLVE_ROW_SELECT = {
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  status: true,
  queueType: true,
  requestPayload: true,
  responsePayload: true,
  correlationKey: true,
  idempotencyKey: true,
  xeroObjectId: true,
  manuallyResolvedAt: true,
  // #4692 review: a row holding an unrecorded note is not refused over a copy that fence holds.
  lastErrorCode: true,
} satisfies Prisma.XeroSyncOperationSelect;

/** A refusal the resolve route answers, and audits where a number was offered or needed. */
export type ResolveRefusal = { status: number; message: string };

/**
 * #3635 review N5: a mark another officer just wrote may still be withdrawn
 * (it is checked against running retries after it is written), so "already
 * resolved" is answered only when the same check would keep it. #4421 review
 * (concurrency F6): an officer who offered a note is told which note the mark
 * recorded, and refused when it is not the one they offered.
 */
export async function answerExistingResolveMark(
  id: string,
  mark: { manuallyResolvedAt: Date; xeroObjectNumber: string | null },
  offeredNumber: string | undefined,
): Promise<{ refused: ResolveRefusal } | { message: string }> {
  const conflict = await findRetryOverlappingMark(id, mark.manuallyResolvedAt);
  if (conflict) return { refused: { status: 409, message: retryRunningRefusal(conflict) } };
  if (offeredNumber) {
    const message = alreadyResolvedWithNoteMessage(mark.xeroObjectNumber);
    return mark.xeroObjectNumber === offeredNumber ? { message } : { refused: { status: 409, message } };
  }
  return { message: "Xero operation was already resolved." };
}

/**
 * The resolve route's refund-note half (#4421), for a row that asks a number:
 * the number is required; a run that already raised the row's note refuses
 * before any Xero call (review round 2); then the note is checked in Xero
 * (`verifyResolvedRefundNote`, no transaction open) and claimed with the
 * resolve (`claimResolveRecordingRefundNote`). A refusal from either comes
 * back as such; a lost claim as `claimed: false`.
 */
export async function resolveRecordingRefundNote(input: {
  operation: { id: string; correlationKey: string | null; localId: string | null };
  shape: Extract<RefundNoteResolveShape, { kind: "asks-number" }>;
  offeredNumber: string | undefined;
  readAt: Date;
  reason: string;
  resolvedById: string;
}): Promise<{ refused: ResolveRefusal } | { claimed: false } | { claimed: true; note: VerifiedHandMadeRefundNote; resolvedAt: Date }> {
  if (!input.offeredNumber) return { refused: { status: 400, message: RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE } };
  if (await findSupersedingRefundNoteRun(input.operation)) {
    return { refused: { status: 409, message: RESOLVE_NOTE_SUPERSEDED_MESSAGE } };
  }
  try {
    const note = await verifyResolvedRefundNote({ shape: input.shape, creditNoteNumber: input.offeredNumber, format: await clubFormatValues() });
    const claim = await claimResolveRecordingRefundNote({
      operationId: input.operation.id,
      paymentId: input.shape.paymentId,
      note,
      readAt: input.readAt,
      reason: input.reason,
      resolvedById: input.resolvedById,
    });
    return claim.outcome === "claimed" ? { claimed: true, note, resolvedAt: claim.resolvedAt } : { claimed: false };
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) return { refused: { status: error.status, message: error.message } };
    throw error;
  }
}

/**
 * #4421 review (round 2): a mark that recorded a note, withdrawn because a
 * retry turned out to be running beside it. The withdrawal is audited (the
 * note was written and is now taken back). If it fails - its transaction takes
 * `lock(1)` and the Payment row - the mark and the live link stay committed
 * while a retry may raise its own note: the double-note case the withdrawal
 * exists to stop. So that failure raises a refund-ledger alert naming the
 * operation and the note, is audited, and the officer is told.
 */
export async function withdrawRecordedNoteOrAlert(input: {
  operationId: string;
  paymentId: string;
  resolvedAt: Date;
  note: VerifiedHandMadeRefundNote;
  previousXeroObjectType: string | null;
  retryRefusal: string;
  auditFailure: (summary: string, details: string, metadata: Record<string, unknown>) => Promise<unknown>;
}): Promise<ResolveRefusal> {
  const metadata = {
    operationId: input.operationId,
    creditNoteId: input.note.creditNoteId,
    creditNoteNumber: input.note.creditNoteNumber,
    amountCents: input.note.amountCents,
  };
  try {
    await withdrawResolveRecordingRefundNote({
      operationId: input.operationId,
      paymentId: input.paymentId,
      resolvedAt: input.resolvedAt,
      creditNoteId: input.note.creditNoteId,
      previousXeroObjectType: input.previousXeroObjectType,
    });
  } catch (error) {
    logger.error({ err: error, ...metadata }, "Could not withdraw a resolve that recorded a hand-made refund credit note while a retry runs (#4421)");
    await notifyXeroSyncError({
      errorType: "refund-ledger-divergence",
      operation: `xero-resolve-withdraw:${input.operationId}`,
      errorMessage: `Xero operation ${input.operationId} was marked resolved by hand, recording credit note ${input.note.creditNoteNumber}, while a retry of it was running, and the app could not take that mark back. The retry may raise its own credit note for the same refund: check Xero for two notes and void one.`,
    }).catch(() => undefined);
    await input.auditFailure("Resolve by hand recorded a credit note it could not withdraw while a retry ran", RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE, {
      ...metadata,
      result: "withdrawal failed: retry running",
      status: 500,
    });
    return { status: 500, message: RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE };
  }
  await input.auditFailure("Resolve by hand withdrawn: a retry was running", input.retryRefusal, {
    ...metadata,
    result: "withdrawn: retry running",
    status: 409,
  });
  return { status: 409, message: input.retryRefusal };
}
