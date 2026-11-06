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
import { lateNoteObject, traceUnrecordedLateNote } from "@/lib/xero-late-note-trace";
import { runningClaimTransition } from "@/lib/xero-operation-claim";
import { ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { isResolvedInXero, resolutionLabel } from "@/lib/xero-operation-resolution";
import {
  describeUnrecordedObject,
  stalledAttemptCameBack,
  stoodDownBeforeCallAlert,
  unrecordedLateSuccessAlert,
  type UnrecordedXeroObject,
} from "@/lib/xero-success-after-resolution-alert";

/** #4655: the audit action of a late organiser adjustment note the create did not record. */
export const LATE_ORGANISER_NOTE_NOT_RECORDED_ACTION = "xero.organiser_adjustment_note.late_note_not_recorded";

/** #4680, #4701: the audit action of an organiser adjustment run that stood down, its claim lost after it recorded its note or before its waiver's void. */
export const ORGANISER_RUN_STOOD_DOWN_ACTION = "xero.organiser_adjustment_note.run_stood_down";

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
    own: { where: { id, ...ownRunningClaim(note.claim), AND: [noOtherNote] }, data: fields },
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

/**
 * #4680: the Xero call a run that lost its claim did not make. `completion`:
 * the run had no call left to make - nothing left to allocate, or a refund
 * note its settlement found already settled or not the app's to pay.
 */
export type OrganiserStandDownStep = "resize" | "allocation" | "refund-payment" | "completion";

const STAND_DOWN_STEP: Record<Exclude<OrganiserStandDownStep, "completion">, string> = {
  resize: "resizing the note to what is still due and allocating it to the organiser's invoice",
  allocation: "allocating the note to the organiser's invoice",
  "refund-payment": "recording a refund payment against the note",
};

/** What the stood-down run did not do, as an officer reads it. */
function standDownStep(step: OrganiserStandDownStep, purpose: CreatedOrganiserNote["purpose"]): string {
  if (step !== "completion") return STAND_DOWN_STEP[step];
  return purpose === "waive"
    ? "recording the adjustment as done (the note was already allocated in full)"
    : "recording the adjustment as done (Xero already showed the note settled, or the app had no refund payment to record)";
}

/**
 * #4680 (`INV-INT-034`): a run that recorded its note and then found, before a
 * money-moving Xero call, that it no longer holds its claim
 * (`holdsXeroOperationClaim`): a stale reset failed the row while the run
 * waited on Xero, and an officer may since have resolved or queued it again,
 * or a later claim taken it. The run makes no further Xero call and writes no
 * outcome. Its trace: a warning first; a re-read of the row; one `xero` audit
 * row; and, only when the row was resolved by hand, #4374's alert once per
 * note (`unrecordedLateSuccessAlert`). Anywhere else the row still records the
 * note, and whoever holds or retries it finishes from it, so there is nothing
 * for an officer to check. Each step is caught; nothing throws into the
 * outbox, whose failure write must not land on the officer's row. Run outside
 * any transaction - the alert sends an email.
 */
export async function traceOrganiserRunStoodDown(note: CreatedOrganiserNote, step: OrganiserStandDownStep): Promise<void> {
  await traceStandDown({
    claim: note.claim,
    bookingId: note.bookingId,
    trace: {
      purpose: note.purpose, creditNoteId: note.creditNoteId, creditNoteNumber: note.creditNoteNumber, amountCents: note.amountCents, step,
    },
    warning: "Organiser adjustment run no longer holds its claim after recording its credit note; it stands down and makes no Xero call (INV-INT-034, #4680)",
    issue: "#4680",
    details: (status) => `A stalled organiser ${adjustmentLabel(note.purpose)} job came back after it was reset${status} and stopped before ${standDownStep(step, note.purpose)}. The app made no further Xero call for credit note ${note.creditNoteNumber ?? note.creditNoteId}.`,
    alert: async (row) => {
      const late = await lateNoteObject({
        operationId: note.claim.id, bookingId: note.bookingId, creditNoteId: note.creditNoteId, creditNoteNumber: note.creditNoteNumber, amountCents: note.amountCents,
      });
      await unrecordedLateSuccessAlert(row, late, organiserStoodDownMessage(row, late, note.purpose, step), ORGANISER_STOOD_DOWN_WARNING)();
    },
  });
}

/** #4701: a waiver run about to void the organiser's invoice. It has raised no credit note. */
export interface OrganiserVoidStandDown {
  claim: XeroOperationClaim;
  bookingId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  /** What the void would have released: the invoice's amount due, as the run read it. */
  amountCents: number;
}

/**
 * #4701 (`INV-INT-034`): a waiver run that found, immediately before voiding
 * the organiser's unpaid invoice, that it no longer holds its claim - it
 * stalled in its first invoice read past a stale reset, and an officer may
 * since have resolved or queued the row again. It voids nothing and writes no
 * outcome. Traced as `traceOrganiserRunStoodDown` is (warned, audited once
 * under the same action, alerted once only on a row resolved by hand), but it
 * names the invoice: the run made nothing in Xero.
 */
export async function traceOrganiserVoidStoodDown(run: OrganiserVoidStandDown): Promise<void> {
  const invoice = `invoice ${run.invoiceNumber ?? run.invoiceId}`;
  await traceStandDown({
    claim: run.claim,
    bookingId: run.bookingId,
    trace: { purpose: "waive", invoiceId: run.invoiceId, invoiceNumber: run.invoiceNumber, amountCents: run.amountCents, step: "void" },
    warning: "Organiser waiver run no longer holds its claim before voiding the organiser's invoice; it stands down and makes no Xero call (INV-INT-034, #4701)",
    issue: "#4701",
    details: (status) => `A stalled organiser ${adjustmentLabel("waive")} job came back after it was reset${status} and stopped before voiding the organiser's ${invoice}. The app made no Xero call.`,
    alert: async (row) => {
      const message = `This organiser ${adjustmentLabel("waive")} operation stalled, was reset, and was then marked "${resolutionLabel(row.manuallyResolvedReason)}". When its run came back it stopped before voiding the organiser's ${invoice} (Xero id ${run.invoiceId}, booking ${run.bookingId}), and made no Xero call: it raised no credit note and changed nothing in Xero. The operation stays as resolved. Check in Xero that the invoice stands as the adjustment made by hand left it.`;
      await stoodDownBeforeCallAlert(row, { xeroObjectId: run.invoiceId, xeroObjectNumber: run.invoiceNumber, bookingId: run.bookingId }, message, ORGANISER_VOID_STOOD_DOWN_WARNING)();
    },
  });
}

/** The parts of a stand-down's trace each kind of run supplies. */
interface StandDownReport {
  claim: XeroOperationClaim;
  bookingId: string;
  /** Keys every log line and the audit metadata carry beside the claim's and booking's. */
  trace: Record<string, unknown>;
  /** The first warning. */
  warning: string;
  /** The issue the error lines cite. */
  issue: string;
  /** The audit row's details, given the re-read row's status clause (" (it now stands FAILED, resolved by hand)", or ""). */
  details: (status: string) => string;
  /** The once-ever alert, sent only for a row resolved by hand. */
  alert: (row: XeroSyncOperation) => Promise<void>;
}

/** #4680, #4701: warn, re-read the row, audit once, and alert once if it was resolved by hand. Never throws. */
async function traceStandDown(report: StandDownReport): Promise<void> {
  const trace = { operationId: report.claim.id, claimStartedAt: report.claim.startedAt, bookingId: report.bookingId, ...report.trace };
  logger.warn(trace, report.warning);
  let row: XeroSyncOperation | null;
  try {
    row = await prisma.xeroSyncOperation.findUnique({ where: { id: report.claim.id } });
  } catch (error) {
    logger.error({ ...trace, err: error }, `Organiser adjustment run stood down, and its operation could not be re-read: no audit row or alert; this log is its only record (${report.issue})`);
    return;
  }
  const resolved = row ? isResolvedInXero(row) : false;
  try {
    await createAuditLog({
      action: ORGANISER_RUN_STOOD_DOWN_ACTION,
      targetId: report.bookingId,
      entityType: "XeroSyncOperation",
      entityId: report.claim.id,
      category: "xero",
      severity: "important",
      outcome: "blocked",
      summary: "Organiser adjustment run stopped: its stalled Xero job was reset",
      details: report.details(row ? ` (it now stands ${row.status}${resolved ? ", resolved by hand" : ""})` : ""),
      metadata: { ...trace, claimStartedAt: report.claim.startedAt?.toISOString() ?? null, rowFound: row !== null, rowStatus: row?.status ?? null, resolvedByHand: row ? resolved : null },
    });
  } catch (error) {
    logger.error({ ...trace, err: error }, `Organiser adjustment run stood down, and its audit row failed (${report.issue})`);
  }
  if (!row || !resolved) return;
  try {
    await report.alert(row);
  } catch (error) {
    logger.error({ ...trace, err: error }, `Organiser adjustment run stood down on a resolved operation, and its alert failed (${report.issue})`);
  }
}

const ORGANISER_VOID_STOOD_DOWN_WARNING =
  "Organiser waiver run stood down on an operation resolved by hand after its reset; the app did not void the organiser's invoice (INV-INT-034, #4701)";

const ORGANISER_STOOD_DOWN_WARNING =
  "Organiser adjustment run stood down on an operation resolved by hand after its reset; the app did not allocate or pay against its credit note (INV-INT-034, #4680)";

/** The alert's body: the run made its note, the officer resolved the job, and the run stopped short. */
function organiserStoodDownMessage(row: XeroSyncOperation, late: UnrecordedXeroObject, purpose: CreatedOrganiserNote["purpose"], step: OrganiserStandDownStep): string {
  return `This organiser ${adjustmentLabel(purpose)} operation stalled, was reset, and was then marked "${resolutionLabel(row.manuallyResolvedReason)}". Its run had already made ${describeUnrecordedObject(late)} in Xero and recorded it on this operation. When the run came back it stopped before ${standDownStep(step, purpose)}, and made no further Xero call. The operation stays as resolved. If the adjustment was also made by hand in Xero, Xero may now hold two credit notes for it: check this one in Xero, and that nothing is allocated from it or paid against it, before voiding it.`;
}
