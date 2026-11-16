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
 * This module is the population read and the walk over Xero, with the reader
 * injected. The live reader and the credentials preflight live in
 * `xero-revived-refund-note-reader.ts`, the text in
 * `xero-revived-refund-note-format.ts`, and the command line in
 * `xero-revived-refund-note-cli.ts`.
 *
 * It writes nothing. The population is two `findMany` reads, paged, outside any
 * transaction; every definition it uses is the app's own (`INV-SSOT`): the link
 * shape and roles (`REFUND_CREDIT_NOTE_LINK_WHERE`, `REFUND_NOTE_LINK_ROLES`),
 * what counts as cancelled (`isIncludedRefundCreditNoteStatus`), the status the
 * app records (`readRefundCreditNoteLinkStatus`), a link's cents
 * (`getRefundContributionCentsFromCreditNoteMetadata`), a request note's
 * request (`readRefundRequestIdFromPayload`) and the three-failure bound
 * (`MAX_CONSECUTIVE_READ_FAILURES`, shared with the credit-note mirror sweep).
 *
 * A walk can be resumed: notes are read in id order, and `resumeFrom` starts at
 * a given note, so a population larger than one day's share of Xero calls is
 * covered across several runs with no note read twice.
 *
 * Runbook: docs/MAINTENANCE.md, "Find refund notes Xero voided that the app
 * still counts (#4336)".
 */
import type { PaymentSource, Prisma } from "@prisma/client";
import { getRefundContributionCentsFromCreditNoteMetadata } from "@/lib/xero-inbound/amounts";
import { readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { MAX_CONSECUTIVE_READ_FAILURES } from "@/lib/xero-credit-note-mirror-sweep";
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
  /**
   * On the payment's own role: the cents the app counts toward its refunded
   * total (`getRefundContributionCentsFromCreditNoteMetadata`). Null on a
   * refund request's own note, which the recount never reads, and when the
   * link counts nothing.
   */
  countedCents: number | null;
  /** On a refund request's own note: the note's recorded value. Not part of any refunded total. Null otherwise. */
  requestNoteCents: number | null;
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

/** Why a run ended before every note in its scope was read. */
export type RevivedReportStopReason = "daily-limit" | "reconnect" | "consecutive-failures";

/**
 * Thrown by a reader when no later read in this run can succeed either: Xero's
 * daily limit, the app's share of it, or a connection that needs reconnecting.
 * The walk stops and returns what it has. The message is a fixed sentence with
 * no secret in it.
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

/** A resume cursor that names no note in today's population. The message is safe to print. */
export class RevivedReportCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevivedReportCursorError";
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

export interface SourceTotal {
  paymentSource: PaymentSource | "UNKNOWN";
  count: number;
  /** Cents the app counts toward refunded totals, on the payment's own refund notes. */
  countedCents: number;
  /** Refund requests' own notes, by their recorded value: not part of any refunded total. */
  requestNoteCents: number;
}

export interface RevivedRefundNoteReport {
  /** True when every note in this run's scope was read and none failed. */
  complete: boolean;
  /** What this run covers: the whole population, or the notes from `resumedFrom` on. */
  scope: { resumedFrom: string | null; notesInPopulation: number; notesInThisRun: number };
  activeLinks: number;
  /** Notes Xero answered for (found or not found) in this run. */
  readCount: number;
  /** Xero says VOIDED or DELETED while the app records a live status (or none): the ones to correct. */
  revived: RevivedRefundNoteRow[];
  /** Xero says cancelled and the app already records it; the nightly link cleanup (#4161) retires these. */
  alreadyRecordedCancelled: RevivedRefundNoteRow[];
  couldNotRead: CouldNotReadNote[];
  /** Set when the run ended early; `resumeFrom` is the first note not read, for `--resume-from`. */
  stopped: { reason: RevivedReportStopReason; detail: string; resumeFrom: string; notReached: string[] } | null;
  /** Over `revived` only, and only the notes read in this run. */
  totals: { count: number; bySource: SourceTotal[] };
}

type ReportDb = Pick<Prisma.TransactionClient, "xeroObjectLink" | "payment">;

const PAGE_SIZE = 500;

/** Xero allows 60 calls a minute per organisation; one every 1.5s (40 a minute) leaves room for the app's own traffic. */
export const DEFAULT_READ_SPACING_MS = 1_500;

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
    const isRequestNote = role === REFUND_REQUEST_CREDIT_NOTE_ROLE;
    const cents = getRefundContributionCentsFromCreditNoteMetadata(link.metadata);
    return {
      linkId: link.id,
      paymentId: link.localId,
      bookingId: payment?.bookingId ?? null,
      paymentSource: payment?.source ?? null,
      role,
      refundRequestId: isRequestNote ? readRefundRequestIdFromPayload(link.metadata) : null,
      creditNoteId: link.xeroObjectId,
      creditNoteNumber: link.xeroObjectNumber,
      appStatus: readRefundCreditNoteLinkStatus(link.metadata),
      countedCents: isRequestNote ? null : cents,
      requestNoteCents: isRequestNote ? cents : null,
      pointerNamesNote: payment?.xeroRefundCreditNoteId === link.xeroObjectId,
    };
  });
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function totalsOf(revived: RevivedRefundNoteRow[]): RevivedRefundNoteReport["totals"] {
  const bySource = new Map<PaymentSource | "UNKNOWN", SourceTotal>();
  for (const row of revived) {
    const key = row.paymentSource ?? "UNKNOWN";
    const entry = bySource.get(key) ?? { paymentSource: key, count: 0, countedCents: 0, requestNoteCents: 0 };
    entry.count += 1;
    entry.countedCents += row.countedCents ?? 0;
    entry.requestNoteCents += row.requestNoteCents ?? 0;
    bySource.set(key, entry);
  }
  return { count: revived.length, bySource: [...bySource.values()].sort((a, b) => a.paymentSource.localeCompare(b.paymentSource)) };
}

/**
 * The notes this run reads, in id order: all of them, or (`resumeFrom`) that
 * note and every later one. A cursor that names no note in today's population
 * is refused rather than guessed at, so no note is skipped.
 */
function notesInScope(allNoteIds: string[], resumeFrom: string | null): string[] {
  if (resumeFrom === null) return allNoteIds;
  const start = allNoteIds.indexOf(resumeFrom);
  if (start < 0) {
    throw new RevivedReportCursorError(
      "--resume-from names no credit note on an active refund-note link. Use the id the stopped run printed, or run the report from the start.",
    );
  }
  return allNoteIds.slice(start);
}

/**
 * Ask Xero about each distinct note in scope once, paced, and sort every link:
 * revived (Xero says cancelled, the app does not), already recorded cancelled,
 * or could-not-read. A note Xero reports live is not listed. Stops on a
 * `RevivedReportStop` from the reader, or after three failed reads in a row,
 * and returns what it has read so far.
 */
export async function classifyRevivedRefundNotes(
  links: ActiveRefundNoteLink[],
  readCreditNote: CreditNoteReader,
  options: { sleep?: (ms: number) => Promise<void>; spacingMs?: number; resumeFrom?: string | null } = {},
): Promise<RevivedRefundNoteReport> {
  const sleep = options.sleep ?? sleepFor;
  const spacingMs = options.spacingMs ?? DEFAULT_READ_SPACING_MS;
  const linksByNote = new Map<string, ActiveRefundNoteLink[]>();
  for (const link of links) linksByNote.set(link.creditNoteId, [...(linksByNote.get(link.creditNoteId) ?? []), link]);
  const allNoteIds = [...linksByNote.keys()].sort();
  const noteIds = notesInScope(allNoteIds, options.resumeFrom ?? null);

  const revived: RevivedRefundNoteRow[] = [];
  const alreadyRecordedCancelled: RevivedRefundNoteRow[] = [];
  const couldNotRead: CouldNotReadNote[] = [];
  let readCount = 0;
  let consecutiveFailures = 0;
  let stopped: RevivedRefundNoteReport["stopped"] = null;
  const stopAt = (reason: RevivedReportStopReason, detail: string, index: number) => {
    const notReached = noteIds.slice(index);
    stopped = notReached.length > 0 ? { reason, detail, resumeFrom: notReached[0]!, notReached } : null;
  };

  for (const [index, noteId] of noteIds.entries()) {
    const noteLinks = linksByNote.get(noteId) ?? [];
    const paymentIds = [...new Set(noteLinks.map((link) => link.paymentId))];
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);
    let reading: XeroCreditNoteReading | null;
    try {
      reading = await readCreditNote(noteId);
    } catch (error) {
      if (error instanceof RevivedReportStop) {
        stopAt(error.reason, error.message, index);
        break;
      }
      consecutiveFailures += 1;
      couldNotRead.push({ creditNoteId: noteId, paymentIds, reason: "failed", detail: error instanceof Error ? error.message : "unknown error" });
      if (consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        stopAt("consecutive-failures", `${MAX_CONSECUTIVE_READ_FAILURES} reads failed in a row.`, index + 1);
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
      const row = {
        ...link,
        creditNoteNumber: reading.number ?? link.creditNoteNumber,
        xeroStatus: reading.status.trim().toUpperCase(),
        xeroUpdatedAt: reading.updatedAt?.toISOString() ?? null,
      };
      // The same predicate on the app's own record: a link that already says cancelled is the #4161 heal's.
      const appRecordsCancelled = link.appStatus !== null && !isIncludedRefundCreditNoteStatus(link.appStatus);
      (appRecordsCancelled ? alreadyRecordedCancelled : revived).push(row);
    }
  }

  return {
    complete: stopped === null && couldNotRead.length === 0,
    scope: { resumedFrom: options.resumeFrom ?? null, notesInPopulation: allNoteIds.length, notesInThisRun: noteIds.length },
    activeLinks: links.length,
    readCount,
    revived,
    alreadyRecordedCancelled,
    couldNotRead,
    stopped,
    totals: totalsOf(revived),
  };
}
