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
 *   that a reset left FAILED, which the same write takes back RUNNING under a
 *   fresh claim (`retaken`, #4672 review S1/S2: this run allocates or pays out
 *   the note and completes or fails the row under that claim, and while it does
 *   the row is RUNNING, so Resolve and Retry refuse it and Reset stale running
 *   still covers a process that dies); or one an officer queued again, PENDING
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
 * Each record is one status-guarded `updateMany` on the operation row: no
 * advisory lock, the row lock of that statement only. They are tried in turn
 * (own claim, re-take, queued), each a transition valid whenever it commits,
 * so a row that moves between two of them is simply met in its new state. The
 * resets, the requeue, the outbox claim and the resolve mark all write the
 * same row status-guarded, so whichever commits first wins and the other's
 * guard reads the committed row.
 */
import type { Prisma, XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { traceUnrecordedLateNote } from "@/lib/xero-late-note-trace";
import { runningClaimTransition } from "@/lib/xero-operation-claim";
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
 * `claimed`: on this run's own claim. `retaken`: on a row a reset left FAILED,
 * now RUNNING under `claim`, which this run finishes and every outcome of it is
 * written under. `queued`: on a row queued again, which the queued run
 * finishes. `not-recorded`: traced, and this run stops.
 */
export type OrganiserNoteRecord =
  | { outcome: "claimed" | "retaken"; claim: XeroOperationClaim }
  | { outcome: "queued" | "not-recorded" };

/**
 * The three guarded records, in the order they are tried. Each takes a row
 * that records no other note: `own` this run's RUNNING claim; `retake` a row a
 * reset left FAILED and no resolve closed, taken back RUNNING under a claim
 * stamped `retakenAt` with the claim's own resets (`claimXeroSyncOperationToRunning`);
 * `queued` a row a retry queued again, PENDING and unresolved, left PENDING.
 */
export function createdOrganiserNoteWrites(
  note: Pick<CreatedOrganiserNote, "claim" | "creditNoteId" | "creditNoteNumber">,
  retakenAt: Date,
) {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!note.claim.id) throw new Error("An organiser adjustment note's record needs its operation's id.");
  const id = note.claim.id;
  const noOtherNote = { OR: [{ xeroObjectId: null }, { xeroObjectId: note.creditNoteId }] };
  const fields = { xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.creditNoteId, xeroObjectNumber: note.creditNoteNumber };
  return {
    own: { where: { id, status: "RUNNING", startedAt: note.claim.startedAt, AND: [noOtherNote] }, data: fields },
    retake: {
      // `replayable`: a row an officer marked non-replayable is dead to every runner (#4672 review).
      where: { id, status: "FAILED", manuallyResolvedAt: null, replayable: true, AND: [noOtherNote] },
      data: { ...fields, ...runningClaimTransition(retakenAt) },
    },
    queued: { where: { id, status: "PENDING", manuallyResolvedAt: null, AND: [noOtherNote] }, data: fields },
  } satisfies Record<string, Prisma.XeroSyncOperationUpdateManyArgs>;
}

/** Record the note Xero returned, or trace it when no row may take it. Throws only when a write itself fails. */
export async function recordCreatedOrganiserNote(note: CreatedOrganiserNote): Promise<OrganiserNoteRecord> {
  const trace = {
    operationId: note.claim.id,
    bookingId: note.bookingId,
    purpose: note.purpose,
    creditNoteId: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    amountCents: note.amountCents,
  };
  const retakenAt = new Date();
  const writes = createdOrganiserNoteWrites(note, retakenAt);
  const record = async (args: Prisma.XeroSyncOperationUpdateManyArgs, activeKeyTaken: "lost" | "throw") => {
    try {
      return (await prisma.xeroSyncOperation.updateManyAndReturn({ ...args, select: { id: true } })).length === 1;
    } catch (error) {
      // RUNNING is an active status: a live row already holding this correlation key keeps it, and this re-take loses.
      if (activeKeyTaken === "lost" && isPrismaUniqueConstraintError(error)) return false;
      // The note exists in Xero: name it before the outbox fails the row on this error.
      logger.error({ ...trace, err: error }, "Organiser adjustment credit note from Xero could not be recorded on its operation (#4655)");
      throw error;
    }
  };
  if (await record(writes.own, "throw")) return { outcome: "claimed", claim: note.claim };
  if (await record(writes.retake, "lost")) {
    logger.warn(
      { ...trace, retakenAt },
      "Organiser adjustment credit note landed on its operation after a reset; this run took the operation back under a new claim and finishes it (INV-INT-029, #4655)",
    );
    return { outcome: "retaken", claim: { id: note.claim.id, startedAt: retakenAt } };
  }
  if (await record(writes.queued, "throw")) {
    logger.warn(trace, "Organiser adjustment credit note landed on its operation queued again; the queued run finishes from it (INV-INT-029, #4655)");
    return { outcome: "queued" };
  }
  await traceUnrecordedLateNote(
    { operationId: note.claim.id, bookingId: note.bookingId, creditNoteId: note.creditNoteId, creditNoteNumber: note.creditNoteNumber, amountCents: note.amountCents },
    {
      subject: "Organiser adjustment credit note",
      lostTo: "its operation was reset and may not take the note (resolved by hand, marked non-replayable, held by another attempt or a live row with its key, recording another note or closed)",
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
  return { outcome: "not-recorded" };
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
