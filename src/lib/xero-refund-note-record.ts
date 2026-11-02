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
 * Lock order: the Payment row (the pointer's UPDATE, only when the note takes
 * the pointer), then the operation row (the claim), then the link - the order
 * the resolve's claim takes the same rows (`claimResolveRecordingRefundNote`:
 * `lock(1)`, Payment, the row, the link), so the two never wait on each other
 * in a cycle.
 */
import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { traceUnrecordedLateNote } from "@/lib/xero-late-note-trace";
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
  // None of what follows throws into the create: its catch would fail the officer's row.
  await traceUnrecordedLateNote(note, {
    subject: "Refund credit note",
    lostTo: "the claim was lost to a resolve by hand recording a note",
    issue: "#4426",
    context: { paymentId: note.paymentId },
    sameNote: "The late answer is the note the resolve recorded: nothing to record or alert (#4426)",
    audit: async (trace, row) => {
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
    },
  });
  return "resolved-by-hand";
}
