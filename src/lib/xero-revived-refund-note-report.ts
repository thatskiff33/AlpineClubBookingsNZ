/**
 * #4336 (owner decision 24 Oct 2026, on #4288): THE READ-ONLY REPORT OF REFUND
 * CREDIT NOTES XERO SAYS ARE VOIDED OR DELETED WHILE THE APP STILL TREATS THEM
 * AS LIVE.
 *
 * Before #4288 (PR #4341), an older live reading of a refund note could be
 * written after the treasurer had voided the note in Xero, and the write erased
 * the app's record of the void. Nothing local can find those mirrors, so this
 * report asks Xero again about every note on an ACTIVE refund-note link and
 * lists each one Xero reports cancelled, for a person to correct.
 *
 * This module is the pure part: the population read, the walk over Xero with
 * the reader injected, and the text formatter. The live reader and the
 * credentials preflight live in `xero-revived-refund-note-reader.ts`.
 *
 * It writes nothing. The population is two `findMany` reads, paged, outside any
 * transaction; every definition it uses is the app's own (`INV-SSOT`): the link
 * shape and roles (`REFUND_CREDIT_NOTE_LINK_WHERE`, `REFUND_NOTE_LINK_ROLES`),
 * what counts as cancelled (`isIncludedRefundCreditNoteStatus`), the status the
 * app records (`readRefundCreditNoteLinkStatus`), the cents it counts
 * (`getRefundContributionCentsFromCreditNoteMetadata`) and a request note's
 * request (`readRefundRequestIdFromPayload`).
 *
 * Runbook: docs/MAINTENANCE.md, "Find refund notes Xero voided that the app
 * still counts (#4336)".
 */
import type { PaymentSource, Prisma } from "@prisma/client";
import { getRefundContributionCentsFromCreditNoteMetadata } from "@/lib/xero-inbound/amounts";
import { readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { formatCentsPlain } from "@/lib/utils";
import {
  isIncludedRefundCreditNoteStatus,
  readRefundCreditNoteLinkStatus,
  REFUND_CREDIT_NOTE_LINK_WHERE,
  REFUND_NOTE_LINK_ROLES,
} from "@/lib/xero-refund-note-status";

export type RefundNoteLinkRole = (typeof REFUND_NOTE_LINK_ROLES)[number];

/** One active refund-note link, joined to its payment. */
export interface ActiveRefundNoteLink {
  linkId: string;
  paymentId: string;
  /** Null only when the link names no payment that exists. */
  bookingId: string | null;
  paymentSource: PaymentSource | null;
  role: RefundNoteLinkRole;
  /** The refund request a `REFUND_REQUEST_CREDIT_NOTE` link answers for; null on the payment's own role. */
  refundRequestId: string | null;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The Xero status the app records on the link (uppercased), or null when none was ever recorded. */
  appStatus: string | null;
  /** What the app counts for this link (`getRefundContributionCentsFromCreditNoteMetadata`); null when it counts nothing. */
  countedCents: number | null;
  /** Whether `Payment.xeroRefundCreditNoteId` names this note. */
  pointerNamesNote: boolean;
}

/** What the report needs of one Xero credit note. */
export interface XeroCreditNoteReading {
  /** Xero's status as Xero spells it, or null when it sent none. */
  status: string | null;
  number: string | null;
  /** Xero's `UpdatedDateUTC`, or null when it sent none. */
  updatedAt: Date | null;
}

/** Null is "Xero has no such note". Any other failure throws. */
export type CreditNoteReader = (creditNoteId: string) => Promise<XeroCreditNoteReading | null>;

/** Why a run ended before every note was read. */
export type RevivedReportStopReason = "daily-limit" | "outage" | "reconnect" | "consecutive-failures";

/**
 * Thrown by a reader when no later read in this run can succeed either: Xero's
 * daily limit (or the app's share of it), an outage cooldown armed elsewhere,
 * or a connection that needs reconnecting. The walk stops and returns what it
 * has. The message is a fixed sentence with no secret in it.
 */
export class RevivedReportStop extends Error {
  constructor(
    readonly reason: Exclude<RevivedReportStopReason, "consecutive-failures">,
    message: string,
  ) {
    super(message);
    this.name = "RevivedReportStop";
  }
}

export interface RevivedRefundNoteRow extends ActiveRefundNoteLink {
  /** Xero's status, uppercased: VOIDED or DELETED. */
  xeroStatus: string;
  xeroUpdatedAt: string | null;
}

export interface CouldNotReadNote {
  creditNoteId: string;
  paymentIds: string[];
  /** "not-found": Xero has no such note. "no-status": Xero sent the note with no status. "failed": the read failed. */
  reason: "not-found" | "no-status" | "failed";
  /** For "failed": a short description with no secret and no member data. */
  detail: string | null;
}

export interface RevivedRefundNoteReport {
  activeLinks: number;
  /** Distinct credit notes on those links: each is asked of Xero once. */
  notesToRead: number;
  /** Notes Xero answered for (found or not found). */
  readCount: number;
  revived: RevivedRefundNoteRow[];
  couldNotRead: CouldNotReadNote[];
  /** Set when the run ended early; `notReached` holds the notes never asked. */
  stopped: { reason: RevivedReportStopReason; detail: string; notReached: string[] } | null;
  totals: { count: number; bySource: Array<{ paymentSource: PaymentSource | "UNKNOWN"; count: number; countedCents: number }> };
}

type ReportDb = Pick<Prisma.TransactionClient, "xeroObjectLink" | "payment">;

const PAGE_SIZE = 500;

/** Xero allows 60 calls a minute per organisation; one every 1.5s (40 a minute) leaves room for the app's own traffic. */
export const DEFAULT_READ_SPACING_MS = 1_500;

/** The same bound as the credit-note mirror sweep: three failed reads in a row end the run. */
export const MAX_CONSECUTIVE_READ_FAILURES = 3;

/**
 * Every ACTIVE Payment credit-note link in either refund-note role, joined to
 * its payment's booking, source and refund-note pointer. Paged by link id, so a
 * large table is never one result set. Reads only.
 */
export async function readActiveRefundNoteLinks(db: ReportDb): Promise<ActiveRefundNoteLink[]> {
  const links: Array<{ id: string; localId: string; xeroObjectId: string; xeroObjectNumber: string | null; role: string; metadata: unknown }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.xeroObjectLink.findMany({
      where: {
        localModel: REFUND_CREDIT_NOTE_LINK_WHERE.localModel,
        xeroObjectType: REFUND_CREDIT_NOTE_LINK_WHERE.xeroObjectType,
        role: { in: [...REFUND_NOTE_LINK_ROLES] },
        active: true,
      },
      select: { id: true, localId: true, xeroObjectId: true, xeroObjectNumber: true, role: true, metadata: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    links.push(...page);
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }

  const payments = new Map<string, { bookingId: string; source: PaymentSource; xeroRefundCreditNoteId: string | null }>();
  const paymentIds = [...new Set(links.map((link) => link.localId))];
  for (let start = 0; start < paymentIds.length; start += PAGE_SIZE) {
    const rows = await db.payment.findMany({
      where: { id: { in: paymentIds.slice(start, start + PAGE_SIZE) } },
      select: { id: true, bookingId: true, source: true, xeroRefundCreditNoteId: true },
    });
    for (const row of rows) payments.set(row.id, row);
  }

  return links.map((link) => {
    const payment = payments.get(link.localId);
    const role = link.role as RefundNoteLinkRole;
    return {
      linkId: link.id,
      paymentId: link.localId,
      bookingId: payment?.bookingId ?? null,
      paymentSource: payment?.source ?? null,
      role,
      refundRequestId: role === REFUND_REQUEST_CREDIT_NOTE_ROLE ? readRefundRequestIdFromPayload(link.metadata) : null,
      creditNoteId: link.xeroObjectId,
      creditNoteNumber: link.xeroObjectNumber,
      appStatus: readRefundCreditNoteLinkStatus(link.metadata),
      countedCents: getRefundContributionCentsFromCreditNoteMetadata(link.metadata),
      pointerNamesNote: payment?.xeroRefundCreditNoteId === link.xeroObjectId,
    };
  });
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function totalsOf(revived: RevivedRefundNoteRow[]): RevivedRefundNoteReport["totals"] {
  const bySource = new Map<PaymentSource | "UNKNOWN", { count: number; countedCents: number }>();
  for (const row of revived) {
    const key = row.paymentSource ?? "UNKNOWN";
    const entry = bySource.get(key) ?? { count: 0, countedCents: 0 };
    entry.count += 1;
    entry.countedCents += row.countedCents ?? 0;
    bySource.set(key, entry);
  }
  return {
    count: revived.length,
    bySource: [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([paymentSource, entry]) => ({ paymentSource, ...entry })),
  };
}

/**
 * Ask Xero about each distinct note once, paced, and sort every link into
 * revived (Xero says VOIDED or DELETED) or could-not-read. A note Xero reports
 * live is not listed. Stops on a `RevivedReportStop` from the reader, or after
 * three failed reads in a row, and returns what it has read so far.
 */
export async function classifyRevivedRefundNotes(
  links: ActiveRefundNoteLink[],
  readCreditNote: CreditNoteReader,
  options: { sleep?: (ms: number) => Promise<void>; spacingMs?: number } = {},
): Promise<RevivedRefundNoteReport> {
  const sleep = options.sleep ?? sleepFor;
  const spacingMs = options.spacingMs ?? DEFAULT_READ_SPACING_MS;
  const linksByNote = new Map<string, ActiveRefundNoteLink[]>();
  for (const link of links) linksByNote.set(link.creditNoteId, [...(linksByNote.get(link.creditNoteId) ?? []), link]);
  const noteIds = [...linksByNote.keys()].sort();

  const revived: RevivedRefundNoteRow[] = [];
  const couldNotRead: CouldNotReadNote[] = [];
  let readCount = 0;
  let consecutiveFailures = 0;
  let stopped: RevivedRefundNoteReport["stopped"] = null;

  for (const [index, noteId] of noteIds.entries()) {
    const noteLinks = linksByNote.get(noteId) ?? [];
    const paymentIds = [...new Set(noteLinks.map((link) => link.paymentId))];
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);
    let reading: XeroCreditNoteReading | null;
    try {
      reading = await readCreditNote(noteId);
    } catch (error) {
      if (error instanceof RevivedReportStop) {
        stopped = { reason: error.reason, detail: error.message, notReached: noteIds.slice(index) };
        break;
      }
      consecutiveFailures += 1;
      couldNotRead.push({ creditNoteId: noteId, paymentIds, reason: "failed", detail: error instanceof Error ? error.message : "unknown error" });
      if (consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        stopped = {
          reason: "consecutive-failures",
          detail: `${MAX_CONSECUTIVE_READ_FAILURES} reads failed in a row.`,
          notReached: noteIds.slice(index + 1),
        };
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    readCount += 1;
    if (reading === null) {
      couldNotRead.push({ creditNoteId: noteId, paymentIds, reason: "not-found", detail: null });
      continue;
    }
    if (reading.status === null) {
      couldNotRead.push({ creditNoteId: noteId, paymentIds, reason: "no-status", detail: null });
      continue;
    }
    // The ONE predicate for cancelled (`INV-SSOT`): VOIDED or DELETED.
    if (isIncludedRefundCreditNoteStatus(reading.status)) continue;
    for (const link of noteLinks) {
      revived.push({
        ...link,
        creditNoteNumber: reading.number ?? link.creditNoteNumber,
        xeroStatus: reading.status.trim().toUpperCase(),
        xeroUpdatedAt: reading.updatedAt?.toISOString() ?? null,
      });
    }
  }

  return { activeLinks: links.length, notesToRead: noteIds.length, readCount, revived, couldNotRead, stopped, totals: totalsOf(revived) };
}

/** True when the list is the whole answer: every note read and none left unread. */
export function isRevivedRefundNoteReportComplete(report: RevivedRefundNoteReport): boolean {
  return report.stopped === null && report.couldNotRead.length === 0;
}

const STOP_LABELS: Record<RevivedReportStopReason, string> = {
  "daily-limit": "Xero's daily limit, or the app's share of it, was reached",
  outage: "Xero calls are paused after an outage",
  reconnect: "Xero needs reconnecting",
  "consecutive-failures": "three reads failed in a row",
};

const READ_FAILURE_LABELS: Record<CouldNotReadNote["reason"], string> = {
  "not-found": "Xero has no such note",
  "no-status": "Xero sent no status",
  failed: "read failed",
};

function cents(value: number | null): string {
  return value === null ? "nothing" : formatCentsPlain(value);
}

/**
 * The text the owner reads. Ids, numbers, statuses and amounts only: no member
 * name, email or secret. `list` adds one entry per link and per unread note.
 */
export function formatRevivedRefundNoteReport(report: RevivedRefundNoteReport, options: { list?: boolean } = {}): string {
  const lines = [
    "Read-only: this report changed nothing.",
    `Active refund-note links: ${report.activeLinks}, on ${report.notesToRead} credit note(s). Read from Xero: ${report.readCount}.`,
    `Xero says VOIDED or DELETED, the app still has the link active: ${report.totals.count}`,
  ];
  for (const source of report.totals.bySource) {
    lines.push(`  ${source.paymentSource}: ${source.count} link(s), the app counts ${formatCentsPlain(source.countedCents)}`);
  }
  if (options.list) {
    for (const row of report.revived) {
      lines.push(
        `    payment ${row.paymentId}  booking ${row.bookingId ?? "(no such payment)"}  source ${row.paymentSource ?? "UNKNOWN"}`,
        `      role ${row.role}${row.refundRequestId ? `  refund request ${row.refundRequestId}` : ""}`,
        `      note ${row.creditNoteNumber ?? "(no number)"}  ${row.creditNoteId}`,
        `      Xero ${row.xeroStatus} (updated ${row.xeroUpdatedAt ?? "unknown"})  app records ${row.appStatus ?? "no status"}  app counts ${cents(row.countedCents)}`,
        `      Payment.xeroRefundCreditNoteId names it: ${row.pointerNamesNote ? "yes" : "no"}`,
      );
    }
  }
  lines.push(`Could not read: ${report.couldNotRead.length} credit note(s)`);
  if (options.list) {
    for (const note of report.couldNotRead) {
      lines.push(`    note ${note.creditNoteId}  ${READ_FAILURE_LABELS[note.reason]}${note.detail ? ` (${note.detail})` : ""}  payment(s) ${note.paymentIds.join(", ")}`);
    }
  }
  if (report.stopped) {
    lines.push(`STOPPED EARLY, the list is incomplete: ${STOP_LABELS[report.stopped.reason]}. ${report.stopped.notReached.length} credit note(s) not read. ${report.stopped.detail}`);
    if (options.list) lines.push(...report.stopped.notReached.map((id) => `    not read: note ${id}`));
  }
  if (!options.list && (report.totals.count > 0 || report.couldNotRead.length > 0 || report.stopped)) {
    lines.push("Run again with --list for each payment and note.");
  }
  return lines.join("\n");
}
