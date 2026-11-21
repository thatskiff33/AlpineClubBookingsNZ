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
 * A LIST READ OVER SEVERAL PAGES CAN SKIP A DOCUMENT: one on an earlier page
 * used up mid-read shifts every later one up a place. So when a kind took more
 * than one page, each stored open document of that kind the list did not return
 * is read again by its id before it may be zeroed.
 *
 * AN OLDER READ NEVER OVERWRITES A NEWER ONE. The refresh cursor
 * (`XeroSyncCursor` "XERO_CASH_CREDITS" / "default") and each row's `syncedAt` hold when
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
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { xeroCalendarDateAsDateOnly } from "@/lib/xero-provider-dates";
import { DEFAULT_XERO_SYNC_SCOPE as CURSOR_SCOPE } from "@/lib/xero-sync-cursors";

/** Xero's page size for both lists; a shorter page is the last one. */
export const XERO_CASH_CREDIT_PAGE_SIZE = 100;
/** More pages than this is a read the refresh refuses rather than truncates. */
export const XERO_CASH_CREDIT_MAX_PAGES = 50;
/** Only documents Xero still holds open are listed; any other is read as spent. */
const OPEN_DOCUMENTS_WHERE = 'Status=="AUTHORISED"';
const CURSOR_RESOURCE = "XERO_CASH_CREDITS";

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
  currencyCode: string;
  documentDate: Date | null;
  totalCents: number;
  remainingCents: number;
}

/** How the refresh reads Xero; each throws on any provider failure. Injected in tests. */
export interface XeroCashCreditReader {
  /** One page of one kind's open documents. */
  readPage(kind: XeroCashCreditKind, page: number): Promise<Array<Overpayment | Prepayment>>;
  /** One document by id, or null when Xero has none. */
  readOne(kind: XeroCashCreditKind, xeroDocumentId: string): Promise<Overpayment | Prepayment | null>;
}

const callOptions = (kind: XeroCashCreditKind, context: string) => ({
  resourceType: kind,
  workflow: "xeroCashCreditRefresh",
  context: `xeroCashCreditRefresh(${kind}, ${context})`,
  // A queue refresh must never arm the breaker that takes invoicing down.
  armTransientBreaker: false,
});

/** A list Xero answered without the list in it is unreadable, never empty. */
function listOf<T>(kind: XeroCashCreditKind, list: T[] | undefined): T[] {
  if (!Array.isArray(list)) {
    throw new XeroCashCreditReadError(`Xero answered without a list of ${kind.toLowerCase()}s; nothing was refreshed.`);
  }
  return list;
}

const liveReader: XeroCashCreditReader = {
  async readPage(kind, page) {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const options = callOptions(kind, `page ${page}`);
    if (kind === "OVERPAYMENT") {
      const response = await callXeroApi(
        () => xero.accountingApi.getOverpayments(tenantId, undefined, OPEN_DOCUMENTS_WHERE, undefined, page, undefined, XERO_CASH_CREDIT_PAGE_SIZE),
        { ...options, operation: "getOverpayments" },
      );
      return listOf(kind, response.body.overpayments);
    }
    const response = await callXeroApi(
      () => xero.accountingApi.getPrepayments(tenantId, undefined, OPEN_DOCUMENTS_WHERE, undefined, page, undefined, XERO_CASH_CREDIT_PAGE_SIZE),
      { ...options, operation: "getPrepayments" },
    );
    return listOf(kind, response.body.prepayments);
  },
  async readOne(kind, xeroDocumentId) {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const options = callOptions(kind, xeroDocumentId);
    try {
      if (kind === "OVERPAYMENT") {
        const response = await callXeroApi(
          () => xero.accountingApi.getOverpayment(tenantId, xeroDocumentId),
          { ...options, operation: "getOverpayment" },
        );
        return listOf(kind, response.body.overpayments)[0] ?? null;
      }
      const response = await callXeroApi(
        () => xero.accountingApi.getPrepayment(tenantId, xeroDocumentId),
        { ...options, operation: "getPrepayment" },
      );
      return listOf(kind, response.body.prepayments)[0] ?? null;
    } catch (error) {
      // A 404 is Xero's definite "no such document" (removed, or a different
      // organisation now connected): it is spent, not an unreadable refresh.
      // Without this, one such row would fail every multi-page refresh.
      if (getXeroErrorStatusCode(error) === 404) return null;
      throw error;
    }
  },
};

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
  const currencyCode = document.currencyCode === undefined ? "" : String(document.currencyCode).trim();
  const totalCents = providerAmountToCents(document.total);
  const remainingCents = providerAmountToCents(document.remainingCredit);
  if (!xeroDocumentId || !xeroContactId || !currencyCode || totalCents === null || remainingCents === null || totalCents < 0 || remainingCents < 0) {
    throw new XeroCashCreditReadError(
      `Xero returned a ${kind.toLowerCase()} the app cannot read (${xeroDocumentId || "no id"}); nothing was refreshed.`,
    );
  }
  return {
    kind,
    xeroDocumentId,
    xeroContactId,
    currencyCode,
    documentDate: xeroCalendarDateAsDateOnly(document.date),
    totalCents,
    remainingCents,
  };
}

/**
 * Every open document of both kinds, or a throw; nothing is returned from a
 * partial read. Reads the stored snapshot (never writes it) to find the
 * documents a multi-page list must confirm by id.
 */
export async function readXeroCashCreditDocuments(
  reader: XeroCashCreditReader = liveReader,
  db: typeof prisma = prisma,
): Promise<XeroCashCreditDocument[]> {
  const documents = new Map<string, XeroCashCreditDocument>();
  const keep = (kind: XeroCashCreditKind, raw: Overpayment | Prepayment) => {
    const document = xeroCashCreditDocumentFrom(kind, raw);
    if (document) documents.set(document.xeroDocumentId, document);
  };
  for (const kind of KINDS) {
    let page = 1;
    for (; ; page++) {
      if (page > XERO_CASH_CREDIT_MAX_PAGES) {
        throw new XeroCashCreditReadError(
          `Xero listed more than ${XERO_CASH_CREDIT_MAX_PAGES * XERO_CASH_CREDIT_PAGE_SIZE} open ${kind.toLowerCase()}s; nothing was refreshed.`,
        );
      }
      const listed = await reader.readPage(kind, page);
      for (const raw of listed) keep(kind, raw);
      if (listed.length < XERO_CASH_CREDIT_PAGE_SIZE) break;
    }
    if (page === 1) continue;
    const unlisted = await db.xeroCashCredit.findMany({
      where: { kind, remainingCents: { gt: 0 }, xeroDocumentId: { notIn: [...documents.keys()] } },
      select: { xeroDocumentId: true },
      orderBy: { xeroDocumentId: "asc" },
    });
    for (const { xeroDocumentId } of unlisted) {
      const raw = await reader.readOne(kind, xeroDocumentId);
      if (raw) keep(kind, raw);
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
    // The cursor claim already orders refreshes, so a row already at zero is
    // left alone: `zeroed` counts documents used up since the last refresh.
    const zeroed = await tx.xeroCashCredit.updateMany({
      where: { xeroDocumentId: { notIn: documents.map((document) => document.xeroDocumentId) }, remainingCents: { gt: 0 }, syncedAt: { lt: readStartedAt } },
      data: { remainingCents: 0, syncedAt: readStartedAt },
    });
    return { open: documents.length, written, zeroed: zeroed.count, current: true };
  }, { timeout: 30_000 });
}

export interface XeroCashCreditRefreshDeps {
  db?: typeof prisma;
  reader?: XeroCashCreditReader;
  /** When the read begins; the stamp every write carries. */
  now?: () => Date;
}

/** Read everything, then write it; a failed read throws having written nothing. */
export async function refreshXeroCashCredits(
  deps: XeroCashCreditRefreshDeps = {},
): Promise<XeroCashCreditSnapshotResult> {
  const readStartedAt = (deps.now ?? (() => new Date()))();
  const documents = await readXeroCashCreditDocuments(deps.reader, deps.db);
  return applyXeroCashCreditSnapshot(documents, readStartedAt, deps.db);
}

export interface XeroCashCreditQueueRow {
  id: string;
  kind: XeroCashCreditKind;
  xeroDocumentId: string;
  xeroContactId: string;
  currencyCode: string;
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
        currencyCode: document.currencyCode,
        documentDate: document.documentDate ? utcDateOnlyString(document.documentDate) : null,
        totalCents: document.totalCents,
        remainingCents: document.remainingCents,
        member: member ? { id: member.id, name: memberDisplayName(member) } : null,
      };
    }),
  };
}
