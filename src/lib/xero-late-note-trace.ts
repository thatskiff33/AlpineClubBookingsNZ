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
 * Steps 2-4 are `traceLateXeroObject`, which #4686's part-success that lost
 * its claim shares (`xero-late-partial-trace.ts`).
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
  /** The alert's log line; omitted, a late success kept off a reset or resolved row (#4426). */
  alertWarning?: string;
}

/**
 * What the trace found. `same-note`: the re-read row records this very note,
 * so nothing was audited or alerted; the row is handed back for the caller to
 * judge whose record that was (#4656). `traced`: everything else.
 */
type LateNoteTraceResult = { kind: "same-note"; row: XeroSyncOperation } | { kind: "traced" };

/** Log, audit and alert a late note the create did not record. Never throws. */
export async function traceUnrecordedLateNote(note: UnrecordedLateNote, report: LateNoteTrace): Promise<LateNoteTraceResult> {
  const trace = {
    operationId: note.operationId,
    ...report.context,
    bookingId: note.bookingId,
    creditNoteId: note.creditNoteId,
    creditNoteNumber: note.creditNoteNumber,
    amountCents: note.amountCents,
  };
  // The first trace, before anything else can fail: the note exists in Xero and nothing here records it.
  logger.warn(trace, `${report.subject} from Xero: ${report.lostTo}; re-checking the operation (INV-INT-029, ${report.issue})`);
  return traceLateXeroObject({
    operationId: note.operationId,
    xeroObjectId: note.creditNoteId,
    trace,
    notRecorded: `${report.subject} from Xero not recorded`,
    issue: report.issue,
    sameObject: report.sameNote,
    audit: (row) => report.audit(trace, row),
    lateObject: () => lateNoteObject(note),
    alertMessage: report.alertMessage,
    alertWarning: report.alertWarning,
  });
}

/** What {@link traceLateXeroObject} is told about one late Xero object and how its caller reports it. */
export interface LateXeroObjectTrace {
  operationId: string;
  /** The object's Xero id, compared with the id the re-read row records. */
  xeroObjectId: string;
  /** The fields every log line carries. */
  trace: Record<string, unknown>;
  /** The start of every error line, e.g. "Refund credit note from Xero not recorded". */
  notRecorded: string;
  /** The issue every error line cites. */
  issue: string;
  /** The info line when the re-read row records this very object. */
  sameObject: string;
  /**
   * PR #4708 rounds 2-3: whether a row recording this very object ends the
   * trace, given that row. Omitted, it always does. A part-success with an
   * unfinished step goes on past a SUCCEEDED row (its run may not have done the
   * step) but stops at a PARTIAL one, whose own outcome already shows it.
   */
  stopOnSameObject?: (row: XeroSyncOperation) => boolean;
  /** The caller's own audit row, given the re-read row (null when it is gone). */
  audit: (row: XeroSyncOperation | null) => Promise<void>;
  /** The object as the alert names it; read only when an alert is due. */
  lateObject: () => Promise<UnrecordedXeroObject> | UnrecordedXeroObject;
  alertMessage?: (row: XeroSyncOperation, late: UnrecordedXeroObject) => string;
  alertWarning?: string;
}

/**
 * PR #4708 review (`INV-SSOT`): the one skeleton of a late Xero object's trace,
 * shared by the late credit notes (#4426, #4655) and the part-success that
 * lost its claim (#4686, `xero-late-partial-trace.ts`): re-read the row; if it
 * records this very object, log info and stop; the caller's audit row; no
 * alert when the row is gone; else #4374's alert once per object. Each step is
 * caught and logged; the caller logs its own first warning. Never throws.
 */
export async function traceLateXeroObject(input: LateXeroObjectTrace): Promise<LateNoteTraceResult> {
  const { trace, notRecorded, issue } = input;
  let row: XeroSyncOperation | null;
  try {
    row = await prisma.xeroSyncOperation.findUnique({ where: { id: input.operationId } });
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its operation could not be re-read: no audit row or alert; this log is its only record (${issue})`);
    return { kind: "traced" };
  }
  if (row && row.xeroObjectId === input.xeroObjectId && (input.stopOnSameObject?.(row) ?? true)) {
    logger.info(trace, input.sameObject);
    return { kind: "same-note", row };
  }
  try {
    await input.audit(row);
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its audit row failed (${issue})`);
  }
  if (!row) {
    logger.error(trace, `${notRecorded}, and its operation row is gone: no alert sent (${issue})`);
    return { kind: "traced" };
  }
  try {
    const late = await input.lateObject();
    await unrecordedLateSuccessAlert(row, late, input.alertMessage?.(row, late), input.alertWarning)();
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its alert failed (${issue})`);
  }
  return { kind: "traced" };
}

/**
 * The credit note as #4374's late-object alert names it, its amount in the
 * club's money format. #4680 (`INV-SSOT`): also the stood-down organiser run's
 * alert (`traceOrganiserRunStoodDown`).
 */
export async function lateNoteObject(note: UnrecordedLateNote): Promise<UnrecordedXeroObject> {
  return {
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: note.creditNoteId,
    xeroObjectNumber: note.creditNoteNumber,
    amount: await formattedAmount(note),
    bookingId: note.bookingId,
  };
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
