/**
 * #4336 (a follow-up to #4288): THE READ-ONLY REPORT of refund credit notes
 * that Xero says are VOIDED or DELETED while the app still holds an ACTIVE
 * link to them.
 *
 * Before #4288, an older live status read from Xero could revive the mirror of
 * a refund note that had already been voided, and the write erased the record
 * of the void, so those mirrors cannot be found from local data alone. Each one
 * can hide a whole refund: a bank refund the app counts as documented while
 * Xero credits nothing. This report asks Xero about every active link and lists
 * the cancelled ones for a person to correct by hand.
 *
 * Reads only. It writes no row and repairs nothing: the database is read with
 * two `findMany` calls, and Xero is read with `getCreditNote`, one note per
 * call (the SDK's credit-note list takes no ids filter, and a hand-built
 * `where` chain over many ids is untested against Xero's URL limits). Calls go
 * through `withXeroRetry`, which waits out a minute-limit 429 and retries a
 * transient failure; the metered `callXeroApi` is deliberately not used, as it
 * writes a usage row. The shared status predicate
 * (`xero-refund-note-status.ts`) decides what counts as cancelled, so this
 * report can never disagree with the rest of the app about it (`INV-SSOT`).
 *
 * Runbook: docs/xero/ARCHITECTURE.md, "Find refund notes Xero voided that the
 * app still shows as live (#4336)".
 */
import type { Prisma } from "@prisma/client";
import { formatBookingReference } from "@/lib/booking-reference";
import { REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { formatCentsPlain } from "@/lib/utils";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { getOperationalXeroConfig } from "@/lib/xero-config";
import { getXeroTokenReadability, type XeroTokenReadability } from "@/lib/xero-token-store";
import {
  getAuthenticatedXeroClient,
  withXeroRetry,
  XeroDailyLimitError,
  XeroReconnectRequiredError,
  XeroTransientOutageError,
} from "@/lib/xero-api-client";
import {
  isIncludedRefundCreditNoteStatus,
  readRefundCreditNoteLinkStatus,
  REFUND_CREDIT_NOTE_LINK_WHERE,
} from "@/lib/xero-refund-note-status";

/** The two refund-note roles a payment's credit-note link can carry (`INV-PAY-118` for the request's). */
export const REPORTED_REFUND_NOTE_ROLES = [REFUND_CREDIT_NOTE_LINK_WHERE.role, REFUND_REQUEST_CREDIT_NOTE_ROLE] as const;

/** What the report needs of one Xero credit note. */
export interface XeroCreditNoteReading {
  /** Xero's status, as Xero spells it, or null when it sent none. */
  status: string | null;
  number: string | null;
  /** Xero's total in cents, or null when it sent none. */
  totalCents: number | null;
}

/** `null` is "Xero has no such note". Any other failure throws. */
export type CreditNoteReader = (creditNoteId: string) => Promise<XeroCreditNoteReading | null>;

export interface VoidedRefundNoteRow {
  paymentId: string;
  bookingId: string;
  bookingReference: string;
  role: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** Xero's status for the note: VOIDED or DELETED. */
  xeroStatus: string;
  /** Xero's total, else the figure the link recorded; null when neither is known. */
  amountCents: number | null;
  /** The status the app has stored on the link, or null when none was ever recorded. */
  storedStatus: string | null;
}

export interface VoidedRefundNoteReport {
  /** Active refund-note links walked. */
  activeLinks: number;
  /** Distinct credit notes asked of Xero. */
  notesChecked: number;
  voided: VoidedRefundNoteRow[];
  /** Links whose note Xero does not have: not voided, but the link points at nothing. */
  notFound: Array<{ paymentId: string; creditNoteId: string; creditNoteNumber: string | null }>;
  /** Notes that could not be read (after retries). Their status is UNKNOWN: run the report again. */
  unreadable: Array<{ creditNoteId: string; error: string }>;
  /** Set when the run stopped early (a Xero limit, outage or lost connection), with how many notes were never asked. */
  stoppedEarly: { reason: string; notesNotChecked: number } | null;
}

type ReportDb = Pick<Prisma.TransactionClient, "xeroObjectLink" | "payment">;

/** Spacing between Xero reads: Xero allows 60 calls a minute, so one a second keeps under it. */
export const DEFAULT_XERO_READ_SPACING_MS = 1_000;

const PAYMENT_LOOKUP_PAGE = 1_000;

/**
 * Thrown by `assertXeroReadableHere` with a fixed sentence: it names no secret,
 * no value and no path, so the script can print it as it stands.
 */
export class XeroReportPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroReportPreflightError";
  }
}

export const XERO_UNREADABLE_HERE_MESSAGE =
  "Xero credentials can't be read here: run with the application's AUTH_SECRET and DATABASE_URL. See docs/MAINTENANCE.md, \"Find refund notes Xero voided that the app still shows as live (#4336)\".";

export const XERO_NOT_CONNECTED_MESSAGE =
  "Xero is not connected on this database, so there is nothing to ask. Check DATABASE_URL points at the live database, and that Xero is connected in the admin panel.";

/**
 * Resolve the Xero connection and its encryption key ONCE, before any link is
 * walked. The stored Xero login and the app's Xero client credentials are both
 * encrypted under a key rooted in `AUTH_SECRET`, so a process without the
 * app's secret cannot read them (the compose `migrate` service carries none).
 * Both checks are side-effect free: they decrypt and discard, and neither
 * generates a key, writes a row or calls Xero. Throws `XeroReportPreflightError`.
 */
export async function assertXeroReadableHere(
  deps: {
    tokenReadability?: () => Promise<XeroTokenReadability>;
    clientConfig?: () => Promise<{ clientId: string; clientSecret: string }>;
  } = {},
): Promise<void> {
  const readability = await (deps.tokenReadability ?? getXeroTokenReadability)();
  if (readability === "no_tokens") throw new XeroReportPreflightError(XERO_NOT_CONNECTED_MESSAGE);
  if (readability === "unreadable") throw new XeroReportPreflightError(XERO_UNREADABLE_HERE_MESSAGE);
  const config = await (deps.clientConfig ?? getOperationalXeroConfig)();
  // An unreadable credential resolves to "": the refresh could not authenticate.
  if (!config.clientId || !config.clientSecret) throw new XeroReportPreflightError(XERO_UNREADABLE_HERE_MESSAGE);
}

/**
 * The real reader: `getCreditNote` through `withXeroRetry` (a minute-limit 429
 * waits and retries; a daily limit throws `XeroDailyLimitError`). A 404 or an
 * empty answer is "no such note".
 */
export async function createXeroCreditNoteReader(): Promise<CreditNoteReader> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  return async (creditNoteId) => {
    try {
      const response = await withXeroRetry(() => xero.accountingApi.getCreditNote(tenantId, creditNoteId), {
        context: `xeroVoidedRefundNoteReport(${creditNoteId})`,
      });
      const note = response.body.creditNotes?.[0];
      if (!note?.creditNoteID) return null;
      return {
        status: readString(note.status),
        number: readString(note.creditNoteNumber),
        totalCents: providerAmountToCents(note.total),
      };
    } catch (error) {
      if (getXeroErrorStatusCode(error) === 404) return null;
      throw error;
    }
  };
}

function recordedAmountCents(metadata: unknown): number | null {
  const record = asRecord(metadata);
  return readNumber(record?.amountCents) ?? providerAmountToCents(readNumber(record?.total));
}

/**
 * Walk every active refund-note link, ask Xero about each distinct note once,
 * and collect the notes Xero reports cancelled. Never writes.
 */
export async function buildVoidedRefundNoteReport(input: {
  db: ReportDb;
  readCreditNote: CreditNoteReader;
  /** Waits between Xero reads. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}): Promise<VoidedRefundNoteReport> {
  const { db, readCreditNote } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spacingMs = input.spacingMs ?? DEFAULT_XERO_READ_SPACING_MS;

  const links = await db.xeroObjectLink.findMany({
    where: {
      localModel: REFUND_CREDIT_NOTE_LINK_WHERE.localModel,
      xeroObjectType: REFUND_CREDIT_NOTE_LINK_WHERE.xeroObjectType,
      role: { in: [...REPORTED_REFUND_NOTE_ROLES] },
      active: true,
    },
    select: { localId: true, xeroObjectId: true, xeroObjectNumber: true, role: true, metadata: true },
    orderBy: [{ localId: "asc" }, { xeroObjectId: "asc" }, { role: "asc" }],
  });

  const report: VoidedRefundNoteReport = {
    activeLinks: links.length,
    notesChecked: 0,
    voided: [],
    notFound: [],
    unreadable: [],
    stoppedEarly: null,
  };
  if (links.length === 0) return report;

  const bookingByPayment = new Map<string, string>();
  const paymentIds = [...new Set(links.map((link) => link.localId))];
  for (let start = 0; start < paymentIds.length; start += PAYMENT_LOOKUP_PAGE) {
    const payments = await db.payment.findMany({
      where: { id: { in: paymentIds.slice(start, start + PAYMENT_LOOKUP_PAGE) } },
      select: { id: true, bookingId: true },
    });
    for (const payment of payments) bookingByPayment.set(payment.id, payment.bookingId);
  }

  const linksByNote = new Map<string, typeof links>();
  for (const link of links) {
    const group = linksByNote.get(link.xeroObjectId) ?? [];
    group.push(link);
    linksByNote.set(link.xeroObjectId, group);
  }

  const noteIds = [...linksByNote.keys()];
  for (const [index, noteId] of noteIds.entries()) {
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);
    let reading: XeroCreditNoteReading | null;
    try {
      reading = await readCreditNote(noteId);
    } catch (error) {
      // A limit, an outage or a lost connection hits every later note alike: stop, never list hundreds of copies.
      if (error instanceof XeroDailyLimitError || error instanceof XeroTransientOutageError || error instanceof XeroReconnectRequiredError) {
        report.stoppedEarly = { reason: error.message, notesNotChecked: noteIds.length - index };
        break;
      }
      report.unreadable.push({ creditNoteId: noteId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    report.notesChecked += 1;
    for (const link of linksByNote.get(noteId) ?? []) {
      if (reading === null) {
        report.notFound.push({ paymentId: link.localId, creditNoteId: noteId, creditNoteNumber: link.xeroObjectNumber });
        continue;
      }
      // The ONE predicate for "cancelled" (`INV-SSOT`): a null or unknown status counts as live.
      if (reading.status === null || isIncludedRefundCreditNoteStatus(reading.status)) continue;
      const bookingId = bookingByPayment.get(link.localId) ?? "";
      report.voided.push({
        paymentId: link.localId,
        bookingId,
        bookingReference: bookingId ? formatBookingReference(bookingId) : "",
        role: link.role,
        creditNoteId: noteId,
        creditNoteNumber: reading.number ?? link.xeroObjectNumber,
        xeroStatus: reading.status.trim().toUpperCase(),
        amountCents: reading.totalCents ?? recordedAmountCents(link.metadata),
        storedStatus: readRefundCreditNoteLinkStatus(link.metadata),
      });
    }
  }
  return report;
}

const COLUMNS = ["paymentId", "bookingId", "bookingReference", "role", "creditNoteNumber", "creditNoteId", "amount", "xeroStatus", "appStoredStatus"] as const;

function rowCells(row: VoidedRefundNoteRow): string[] {
  return [
    row.paymentId,
    row.bookingId,
    row.bookingReference,
    row.role,
    row.creditNoteNumber ?? "",
    row.creditNoteId,
    row.amountCents === null ? "" : formatCentsPlain(row.amountCents),
    row.xeroStatus,
    row.storedStatus ?? "none recorded",
  ];
}

/** The plain-text table the owner reads. Ids, numbers and amounts only: no names, no secrets. */
export function formatVoidedRefundNoteReport(report: VoidedRefundNoteReport): string {
  const lines = [
    `Active refund-note links: ${report.activeLinks}. Credit notes asked of Xero: ${report.notesChecked}.`,
    `Reported VOIDED or DELETED by Xero while the app still links them as active: ${report.voided.length}`,
  ];
  if (report.voided.length > 0) {
    const rows = [[...COLUMNS] as string[], ...report.voided.map(rowCells)];
    const widths = COLUMNS.map((_, column) => Math.max(...rows.map((cells) => (cells[column] ?? "").length)));
    for (const [rowIndex, cells] of rows.entries()) {
      lines.push(cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
      if (rowIndex === 0) lines.push(widths.map((width) => "-".repeat(width)).join("  "));
    }
    lines.push(
      "",
      "Each is a refund the app may count as documented while Xero credits nothing. Correct it by hand;",
      "this report changes nothing.",
    );
  }
  if (report.notFound.length > 0) {
    lines.push("", `Linked but not found in Xero: ${report.notFound.length}`);
    for (const note of report.notFound) {
      lines.push(`  payment ${note.paymentId}  note ${note.creditNoteNumber ?? "(no number)"}  ${note.creditNoteId}`);
    }
  }
  if (report.unreadable.length > 0) {
    lines.push("", `COULD NOT BE READ (status unknown, run the report again): ${report.unreadable.length}`);
    for (const note of report.unreadable) lines.push(`  ${note.creditNoteId}: ${note.error}`);
  }
  if (report.stoppedEarly) {
    lines.push(
      "",
      `STOPPED EARLY - this list is INCOMPLETE: ${report.stoppedEarly.notesNotChecked} note(s) were never asked. ${report.stoppedEarly.reason}`,
    );
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  // A leading = + - @ is a spreadsheet formula, so neutralise it as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The voided notes as CSV, one row each (the same columns as the table). */
export function voidedRefundNoteReportCsv(report: VoidedRefundNoteReport): string {
  return [[...COLUMNS] as string[], ...report.voided.map(rowCells)].map((cells) => cells.map(csvCell).join(",")).join("\n") + "\n";
}

/** True when the report is the whole truth: nothing unreadable and the run did not stop early. */
export function isVoidedRefundNoteReportComplete(report: VoidedRefundNoteReport): boolean {
  return report.unreadable.length === 0 && report.stoppedEarly === null;
}
