/**
 * #4426 (`INV-INT-029`, `INV-PAY-111`): the payment refund-note create's record
 * of the note Xero returned - the payment's pointer (when it takes one), the
 * row's note and the note's link - in one transaction, under a claim.
 *
 * A create can stall in Xero past the stale threshold. "Reset stale running"
 * then fails its row, and an officer may "Resolve by hand", recording the note
 * they made (#4421, `INV-INT-028`). The stalled run is still alive: when Xero
 * answers, its note is a second note for the same refund. So the row's note is
 * written by a status-guarded `updateMany` on `manuallyResolvedAt: null` (the
 * query-side spelling of `isResolvedInXero`) before the link, and a lost claim
 * rolls the whole record back: no pointer, no link, the officer's note left on
 * the row. The late note is then surfaced to the officers through #4374's
 * alert (`unrecordedLateSuccessAlert`), never silently linked.
 *
 * Any row not resolved by hand is written as before, whatever its status: a
 * success lands on any row no claim holds (`INV-INT-029`), so a late answer
 * after a reset with no resolve records its note on the FAILED row, and the
 * completion then lands SUCCEEDED on it. On a row a later claim holds RUNNING,
 * the note is recorded too, as #4373 records a refused success's links.
 *
 * Lock order: the Payment row (the pointer), then the operation row (the
 * claim), then the link - the order the resolve's claim takes the same rows
 * (`claimResolveRecordingRefundNote`), so the two never wait on each other in
 * a cycle.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { unrecordedLateSuccessAlert } from "@/lib/xero-success-after-resolution-alert";
import { upsertXeroObjectLink } from "@/lib/xero-sync";

export interface CreatedRefundNote {
  paymentId: string;
  operationId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The payment's one canonical note: never a refund request's or a per-refund note (#3827, #3880). */
  writesPointer: boolean;
  linkRole: string;
  linkMetadata: Record<string, unknown>;
}

/** Thrown inside the record's transaction to roll it back when the claim is lost. */
class ResolvedByHandMeanwhile extends Error {}

/**
 * The claim: the row is not resolved by hand. Its data is the row's note, so
 * the claim and the write are one statement.
 */
function createdRefundNoteClaim(note: Pick<CreatedRefundNote, "operationId" | "creditNoteId" | "creditNoteNumber">) {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!note.operationId) throw new Error("A refund credit note's record needs its operation's id.");
  return {
    where: { id: note.operationId, manuallyResolvedAt: null },
    data: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.creditNoteId, xeroObjectNumber: note.creditNoteNumber },
  } satisfies Prisma.XeroSyncOperationUpdateManyArgs;
}

/**
 * Record the note Xero returned. `recorded`: written as before. `resolved-by-hand`:
 * an officer resolved the row while Xero was answering - nothing was written,
 * and a warning is logged and the officers alerted once with the late note's
 * id and number (`unrecordedLateSuccessAlert`). A row that no longer exists
 * throws, as the unguarded write before #4426 did.
 */
export async function recordCreatedRefundNote(note: CreatedRefundNote): Promise<"recorded" | "resolved-by-hand"> {
  try {
    await prisma.$transaction(async (tx) => {
      if (note.writesPointer) {
        await tx.payment.update({ where: { id: note.paymentId }, data: { xeroRefundCreditNoteId: note.creditNoteId } });
      }
      const claimed = await tx.xeroSyncOperation.updateMany(createdRefundNoteClaim(note));
      if (claimed.count !== 1) throw new ResolvedByHandMeanwhile();
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
    if (!(error instanceof ResolvedByHandMeanwhile)) throw error;
  }
  const row = await prisma.xeroSyncOperation.findUnique({ where: { id: note.operationId } });
  if (!row) throw new Error(`Xero operation ${note.operationId} was not found, so credit note ${note.creditNoteId} was not recorded.`);
  await unrecordedLateSuccessAlert(row, {
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: note.creditNoteId,
    xeroObjectNumber: note.creditNoteNumber,
  })();
  return "resolved-by-hand";
}
