/**
 * #4655 (`INV-INT-029`, `INV-PAY-148`): an organiser adjustment's record of the
 * credit note Xero returned, on its outbox row, before any allocation or
 * refund payment.
 *
 * A create can stall in Xero past the stale threshold. Reset stale running
 * then fails its row while the run is still waiting on Xero. An organiser
 * adjustment's retry runs on that SAME row (`requeueOutboxRowForRetry` hands it
 * back to PENDING in place, keeping its note), and a run that finds a note on
 * its row continues from it rather than raising another. So the note must
 * reach the row, or an officer, every time:
 *
 * - **Recorded** where a success may land (`INV-INT-029`) and no other note is
 *   recorded: this run's own RUNNING claim (`claimed`); a row no claim holds
 *   that a reset left FAILED (`landed`: this run carries on, allocates or pays
 *   out the note and completes it); or one an officer queued again, PENDING
 *   (`queued`: this run stops, and the queued run finishes from the note
 *   instead of raising a second one).
 * - **Not recorded** on a row resolved by hand (nothing retries it, so the
 *   note would only add Xero writes after an officer took the adjustment
 *   over), one another attempt holds RUNNING or has recorded a different note
 *   on, or one closed since. The late note is then logged, audited once
 *   (`xero`) and alerted once (`traceUnrecordedLateNote`, #4426's trace), and
 *   nothing throws into the outbox's catch, whose failure write would land on
 *   the row an officer reset, resolved or queued again.
 *
 * One status-guarded `updateMany` on the operation row is the whole claim: no
 * advisory lock, the row lock of that statement only. The resets, the
 * requeue, the outbox claim and the resolve mark all write the same row
 * status-guarded, so whichever commits first wins and the other's guard reads
 * the committed row.
 */
import type { Prisma, XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { traceUnrecordedLateNote } from "@/lib/xero-late-note-trace";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { isResolvedInXero, resolutionLabel } from "@/lib/xero-operation-resolution";
import { stalledAttemptCameBack, type UnrecordedXeroObject } from "@/lib/xero-success-after-resolution-alert";

/** #4655: the audit action of a late organiser adjustment note the create did not record. */
export const LATE_ORGANISER_NOTE_NOT_RECORDED_ACTION = "xero.organiser_adjustment_note.late_note_not_recorded";

export interface CreatedOrganiserNote {
  /** The run's claim: the row's id and the `startedAt` the outbox stamped. */
  claim: XeroOperationClaim;
  bookingId: string;
  purpose: "waive" | "refund";
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The note's amount, as raised in Xero. */
  amountCents: number;
}

/**
 * `claimed`: on this run's own claim. `landed`: on a row a reset left FAILED,
 * which this run finishes. `queued`: on a row queued again, which the queued
 * run finishes. `not-recorded`: traced, and this run stops.
 */
export type OrganiserNoteRecord = "claimed" | "landed" | "queued" | "not-recorded";

/**
 * The claim and the write as one statement: the row records no other note,
 * and is either this run's RUNNING claim or a row no claim holds and no
 * resolve closed - FAILED after a reset, or PENDING after a retry queued it.
 */
export function createdOrganiserNoteClaim(note: Pick<CreatedOrganiserNote, "claim" | "creditNoteId" | "creditNoteNumber">) {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!note.claim.id) throw new Error("An organiser adjustment note's record needs its operation's id.");
  return {
    where: {
      id: note.claim.id,
      AND: [
        { OR: [{ xeroObjectId: null }, { xeroObjectId: note.creditNoteId }] },
        {
          OR: [
            { status: "RUNNING", startedAt: note.claim.startedAt },
            { status: { in: ["FAILED", "PENDING"] }, manuallyResolvedAt: null },
          ],
        },
      ],
    },
    data: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.creditNoteId, xeroObjectNumber: note.creditNoteNumber },
  } satisfies Prisma.XeroSyncOperationUpdateManyArgs;
}

/** Record the note Xero returned, or trace it when no row may take it. Throws only when the write itself fails. */
export async function recordCreatedOrganiserNote(note: CreatedOrganiserNote): Promise<OrganiserNoteRecord> {
  const trace = {
    operationId: note.claim.id,
    bookingId: note.bookingId,
    purpose: note.purpose,
    creditNoteId: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    amountCents: note.amountCents,
  };
  let rows: Array<Pick<XeroSyncOperation, "status">>;
  try {
    rows = await prisma.xeroSyncOperation.updateManyAndReturn({ ...createdOrganiserNoteClaim(note), select: { status: true } });
  } catch (error) {
    // The note exists in Xero: name it before the outbox fails the row on this error.
    logger.error({ ...trace, err: error }, "Organiser adjustment credit note from Xero could not be recorded on its operation (#4655)");
    throw error;
  }
  const status = rows[0]?.status;
  if (status === "RUNNING") return "claimed";
  if (status === "FAILED") {
    logger.warn(trace, "Organiser adjustment credit note landed on its operation after a reset; this run finishes it (INV-INT-029, #4655)");
    return "landed";
  }
  if (status === "PENDING") {
    logger.warn(trace, "Organiser adjustment credit note landed on its operation queued again; the queued run finishes from it (INV-INT-029, #4655)");
    return "queued";
  }
  await traceUnrecordedLateNote(
    { operationId: note.claim.id, bookingId: note.bookingId, creditNoteId: note.creditNoteId, creditNoteNumber: note.creditNoteNumber, amountCents: note.amountCents },
    {
      subject: "Organiser adjustment credit note",
      lostTo: "its operation was reset and may not take the note (resolved by hand, held by another attempt, recording another note or closed)",
      issue: "#4655",
      context: { purpose: note.purpose },
      sameNote: "The late answer is the note the operation records: nothing to record or alert (#4655)",
      audit: async (fields, row) => {
        await createAuditLog({
          action: LATE_ORGANISER_NOTE_NOT_RECORDED_ACTION,
          targetId: note.bookingId,
          entityType: "XeroSyncOperation",
          entityId: note.claim.id,
          category: "xero",
          severity: "important",
          outcome: "blocked",
          summary: "Organiser adjustment credit note from a stalled Xero job not recorded",
          details: `Xero answered a stalled organiser ${adjustmentLabel(note.purpose)} job with credit note ${note.creditNoteNumber ?? note.creditNoteId} after the job was reset${row ? ` (it now stands ${row.status}${isResolvedInXero(row) ? ", resolved by hand" : ""})` : ""}. The app did not record, allocate or pay against it; check it in Xero.`,
          metadata: {
            ...fields,
            rowFound: row !== null,
            rowStatus: row?.status ?? null,
            resolvedByHand: row ? isResolvedInXero(row) : null,
            recordedCreditNoteId: row?.xeroObjectId ?? null,
          },
        });
      },
      alertMessage: (row, late) => organiserLateNoteMessage(row, late, note.purpose),
    },
  );
  return "not-recorded";
}

function adjustmentLabel(purpose: CreatedOrganiserNote["purpose"]): string {
  return purpose === "waive" ? "unpaid-extra waiver" : "bank-transfer refund note";
}

/** The alert's body: why the late note was kept out, and what an officer checks before voiding it. */
function organiserLateNoteMessage(row: XeroSyncOperation, late: UnrecordedXeroObject, purpose: CreatedOrganiserNote["purpose"]): string {
  const came = `${stalledAttemptCameBack(late)} The app did not record it on this operation, allocate it to the organiser's invoice or record a refund payment against it in Xero.`;
  const check = "check the late one in Xero, and that nothing is allocated from it or paid against it, before voiding it.";
  const recorded = row.xeroObjectId ? `credit note ${row.xeroObjectNumber ?? row.xeroObjectId}` : null;
  if (isResolvedInXero(row)) {
    return `This organiser ${adjustmentLabel(purpose)} operation was marked "${resolutionLabel(row.manuallyResolvedReason)}"${recorded ? `, recording ${recorded}` : ""}, and then ${came} The operation stays as resolved. If the adjustment was also made by hand in Xero, Xero may now hold two credit notes for it: ${check}`;
  }
  if (recorded) {
    return `This organiser ${adjustmentLabel(purpose)} operation was reset after it stalled, and a later attempt recorded ${recorded} on it; then ${came} Xero may now hold two credit notes for one adjustment: ${check}`;
  }
  if (row.status === "RUNNING") {
    return `This organiser ${adjustmentLabel(purpose)} operation was reset after it stalled and is running again; then ${came} The run now going may record this same note (Xero can answer a repeat of the same call with it) or raise another: once that run has finished, compare the note the operation records with this one in Xero before voiding either.`;
  }
  return `This organiser ${adjustmentLabel(purpose)} operation was reset after it stalled and now stands ${row.status} without recording this note; then ${came} ${check.charAt(0).toUpperCase()}${check.slice(1)}`;
}
