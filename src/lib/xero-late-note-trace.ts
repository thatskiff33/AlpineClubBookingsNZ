/**
 * #4426, #4655 (`INV-INT-029`): the trace a Xero credit-note create leaves when
 * Xero answers with a note the create did not record on its operation row.
 *
 * A create can stall in Xero past the stale threshold and be reset or resolved
 * by hand while its call is still waiting. When Xero then answers, the note
 * exists in Xero; if the create's guarded write of it lost (a resolve recorded
 * a note, #4426; a later attempt holds or records the row, or an officer
 * resolved it, #4655), nothing in the app records it. This is its one trace,
 * shared by both creates (`INV-SSOT`):
 *
 * 1. a warning naming the note, logged first, before anything else can fail;
 * 2. a re-read of the row: if it records this very note, nothing is wrong and
 *    only an info line is logged;
 * 3. the caller's own audit row (its own action, category `xero`);
 * 4. #4374's alert, once per late note (`unrecordedLateSuccessAlert`, keyed
 *    `xero-success-after-resolution:<operation id>:<note id>`).
 *
 * Each step is caught: nothing here throws into the create, whose catch would
 * fail the row an officer reset, resolved or queued again. Run it outside any
 * transaction - the alert sends an email.
 */
import type { XeroSyncOperation } from "@prisma/client";

import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { unrecordedLateSuccessAlert, type UnrecordedXeroObject } from "@/lib/xero-success-after-resolution-alert";

/** A credit note Xero made for a stalled create, which the create did not record. */
export interface UnrecordedLateNote {
  operationId: string;
  bookingId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The note's amount, as raised in Xero. */
  amountCents: number;
}

export interface LateNoteTrace {
  /** Names the note in the log lines, e.g. "Refund credit note". */
  subject: string;
  /** Why the create's write lost, for the first warning. */
  lostTo: string;
  /** The issue the log lines cite, e.g. "#4426". */
  issue: string;
  /** Keys every log line and the audit metadata carry beside the note's own (e.g. the payment's id). */
  context?: Record<string, unknown>;
  /** The info line when the re-read row already records this very note. */
  sameNote: string;
  /**
   * The caller's audit row, given the trace and the re-read row (null when the
   * row is gone). It writes with its own literal action and category `xero`.
   */
  audit: (trace: Record<string, unknown>, row: XeroSyncOperation | null) => Promise<void>;
  /** The alert's body for this row and late note; omitted, a refund note's (#4426). */
  alertMessage?: (row: XeroSyncOperation, late: UnrecordedXeroObject) => string;
}

/** Log, audit and alert a late note the create did not record. Never throws. */
export async function traceUnrecordedLateNote(note: UnrecordedLateNote, report: LateNoteTrace): Promise<void> {
  const trace = {
    operationId: note.operationId,
    ...report.context,
    bookingId: note.bookingId,
    creditNoteId: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    amountCents: note.amountCents,
  };
  const notRecorded = `${report.subject} from Xero not recorded`;
  // The first trace, before anything else can fail: the note exists in Xero and nothing here records it.
  logger.warn(trace, `${report.subject} from Xero: ${report.lostTo}; re-checking the operation (INV-INT-029, ${report.issue})`);
  let row: XeroSyncOperation | null;
  try {
    row = await prisma.xeroSyncOperation.findUnique({ where: { id: note.operationId } });
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its operation could not be re-read: no audit row or alert; this log is its only record (${report.issue})`);
    return;
  }
  if (row?.xeroObjectId === note.creditNoteId) {
    logger.info(trace, report.sameNote);
    return;
  }
  try {
    await report.audit(trace, row);
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its audit row failed (${report.issue})`);
  }
  if (!row) {
    logger.error(trace, `${notRecorded}, and its operation row is gone: no alert sent (${report.issue})`);
    return;
  }
  try {
    const late: UnrecordedXeroObject = {
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: note.creditNoteId,
      xeroObjectNumber: note.creditNoteNumber,
      amount: await formattedAmount(note),
      bookingId: note.bookingId,
    };
    await unrecordedLateSuccessAlert(row, late, report.alertMessage?.(row, late))();
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its alert failed (${report.issue})`);
  }
}

/** The note's amount in the club's money format, or null when the format cannot be read (the alert still goes). */
async function formattedAmount(note: UnrecordedLateNote): Promise<string | null> {
  try {
    return formatCents(note.amountCents, await clubFormatValues());
  } catch (error) {
    logger.warn({ operationId: note.operationId, err: error }, "Club money format unreadable; the late-note alert names no amount");
    return null;
  }
}
