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
 * status-guarded `updateMany` that refuses only a row whose resolve RECORDED a
 * note (`manuallyResolvedAt` set and `xeroObjectId` set), before the link, and
 * a lost claim rolls the whole record back: no pointer, no link, the officer's
 * note left on the row. The late note is then logged, audited once (`xero`)
 * and surfaced to the officers through #4374's alert
 * (`unrecordedLateSuccessAlert`), never silently linked - unless it IS the note
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
 * Lock order: the Payment row (the pointer's UPDATE, only when the note takes
 * the pointer), then the operation row (the claim), then the link - the order
 * the resolve's claim takes the same rows (`claimResolveRecordingRefundNote`:
 * `lock(1)`, Payment, the row, the link), so the two never wait on each other
 * in a cycle.
 */
import type { Prisma, XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { unrecordedLateSuccessAlert } from "@/lib/xero-success-after-resolution-alert";
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
  /** The payment's one canonical note: never a refund request's or a per-refund note (#3827, #3880). */
  writesPointer: boolean;
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
 * Record the note Xero returned. `recorded`: written as before. `resolved-by-hand`:
 * an officer resolved the row recording a note while Xero was answering, and
 * nothing was written. Unless the late note is that same note, it is logged,
 * audited and alerted once; none of that throws into the create.
 */
export async function recordCreatedRefundNote(note: CreatedRefundNote): Promise<"recorded" | "resolved-by-hand"> {
  try {
    await prisma.$transaction(async (tx) => {
      if (note.writesPointer) {
        await tx.payment.update({ where: { id: note.paymentId }, data: { xeroRefundCreditNoteId: note.creditNoteId } });
      }
      const claimed = await tx.xeroSyncOperation.updateMany(createdRefundNoteClaim(note));
      if (claimed.count !== 1) throw new ResolvedWithANoteMeanwhile();
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
    });
    return "recorded";
  } catch (error) {
    if (!(error instanceof ResolvedWithANoteMeanwhile)) throw error;
  }
  const trace = {
    operationId: note.operationId,
    paymentId: note.paymentId,
    bookingId: note.bookingId,
    creditNoteId: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    amountCents: note.amountCents,
  };
  // The first trace, before anything else can fail: the note exists in Xero and nothing here records it.
  logger.warn(trace, "Refund credit note from Xero not recorded: its operation was resolved by hand, recording a note, while Xero answered (INV-INT-029)");
  // None of what follows throws into the create: its catch would fail the officer's row.
  let row: XeroSyncOperation | null;
  try {
    row = await prisma.xeroSyncOperation.findUnique({ where: { id: note.operationId } });
  } catch (error) {
    logger.error({ ...trace, err: error }, "Refund credit note from Xero not recorded, and its operation could not be re-read: no audit row or alert; this log is its only record (#4426)");
    return "resolved-by-hand";
  }
  if (row?.xeroObjectId === note.creditNoteId) {
    logger.info(trace, "The late answer is the note the resolve recorded: nothing to record or alert (#4426)");
    return "resolved-by-hand";
  }
  try {
    await createAuditLog({
      action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION,
      targetId: note.bookingId,
      entityType: "XeroSyncOperation",
      entityId: note.operationId,
      category: "xero",
      severity: "important",
      outcome: "blocked",
      summary: "Refund credit note from a stalled Xero job not recorded: the job was resolved by hand",
      details: `Xero answered a stalled refund credit-note job with credit note ${note.creditNoteNumber ?? note.creditNoteId} after an officer resolved the job by hand, recording a note. The app did not record or link it; check it in Xero.`,
      metadata: { ...trace, recordedCreditNoteId: row?.xeroObjectId ?? null, rowFound: row !== null },
    });
  } catch (error) {
    logger.error({ ...trace, err: error }, "Refund credit note from Xero not recorded, and its audit row failed (#4426)");
  }
  if (!row) {
    logger.error(trace, "Refund credit note from Xero not recorded, and its operation row is gone: no alert sent (#4426)");
    return "resolved-by-hand";
  }
  try {
    await unrecordedLateSuccessAlert(row, {
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: note.creditNoteId,
      xeroObjectNumber: note.creditNoteNumber,
      amount: await formattedAmount(note),
      bookingId: note.bookingId,
    })();
  } catch (error) {
    logger.error({ ...trace, err: error }, "Refund credit note from Xero not recorded, and its alert failed (#4426)");
  }
  return "resolved-by-hand";
}

/** The note's amount in the club's money format, or null when the format cannot be read (the alert still goes). */
async function formattedAmount(note: CreatedRefundNote): Promise<string | null> {
  try {
    return formatCents(note.amountCents, await clubFormatValues());
  } catch (error) {
    logger.warn({ operationId: note.operationId, err: error }, "Club money format unreadable; the late-note alert names no amount");
    return null;
  }
}
