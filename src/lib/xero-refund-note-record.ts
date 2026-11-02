/**
 * #4426 (`INV-INT-029`, `INV-INT-028`, `INV-PAY-111`): the payment refund-note
 * create's record of the note Xero returned - the payment's pointer (when it
 * takes one), the row's note and the note's link - in one transaction, under
 * a claim.
 *
 * A create can stall in Xero past the stale threshold. Mark failed then fails
 * its row, and an officer may "Resolve by hand", recording the note they made
 * (#4421). The stalled run is still alive: when Xero answers, its note may be a
 * second note for the same refund. So the row's note is written by a
 * guarded `updateMany` that refuses only a row whose resolve RECORDED a
 * note (`manuallyResolvedAt` set and `xeroObjectId` set), before the link, and
 * a lost claim rolls the whole record back: no pointer, no link, the officer's
 * note left on the row. The late note is then logged, audited once (`xero`)
 * and surfaced to the officers through #4374's alert
 * (`traceUnrecordedLateNote`, shared with #4655's organiser note), never silently linked - unless it IS the note
 * the resolve recorded (Xero committed it and only its answer was lost, and the
 * officer found it), when nothing is wrong and only an info line is logged.
 *
 * Every other row is written as before. A plain resolve records no note, so
 * the late note lands there, links, settles and completes, and #4374's
 * completion alert tells the officers (`INV-INT-025`). A success lands on any
 * row no claim holds (`INV-INT-029`), so after a Mark failed with no resolve
 * the note is recorded on the FAILED row and the completion closes it
 * SUCCEEDED. The record writes no claim token: a refund-note CREATE row is
 * never handed back to PENDING in place (its retry runs on a REQUEUE row), so
 * a later claim holding the row RUNNING is unreachable here today.
 *
 * #4656: the record also asks, under its locks, that no other create row
 * records the note (`assertFreshRefundNoteFromCreate`, `INV-ADDPAY-041`). Asked
 * before the transaction, a second create answered with the same note (one
 * Xero key) or a resolve recording it could commit in between, and both rows
 * would name it. A refusal rolls the record back and fails the row, as before.
 * The transaction runs on the Payment row's budget
 * (`PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS`), not Prisma's 5s: a holder of that
 * row can keep it 30s. If the record still cannot get its locks in time
 * (`isRecordWaitLost`), the note Xero made is recorded nowhere: it is traced
 * and alerted as a late note is, and the row is NOT failed - it stays as it was
 * (RUNNING under this run's claim, or FAILED if Mark failed reached it first)
 * for an officer told to resolve it by hand with the note's number. Never to
 * retry it: a retry is sized and keyed on what the app records, which leaves
 * this note out, so Xero can answer it with a second note. The create then
 * throws `RefundNoteNotRecordedError`, so no caller reports the run a success.
 * A record that committed although its answer was an error is found by the
 * trace's re-read and carries on as recorded.
 *
 * Lock order: the Payment row, always (`lockPaymentForRefundedTotal`; #4656:
 * a note that takes no pointer too, so two records of one payment queue), then
 * the operation row (the claim), then the link - the order the resolve's claim
 * takes the same rows (`claimResolveRecordingRefundNote`: `lock(1)`, Payment,
 * the row, the link), so the two never wait on each other in a cycle.
 */
import type { Prisma, XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { isWriteConflictOrDeadlock } from "@/lib/additional-ask-reduction-error";
import { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { isPostgresLockNotAvailable, isTransactionContention } from "@/lib/prisma-errors";
import { traceUnrecordedLateNote, type LateNoteTrace } from "@/lib/xero-late-note-trace";
import { assertFreshRefundNoteFromCreate } from "@/lib/xero-refund-note-status";
import { describeUnrecordedObject } from "@/lib/xero-success-after-resolution-alert";
import { upsertXeroObjectLink } from "@/lib/xero-sync";

/** #4426: the audit action of a late refund note the create did not record. */
export const LATE_REFUND_NOTE_NOT_RECORDED_ACTION = "xero.refund_credit_note.late_note_not_recorded";

export interface CreatedRefundNote {
  paymentId: string;
  bookingId: string;
  operationId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The note's amount, as raised in Xero. */
  amountCents: number;
  /** The note's status as Xero answered it: a VOIDED or DELETED note is refused (`INV-ADDPAY-041`). */
  xeroStatus?: unknown;
  /** The payment's one canonical note: never a refund request's or a per-refund note (#3827, #3880). */
  writesPointer: boolean;
  /** #4656: this run's claim of the row (its `startedAt`), so a record that committed despite its error is known as its own. */
  claimStartedAt: Date | null;
  linkRole: string;
  linkMetadata: Record<string, unknown>;
}

/** Thrown inside the record's transaction to roll it back when the claim is lost. */
class ResolvedWithANoteMeanwhile extends Error {}

/**
 * The claim: the row is not one whose resolve recorded a note. Its data is the
 * row's note, so the claim and the write are one statement.
 */
function createdRefundNoteClaim(note: Pick<CreatedRefundNote, "operationId" | "creditNoteId" | "creditNoteNumber">) {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!note.operationId) throw new Error("A refund credit note's record needs its operation's id.");
  return {
    where: { id: note.operationId, OR: [{ manuallyResolvedAt: null }, { xeroObjectId: null }] },
    data: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.creditNoteId, xeroObjectNumber: note.creditNoteNumber },
  } satisfies Prisma.XeroSyncOperationUpdateManyArgs;
}

/**
 * #4656: the record's transaction gave up waiting - its budget or pool wait ran
 * out (P2028), it lost a write conflict or deadlock (P2034, or SQLSTATE 40P01
 * through the driver adapter), or a lock was not available (55P03). Nothing it
 * wrote was committed.
 */
export function isRecordWaitLost(error: unknown): boolean {
  return isTransactionContention(error) || isWriteConflictOrDeadlock(error) || isPostgresLockNotAvailable(error);
}

/** How the note Xero returned ended: recorded, kept out by a resolve recording a note, or recorded nowhere (#4656). */
export type RefundNoteRecordOutcome = "recorded" | "resolved-by-hand" | "record-wait-lost";

/**
 * #4656: Xero made a refund note that the create did not record on its row
 * (`recordCreatedRefundNote` answered other than `recorded`). Thrown by
 * `createXeroCreditNote` after the note is traced, and never through its own
 * failure path: the row is left as the record left it. Its callers never count
 * it a success - the outbox leaves its row and counts it skipped, a queued
 * retry closes its REQUEUE row as not succeeded - and its message never advises
 * a retry, which could raise a second note.
 */
export class RefundNoteNotRecordedError extends Error {
  constructor(
    readonly outcome: Exclude<RefundNoteRecordOutcome, "recorded">,
    readonly note: Pick<CreatedRefundNote, "operationId" | "creditNoteId" | "creditNoteNumber">,
  ) {
    const named = `refund credit note ${note.creditNoteNumber ?? note.creditNoteId} (Xero id ${note.creditNoteId})`;
    super(
      outcome === "record-wait-lost"
        ? `Xero made ${named}, but the app's record of it on Xero operation ${note.operationId} could not get its locks in time, so nothing records or links it and the operation was not marked failed. Do not retry: resolve operation ${note.operationId} by hand with this note's number (mark it failed first if it still shows running).`
        : `Xero made ${named} after Xero operation ${note.operationId} was resolved by hand recording a note, so the app did not record or link it. Do not retry: check it in Xero against the note the resolve recorded.`,
    );
    this.name = "RefundNoteNotRecordedError";
  }
}

/**
 * Record the note Xero returned. `recorded`: written as before. `resolved-by-hand`:
 * an officer resolved the row recording a note while Xero was answering, and
 * nothing was written. Unless the late note is that same note, it is logged,
 * audited and alerted once; none of that throws into the create.
 * `record-wait-lost` (#4656): the transaction could not wait out a holder of
 * its rows, so nothing was written; the note is logged, audited and alerted
 * the same way, and the row is left as it is. A refusal of the note itself
 * (`assertFreshRefundNoteFromCreate`) and every other error throw, as before.
 */
export async function recordCreatedRefundNote(note: CreatedRefundNote): Promise<RefundNoteRecordOutcome> {
  try {
    await prisma.$transaction(async (tx) => {
      await lockPaymentForRefundedTotal(tx, note.paymentId);
      const claimed = await tx.xeroSyncOperation.updateMany(createdRefundNoteClaim(note));
      if (claimed.count !== 1) throw new ResolvedWithANoteMeanwhile();
      // Under the Payment row every other record of this payment's notes takes first, so a
      // second record of the same note (or a resolve recording it) has committed or waits.
      await assertFreshRefundNoteFromCreate(note.paymentId, note.operationId, { creditNoteID: note.creditNoteId, status: note.xeroStatus }, tx);
      if (note.writesPointer) {
        await tx.payment.update({ where: { id: note.paymentId }, data: { xeroRefundCreditNoteId: note.creditNoteId } });
      }
      await upsertXeroObjectLink(
        {
          localModel: "Payment",
          localId: note.paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: note.creditNoteId,
          xeroObjectNumber: note.creditNoteNumber,
          role: note.linkRole,
          metadata: note.linkMetadata,
        },
        { store: tx },
      );
    }, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
    return "recorded";
  } catch (error) {
    if (error instanceof ResolvedWithANoteMeanwhile) {
      // None of what follows throws into the create: its catch would fail the officer's row.
      await traceUnrecordedLateNote(note, lostToAResolve(note));
      return "resolved-by-hand";
    }
    if (!isRecordWaitLost(error)) throw error;
    // Nor here, and the row is left as it is (this run's RUNNING claim, or a row Mark failed meanwhile):
    // failing it would read as "nothing made" while Xero holds the note.
    const traced = await traceUnrecordedLateNote(note, recordWaitLost(note, error));
    return traced.kind === "same-note" ? whoseRecord(note, traced.row) : "record-wait-lost";
  }
}

/**
 * #4656: the re-read row records this very note although the record's
 * transaction answered an error - a commit whose answer was lost (P2028 after
 * COMMIT). It is this run's own record (`recorded`) when no resolve recorded
 * it and no other claim holds the row (`notAnotherClaim`'s rule), and the
 * create then settles and completes as for any record. A resolve that recorded
 * this same note is the officer's (`resolved-by-hand`); a row another claim
 * holds is not this run's to finish.
 */
function whoseRecord(note: CreatedRefundNote, row: XeroSyncOperation): RefundNoteRecordOutcome {
  if (row.manuallyResolvedAt !== null) return "resolved-by-hand";
  const ownClaim = row.status !== "RUNNING" || row.startedAt?.getTime() === note.claimStartedAt?.getTime();
  return ownClaim ? "recorded" : "record-wait-lost";
}

/** #4426: the trace of a note kept out by a resolve by hand recording a note. */
function lostToAResolve(note: CreatedRefundNote): LateNoteTrace {
  return {
    subject: "Refund credit note",
    lostTo: "the claim was lost to a resolve by hand recording a note",
    issue: "#4426",
    context: { paymentId: note.paymentId },
    sameNote: "The late answer is the note the resolve recorded: nothing to record or alert (#4426)",
    audit: (trace, row) =>
      auditUnrecordedNote(note, trace, row, {
        reason: "resolved-by-hand",
        summary: "Refund credit note from a stalled Xero job not recorded: the job was resolved by hand",
        details: `Xero answered a stalled refund credit-note job with credit note ${note.creditNoteNumber ?? note.creditNoteId} after an officer resolved the job by hand, recording a note. The app did not record or link it; check it in Xero.`,
      }),
  };
}

/** #4656: the trace of a note whose record could not wait out a holder of its rows. */
function recordWaitLost(note: CreatedRefundNote, error: unknown): LateNoteTrace {
  const errorCode = (error as { code?: unknown } | null)?.code;
  return {
    subject: "Refund credit note",
    lostTo: "its record could not get its locks in time (another writer held the payment or the operation, or the database broke a deadlock)",
    issue: "#4656",
    context: { paymentId: note.paymentId },
    sameNote: "The operation records this note after all (its record committed, or a resolve recorded this note): nothing to alert (#4656)",
    alertWarning: "Refund credit note made in Xero, but its record could not get its locks in time and it is not recorded on its operation (INV-INT-029, #4656)",
    audit: (trace, row) =>
      auditUnrecordedNote(note, { ...trace, errorCode: typeof errorCode === "string" ? errorCode : null }, row, {
        reason: "record-wait-lost",
        summary: "Refund credit note made in Xero not recorded: the app's record could not get its locks in time",
        details: `Xero made refund credit note ${note.creditNoteNumber ?? note.creditNoteId}, but the app's record of it could not get its locks in time, so it is not recorded or linked, and the operation was not marked failed. Resolve the operation by hand with this note's number. Do not retry it or raise another note: a retry can make a second one.`,
      }),
    alertMessage: (_row, late) =>
      `Xero made ${describeUnrecordedObject(late)} for this refund, but the app could not record it: its record could not get its locks in time (another job was holding the payment, or the database broke a deadlock). The app did not record it, link it to the payment or record a refund payment against it in Xero, and did not mark the operation failed. Resolve it by hand with this note's number: once the operation shows as stuck running, mark it failed (unless it already is), then use Resolve by hand and enter this number where it asks for one. Do not retry this operation, or an earlier one for the same refund, and do not raise another note: a retry is sized and keyed on what the app has recorded, which leaves this note out, so Xero can make a second one.`,
  };
}

/** The one audit row of a note Xero made that the create did not record (`xero`, `important`). */
async function auditUnrecordedNote(
  note: CreatedRefundNote,
  trace: Record<string, unknown>,
  row: { xeroObjectId: string | null } | null,
  why: { reason: "resolved-by-hand" | "record-wait-lost"; summary: string; details: string },
): Promise<void> {
  await createAuditLog({
    action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION,
    targetId: note.bookingId,
    entityType: "XeroSyncOperation",
    entityId: note.operationId,
    category: "xero",
    severity: "important",
    outcome: "blocked",
    summary: why.summary,
    details: why.details,
    metadata: { ...trace, reason: why.reason, recordedCreditNoteId: row?.xeroObjectId ?? null, rowFound: row !== null },
  });
}
