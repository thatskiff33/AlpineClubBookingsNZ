/**
 * #5204: the app's view of money a contact paid the club in Xero that no invoice
 * has taken yet: receive overpayments and receive prepayments that still have a
 * balance. This module refreshes the `XeroCashCredit` snapshot from Xero and
 * reads it back as the finance queue. It is READ-ONLY toward Xero, and in this
 * release nothing turns a document into credit.
 *
 * THE REFRESH IS ALL OR NOTHING. Every page of both kinds is read before any
 * row is written; a failed or unreadable page throws and changes nothing. Only
 * after a complete read does one transaction upsert what was seen and set the
 * balance of every document the read did not return to zero. A document is
 * never deleted, because credit may come to name it, and a zero balance is what
 * Xero says of a document fully allocated or voided.
 *
 * AN OLDER READ NEVER OVERWRITES A NEWER ONE. The refresh cursor
 * (`XeroSyncCursor` "XERO_CASH_CREDITS") and each row's `syncedAt` hold when
 * the read that wrote them began. The write transaction first advances the
 * cursor, conditional on it being older than this read; the cursor's row lock
 * serialises overlapping refreshes (the nightly cron and an officer's Refresh),
 * and a read that began before the one already written writes nothing. The row
 * writes repeat the same condition on `syncedAt`. No advisory lock is taken.
 *
 * THE MEMBER IS MATCHED WHEN THE QUEUE IS READ, through `Member.xeroContactId`
 * (unique), never stored on the snapshot, so a contact linked or unlinked after
 * a refresh shows correctly at once.
 */
import type { Overpayment, Prepayment } from "xero-node";
import type { XeroCashCreditKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { utcDateOnlyString } from "@/lib/club-time/intl";
import { memberDisplayName } from "@/lib/member-serialization";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { xeroCalendarDateAsDateOnly } from "@/lib/xero-provider-dates";

/** Xero's page size for both lists; a shorter page is the last one. */
export const XERO_CASH_CREDIT_PAGE_SIZE = 100;
/** More pages than this is a read the refresh refuses rather than truncates. */
export const XERO_CASH_CREDIT_MAX_PAGES = 50;
/** Only documents Xero still holds open are listed; any other is read as spent. */
const OPEN_DOCUMENTS_WHERE = 'Status=="AUTHORISED"';
const CURSOR_RESOURCE = "XERO_CASH_CREDITS";
const CURSOR_SCOPE = "ALL";

const RECEIVE_TYPE: Record<XeroCashCreditKind, string> = {
  OVERPAYMENT: "RECEIVE-OVERPAYMENT",
  PREPAYMENT: "RECEIVE-PREPAYMENT",
};
const KINDS: readonly XeroCashCreditKind[] = ["OVERPAYMENT", "PREPAYMENT"];

export class XeroCashCreditReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroCashCreditReadError";
  }
}

/** One open document as the snapshot stores it. */
export interface XeroCashCreditDocument {
  kind: XeroCashCreditKind;
  xeroDocumentId: string;
  xeroContactId: string;
  documentDate: Date | null;
  totalCents: number;
  remainingCents: number;
}

/** Reads one page of one kind; throws on any provider failure. */
export type XeroCashCreditPageReader = (
  kind: XeroCashCreditKind,
  page: number,
) => Promise<Array<Overpayment | Prepayment>>;

async function readPageLive(kind: XeroCashCreditKind, page: number) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const options = {
    resourceType: kind,
    workflow: "xeroCashCreditRefresh",
    context: `xeroCashCreditRefresh(${kind}, page ${page})`,
    // A queue refresh must never arm the breaker that takes invoicing down.
    armTransientBreaker: false,
  };
  if (kind === "OVERPAYMENT") {
    const response = await callXeroApi(
      () => xero.accountingApi.getOverpayments(tenantId, undefined, OPEN_DOCUMENTS_WHERE, undefined, page, undefined, XERO_CASH_CREDIT_PAGE_SIZE),
      { ...options, operation: "getOverpayments" },
    );
    return response.body.overpayments ?? [];
  }
  const response = await callXeroApi(
    () => xero.accountingApi.getPrepayments(tenantId, undefined, OPEN_DOCUMENTS_WHERE, undefined, page, undefined, XERO_CASH_CREDIT_PAGE_SIZE),
    { ...options, operation: "getPrepayments" },
  );
  return response.body.prepayments ?? [];
}

function documentIdOf(kind: XeroCashCreditKind, document: Overpayment | Prepayment) {
  return kind === "OVERPAYMENT"
    ? (document as Overpayment).overpaymentID
    : (document as Prepayment).prepaymentID;
}

/**
 * A listed document as a snapshot row, or null for one that is not the club's
 * money held for a contact (a spend overpayment or prepayment, or one not open).
 * An open receive document the app cannot read fails the whole refresh.
 */
export function xeroCashCreditDocumentFrom(
  kind: XeroCashCreditKind,
  document: Overpayment | Prepayment,
): XeroCashCreditDocument | null {
  if (String(document.type) !== RECEIVE_TYPE[kind] || String(document.status) !== "AUTHORISED") return null;
  const xeroDocumentId = documentIdOf(kind, document)?.trim();
  const xeroContactId = document.contact?.contactID?.trim();
  const totalCents = providerAmountToCents(document.total);
  const remainingCents = providerAmountToCents(document.remainingCredit);
  if (!xeroDocumentId || !xeroContactId || totalCents === null || remainingCents === null || totalCents < 0 || remainingCents < 0) {
    throw new XeroCashCreditReadError(
      `Xero returned a ${kind.toLowerCase()} the app cannot read (${xeroDocumentId || "no id"}); nothing was refreshed.`,
    );
  }
  return {
    kind,
    xeroDocumentId,
    xeroContactId,
    documentDate: xeroCalendarDateAsDateOnly(document.date),
    totalCents,
    remainingCents,
  };
}

/** Every page of both kinds, or a throw; nothing is returned from a partial read. */
export async function readXeroCashCreditDocuments(
  readPage: XeroCashCreditPageReader = readPageLive,
): Promise<XeroCashCreditDocument[]> {
  const documents = new Map<string, XeroCashCreditDocument>();
  for (const kind of KINDS) {
    for (let page = 1; ; page++) {
      if (page > XERO_CASH_CREDIT_MAX_PAGES) {
        throw new XeroCashCreditReadError(
          `Xero listed more than ${XERO_CASH_CREDIT_MAX_PAGES * XERO_CASH_CREDIT_PAGE_SIZE} open ${kind.toLowerCase()}s; nothing was refreshed.`,
        );
      }
      const listed = await readPage(kind, page);
      for (const raw of listed) {
        const document = xeroCashCreditDocumentFrom(kind, raw);
        if (document) documents.set(document.xeroDocumentId, document);
      }
      if (listed.length < XERO_CASH_CREDIT_PAGE_SIZE) break;
    }
  }
  return [...documents.values()];
}

export interface XeroCashCreditSnapshotResult {
  /** Open documents the read returned. */
  open: number;
  /** Rows this refresh wrote: new, changed or re-stamped. */
  written: number;
  /** Rows the read did not return, now at a zero balance. */
  zeroed: number;
  /** False when a refresh that began later had already written; this one wrote nothing. */
  current: boolean;
}

/**
 * Write one complete read, unless a read that began later has already been
 * written, in which case nothing is written and `current` is false.
 */
export async function applyXeroCashCreditSnapshot(
  documents: XeroCashCreditDocument[],
  readStartedAt: Date,
  db: typeof prisma = prisma,
): Promise<XeroCashCreditSnapshotResult> {
  return db.$transaction(async (tx) => {
    // Claim the refresh cursor first. Its row lock serialises overlapping
    // refreshes, and a read that began before the one already written stops here,
    // writing nothing: otherwise it could re-create a document the newer read
    // found already spent.
    await tx.xeroSyncCursor.createMany({
      data: [{ resourceType: CURSOR_RESOURCE, scope: CURSOR_SCOPE }],
      skipDuplicates: true,
    });
    const claimed = await tx.xeroSyncCursor.updateMany({
      where: { resourceType: CURSOR_RESOURCE, scope: CURSOR_SCOPE, OR: [{ cursorDateTime: null }, { cursorDateTime: { lt: readStartedAt } }] },
      data: { cursorDateTime: readStartedAt, lastSuccessfulSyncAt: readStartedAt },
    });
    if (claimed.count === 0) return { open: documents.length, written: 0, zeroed: 0, current: false };

    const created = await tx.xeroCashCredit.createMany({
      data: documents.map((document) => ({ ...document, syncedAt: readStartedAt })),
      skipDuplicates: true,
    });
    let written = created.count;
    for (const { xeroDocumentId, ...fields } of documents) {
      const updated = await tx.xeroCashCredit.updateMany({
        where: { xeroDocumentId, syncedAt: { lt: readStartedAt } },
        data: { ...fields, syncedAt: readStartedAt },
      });
      written += updated.count;
    }
    const zeroed = await tx.xeroCashCredit.updateMany({
      where: { xeroDocumentId: { notIn: documents.map((document) => document.xeroDocumentId) }, syncedAt: { lt: readStartedAt } },
      data: { remainingCents: 0, syncedAt: readStartedAt },
    });
    return { open: documents.length, written, zeroed: zeroed.count, current: true };
  }, { timeout: 30_000 });
}

export interface XeroCashCreditRefreshDeps {
  db?: typeof prisma;
  readPage?: XeroCashCreditPageReader;
  /** When the read begins; the stamp every write carries. */
  now?: () => Date;
}

/** Read everything, then write it; a failed read throws having written nothing. */
export async function refreshXeroCashCredits(
  deps: XeroCashCreditRefreshDeps = {},
): Promise<XeroCashCreditSnapshotResult> {
  const readStartedAt = (deps.now ?? (() => new Date()))();
  const documents = await readXeroCashCreditDocuments(deps.readPage);
  return applyXeroCashCreditSnapshot(documents, readStartedAt, deps.db);
}

export interface XeroCashCreditQueueRow {
  id: string;
  kind: XeroCashCreditKind;
  xeroDocumentId: string;
  xeroContactId: string;
  /** `YYYY-MM-DD`, or null when Xero gave no date. */
  documentDate: string | null;
  totalCents: number;
  remainingCents: number;
  member: { id: string; name: string } | null;
}

export interface XeroCashCreditQueue {
  rows: XeroCashCreditQueueRow[];
  /** When the newest complete refresh began, or null before the first one. */
  refreshedAt: Date | null;
}

/** The open documents, oldest first, each with the member whose contact it is. */
export async function listXeroCashCreditQueue(db: typeof prisma = prisma): Promise<XeroCashCreditQueue> {
  const [documents, cursor] = await Promise.all([
    db.xeroCashCredit.findMany({
      where: { remainingCents: { gt: 0 } },
      orderBy: [{ documentDate: { sort: "asc", nulls: "last" } }, { xeroDocumentId: "asc" }],
    }),
    db.xeroSyncCursor.findUnique({
      where: { resourceType_scope: { resourceType: CURSOR_RESOURCE, scope: CURSOR_SCOPE } },
      select: { lastSuccessfulSyncAt: true },
    }),
  ]);
  const contactIds = [...new Set(documents.map((document) => document.xeroContactId))];
  const members = contactIds.length === 0 ? [] : await db.member.findMany({
    where: { xeroContactId: { in: contactIds } },
    select: { id: true, firstName: true, lastName: true, email: true, xeroContactId: true },
  });
  const memberByContact = new Map(members.map((member) => [member.xeroContactId, member]));
  return {
    refreshedAt: cursor?.lastSuccessfulSyncAt ?? null,
    rows: documents.map((document) => {
      const member = memberByContact.get(document.xeroContactId);
      return {
        id: document.id,
        kind: document.kind,
        xeroDocumentId: document.xeroDocumentId,
        xeroContactId: document.xeroContactId,
        documentDate: document.documentDate ? utcDateOnlyString(document.documentDate) : null,
        totalCents: document.totalCents,
        remainingCents: document.remainingCents,
        member: member ? { id: member.id, name: memberDisplayName(member) } : null,
      };
    }),
  };
}
