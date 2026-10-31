/**
 * #4531 (`INV-INT-031`): retiring the link of a payment Xero has deleted.
 *
 * Xero leaves a deleted payment out of its invoice's (or credit note's)
 * `Payments`, so the inbound reconcile, which writes links only for the
 * payments a payload names, never saw one again: its link stayed active, and
 * a hand re-entry (deleted, then entered again) left a document "paid twice".
 *
 * Absence only nominates a CANDIDATE: an active link of a role the document's
 * own reconcile writes. A payload that cannot be trusted to list every payment
 * nominates none, and a candidate is retired only once Xero says the payment
 * itself is DELETED (`GET /Payments/{id}`). The confirmation is a deferrable
 * call: one attempt, no waiting, capped per run, and spent only below the usage
 * panel's "critical" threshold. A candidate that could not be judged is marked
 * pending, and the inbound cron cycle re-checks marked links at most every six
 * hours (`recheckPendingDeletedPaymentLinks`); the backfill
 * (`xero-deleted-payment-link-backfill.ts`) covers the rest. Nothing here runs
 * inside a transaction; every link write is one guarded statement.
 */
import type { CreditNote, Invoice } from "xero-node";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  isRetryableXeroTransientStatus,
  XeroDailyLimitError,
  XeroTransientOutageError,
} from "@/lib/xero-api-client";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { xeroDailyBudgetAllowsDeferrableCall } from "@/lib/xero-api-usage";
import { getXeroSyncCursor, upsertXeroSyncCursor } from "@/lib/xero-sync-cursors";
import { quantifyXeroInvoiceCashCents } from "./invoice-paid-effects";
import { sumListedXeroPaymentCents } from "./amounts";
import { DEFAULT_XERO_SYNC_SCOPE, DELETED_PAYMENT_RECHECK_CURSOR_RESOURCE } from "./constants";
import {
  DELETED_XERO_PAYMENT_STATUS,
  INVOICE_DERIVED_PAYMENT_ROLES,
  isDeletedXeroPaymentStatus,
  REFUND_PAYMENT_ROLE,
} from "./object-links";
import { writeXeroInboundAuditLogs } from "./audit";

/** The most payments one reconcile asks Xero about; the rest wait for the next. */
export const MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE = 5;

/** The audit source naming a link retired because Xero deleted its payment. */
export const DELETED_PAYMENT_RETIRED_AUDIT_SOURCE = "xero-inbound-deleted-payment-retired";
/** The summary every retire's audit row carries, so the row says what happened. */
export const DELETED_PAYMENT_RETIRED_AUDIT_SUMMARY = "Xero payment link retired: payment deleted in Xero";

/** The least time between two scheduled re-checks of links still pending a deletion check. */
export const DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The marker on a candidate link Xero could not be asked about, or did not
 * answer for: `true`, when it was first marked, and how many answers failed.
 * It lives in the link's own metadata, is cleared when Xero says the payment
 * is live, and goes with the retire.
 */
export const DELETION_CHECK_PENDING_KEY = "deletionCheckPending";
const DELETION_CHECK_PENDING_SINCE_KEY = "deletionCheckPendingSince";
const DELETION_CHECK_ATTEMPTS_KEY = "deletionCheckAttempts";
const DELETION_CHECK_KEYS = [DELETION_CHECK_PENDING_KEY, DELETION_CHECK_PENDING_SINCE_KEY, DELETION_CHECK_ATTEMPTS_KEY];

type XeroClientSession = Awaited<ReturnType<typeof getAuthenticatedXeroClient>>;

type PayloadPayment = {
  paymentID?: string;
  amount?: number;
  status?: unknown;
};

/** The Xero document whose payments are being compared, and the link metadata key that names it. */
export type DeletedPaymentDocument =
  | { kind: "INVOICE"; id: string }
  | { kind: "CREDIT_NOTE"; id: string };

export type PaymentsForAbsence =
  | { trusted: true; presentIds: Set<string> }
  | { trusted: false; reason: string };

function metadataKeyFor(document: DeletedPaymentDocument): "invoiceId" | "creditNoteId" {
  return document.kind === "INVOICE" ? "invoiceId" : "creditNoteId";
}

/**
 * The payment roles the document's own reconcile writes, so only these are its
 * candidates: an invoice's (`INVOICE_DERIVED_PAYMENT_ROLES`), or a credit
 * note's refund payments. A refund payment's link also names the invoice it
 * refunds, but the payment sits on the credit note, never in the invoice.
 */
export function deletedPaymentCandidateRoles(document: DeletedPaymentDocument): readonly string[] {
  return document.kind === "INVOICE" ? INVOICE_DERIVED_PAYMENT_ROLES : [REFUND_PAYMENT_ROLE];
}

/**
 * The payments a payload lists, or why it cannot be trusted to list them all.
 * Every entry must carry an id and a readable amount: an entry without an id
 * may be the very payment a link names.
 */
function listedPayments(payments: PayloadPayment[] | undefined | null): PaymentsForAbsence & { cents?: number } {
  if (!Array.isArray(payments)) {
    return { trusted: false, reason: "The payload carries no Payments list." };
  }
  const presentIds = new Set<string>();
  for (const payment of payments) {
    if (!payment?.paymentID) {
      return { trusted: false, reason: "A listed payment has no PaymentID." };
    }
    presentIds.add(payment.paymentID);
  }
  const sum = sumListedXeroPaymentCents(payments);
  if (!sum.complete) {
    return { trusted: false, reason: "A listed payment has no readable amount." };
  }
  return { trusted: true, presentIds, cents: sum.cents };
}

/**
 * An invoice payload's payments, when it can be trusted for absence. Beyond a
 * complete list, the module's own degraded-shape guard must find the cash
 * complete (`quantifyXeroInvoiceCashCents`), and a finite `AmountPaid` must
 * equal the listed payments' sum, so a truncated list nominates nothing.
 */
export function invoicePaymentsForAbsence(invoice: Invoice): PaymentsForAbsence {
  const listed = listedPayments(invoice.payments as PayloadPayment[] | undefined);
  if (!listed.trusted) return listed;
  if (!quantifyXeroInvoiceCashCents(invoice).complete) {
    return { trusted: false, reason: "The invoice's cash figures are incomplete." };
  }
  const amountPaidCents = providerAmountToCents(invoice.amountPaid);
  if (amountPaidCents !== null && amountPaidCents !== listed.cents) {
    return { trusted: false, reason: "AmountPaid does not equal the listed payments." };
  }
  return { trusted: true, presentIds: listed.presentIds };
}

/** A credit note payload's refund payments, when it can be trusted for absence. */
export function creditNotePaymentsForAbsence(creditNote: CreditNote): PaymentsForAbsence {
  const listed = listedPayments(creditNote.payments as PayloadPayment[] | undefined);
  if (!listed.trusted) return listed;
  return { trusted: true, presentIds: listed.presentIds };
}

export type DeletedPaymentConfirmation = "DELETED" | "LIVE" | "UNCONFIRMED" | "DEFERRED";

/** A read that can always wait: no retry, no backoff sleep, no global outage breaker. */
export const DEFERRABLE_XERO_READ = { maxRetries: 0, maxTransientRetries: 0, armTransientBreaker: false } as const;

/**
 * Ask Xero whether one payment is deleted. Shared by the inbound reconcile, the
 * scheduled re-check and the backfill. One attempt, never a wait or a retry:
 * this call can always be made later, so a rate limit (429) or a server error
 * defers it rather than sleeping inside a reconcile, and it never arms the
 * process-wide outage breaker that would stop all other Xero work. DEFERRED
 * means no answer may be sought now (that, the daily budget gate, or Xero's
 * daily-limit or outage cooldown) and the caller stops asking; UNCONFIRMED
 * means this one payment could not be judged. A payment whose document Xero
 * names, when it is not the expected one, is never DELETED here.
 */
export async function confirmXeroPaymentDeleted(
  session: XeroClientSession,
  paymentId: string,
  input: { workflow: string; expected?: DeletedPaymentDocument },
): Promise<{ confirmation: DeletedPaymentConfirmation; called: boolean }> {
  try {
    if (!(await xeroDailyBudgetAllowsDeferrableCall())) {
      return { confirmation: "DEFERRED", called: false };
    }
  } catch (err) {
    logger.warn({ err, paymentId }, "Could not read today's Xero usage; the deleted-payment check waits");
    return { confirmation: "DEFERRED", called: false };
  }

  let payment: { paymentID?: string; status?: unknown; invoice?: { invoiceID?: string }; creditNote?: { creditNoteID?: string } } | undefined;
  try {
    const response = await callXeroApi(
      () => session.xero.accountingApi.getPayment(session.tenantId, paymentId),
      {
        operation: "getPayment",
        resourceType: "PAYMENT",
        workflow: input.workflow,
        context: `${input.workflow}(${paymentId})`,
        ...DEFERRABLE_XERO_READ,
      },
    );
    payment = response.body.payments?.[0];
  } catch (err) {
    if (err instanceof XeroDailyLimitError || err instanceof XeroTransientOutageError) {
      return { confirmation: "DEFERRED", called: !err.preHttp };
    }
    const statusCode = getXeroErrorStatusCode(err);
    if (statusCode === 429 || isRetryableXeroTransientStatus(statusCode)) {
      return { confirmation: "DEFERRED", called: true };
    }
    logger.warn({ err, paymentId }, "Xero did not answer whether a payment was deleted");
    return { confirmation: "UNCONFIRMED", called: true };
  }

  if (payment?.paymentID !== paymentId) return { confirmation: "UNCONFIRMED", called: true };
  if (!isDeletedXeroPaymentStatus(payment.status)) return { confirmation: "LIVE", called: true };
  const expected = input.expected;
  const namedDocumentId =
    expected?.kind === "INVOICE" ? payment.invoice?.invoiceID : expected?.kind === "CREDIT_NOTE" ? payment.creditNote?.creditNoteID : undefined;
  if (expected && namedDocumentId && namedDocumentId !== expected.id) {
    return { confirmation: "UNCONFIRMED", called: true };
  }
  return { confirmation: "DELETED", called: true };
}

/** A payment link as the retire reads and guards it. */
export type DeletedPaymentLinkRow = {
  id: string;
  localModel: string;
  localId: string;
  role: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  metadata: unknown;
};

export const DELETED_PAYMENT_LINK_SELECT = {
  id: true,
  localModel: true,
  localId: true,
  role: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  metadata: true,
} as const;

function asMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * The guard that the stored metadata is still exactly what was read. Compared
 * as a value, not by `updatedAt`: two writes in one millisecond share a
 * timestamp, and the real-database proof caught exactly that overwrite.
 */
function sameMetadata(metadata: unknown): Prisma.JsonNullableFilter<"XeroObjectLink"> {
  return metadata === null || metadata === undefined
    ? { equals: Prisma.AnyNull }
    : { equals: metadata as Prisma.InputJsonValue };
}

function withoutPendingMarker(metadata: unknown): Record<string, unknown> {
  const record = { ...asMetadataRecord(metadata) };
  for (const key of DELETION_CHECK_KEYS) delete record[key];
  return record;
}

function isPendingDeletionCheck(metadata: unknown): boolean {
  return asMetadataRecord(metadata)[DELETION_CHECK_PENDING_KEY] === true;
}

/**
 * One guarded write to an ACTIVE payment link: `change` builds the update from
 * the metadata as stored, or returns null for no write. Guarded on the row being
 * still active with that metadata, so a concurrent writer's metadata is never
 * overwritten; a lost guard re-reads and tries once more. Returns whether it wrote.
 */
async function writeActivePaymentLink(
  link: DeletedPaymentLinkRow,
  change: (metadata: unknown) => { active?: false; metadata: Record<string, unknown> } | null,
): Promise<boolean> {
  let metadata: unknown = link.metadata;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = change(metadata);
    if (!next) return false;
    const { count } = await prisma.xeroObjectLink.updateMany({
      where: { id: link.id, xeroObjectType: "PAYMENT", active: true, metadata: sameMetadata(metadata) },
      // Built here, so the write guard can see it names no `xeroObjectUrl`.
      data: { ...(next.active === false ? { active: false } : {}), metadata: next.metadata as Prisma.InputJsonValue },
    });
    if (count === 1) return true;
    const reread = await prisma.xeroObjectLink.findUnique({
      where: { id: link.id },
      select: { active: true, metadata: true },
    });
    if (!reread?.active) return false;
    metadata = reread.metadata;
  }
  return false;
}

/**
 * Retire one link of a payment Xero confirmed DELETED: inactive, its recorded
 * status DELETED, every other metadata field kept but the pending marker.
 * Replays write nothing. Returns whether this call retired it.
 */
export async function retireDeletedXeroPaymentLink(link: DeletedPaymentLinkRow): Promise<boolean> {
  return writeActivePaymentLink(link, (metadata) => ({
    active: false,
    metadata: { ...withoutPendingMarker(metadata), status: DELETED_XERO_PAYMENT_STATUS },
  }));
}

/** Mark a candidate Xero could not judge; `failedAnswer` counts an answer that failed. */
async function markPendingDeletionCheck(link: DeletedPaymentLinkRow, failedAnswer: boolean): Promise<void> {
  await writeActivePaymentLink(link, (metadata) => {
    const record = asMetadataRecord(metadata);
    if (record[DELETION_CHECK_PENDING_KEY] === true && !failedAnswer) return null;
    const attempts = typeof record[DELETION_CHECK_ATTEMPTS_KEY] === "number" ? (record[DELETION_CHECK_ATTEMPTS_KEY] as number) : 0;
    return {
      metadata: {
        ...record,
        [DELETION_CHECK_PENDING_KEY]: true,
        [DELETION_CHECK_PENDING_SINCE_KEY]: record[DELETION_CHECK_PENDING_SINCE_KEY] ?? new Date().toISOString(),
        [DELETION_CHECK_ATTEMPTS_KEY]: attempts + (failedAnswer ? 1 : 0),
      },
    };
  });
}

/** Clear the marker once Xero says the payment is live. */
async function clearPendingDeletionCheck(link: DeletedPaymentLinkRow): Promise<void> {
  await writeActivePaymentLink(link, (metadata) =>
    isPendingDeletionCheck(metadata) ? { metadata: withoutPendingMarker(metadata) } : null,
  );
}

export type DeletedPaymentLinkOutcome = {
  /** Why nothing was nominated, when the payload could not be trusted. */
  skippedReason?: string;
  candidatePayments: number;
  xeroCalls: number;
  confirmedDeleted: string[];
  confirmedLive: string[];
  unconfirmed: string[];
  deferred: string[];
  retiredLinks: number;
};

/**
 * Ask Xero about each candidate payment, up to the cap, and act on the answer:
 * retire on DELETED, clear the marker on LIVE, mark on UNCONFIRMED or DEFERRED.
 * The inbound reconcile and the scheduled re-check share it.
 */
async function judgeCandidatePayments(input: {
  session: XeroClientSession;
  byPayment: Map<string, DeletedPaymentLinkRow[]>;
  expectedFor: (links: DeletedPaymentLinkRow[]) => DeletedPaymentDocument | undefined;
  workflow: string;
}): Promise<{ outcome: DeletedPaymentLinkOutcome; retired: DeletedPaymentLinkRow[] }> {
  const outcome = emptyOutcome();
  outcome.candidatePayments = input.byPayment.size;
  const retired: DeletedPaymentLinkRow[] = [];
  let stop = false;
  for (const [paymentId, links] of input.byPayment) {
    if (stop || outcome.xeroCalls >= MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE) {
      outcome.deferred.push(paymentId);
      for (const link of links) await markPendingDeletionCheck(link, false);
      continue;
    }
    const { confirmation, called } = await confirmXeroPaymentDeleted(input.session, paymentId, {
      workflow: input.workflow,
      expected: input.expectedFor(links),
    });
    if (called) outcome.xeroCalls += 1;
    if (confirmation === "DEFERRED") {
      stop = true;
      outcome.deferred.push(paymentId);
      for (const link of links) await markPendingDeletionCheck(link, false);
    } else if (confirmation === "LIVE") {
      outcome.confirmedLive.push(paymentId);
      for (const link of links) await clearPendingDeletionCheck(link);
    } else if (confirmation === "UNCONFIRMED") {
      outcome.unconfirmed.push(paymentId);
      for (const link of links) await markPendingDeletionCheck(link, true);
    } else {
      outcome.confirmedDeleted.push(paymentId);
      for (const link of links) {
        if (await retireDeletedXeroPaymentLink(link)) retired.push(link);
      }
    }
  }
  outcome.retiredLinks = retired.length;
  return { outcome, retired };
}

function groupByPayment(rows: DeletedPaymentLinkRow[]): Map<string, DeletedPaymentLinkRow[]> {
  const byPayment = new Map<string, DeletedPaymentLinkRow[]>();
  for (const row of rows) {
    byPayment.set(row.xeroObjectId, [...(byPayment.get(row.xeroObjectId) ?? []), row]);
  }
  return byPayment;
}

/** Audit rows for the links a run retired, saying so in their summary. */
export async function auditRetiredPaymentLinks(source: string, retired: DeletedPaymentLinkRow[], metadata: Record<string, unknown>) {
  await writeXeroInboundAuditLogs({
    source,
    summary: DELETED_PAYMENT_RETIRED_AUDIT_SUMMARY,
    links: retired.map((link) => ({
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: "PAYMENT",
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      role: link.role,
    })),
    metadata: { ...metadata, status: DELETED_XERO_PAYMENT_STATUS },
  });
}

function emptyOutcome(skippedReason?: string): DeletedPaymentLinkOutcome {
  return {
    ...(skippedReason ? { skippedReason } : {}),
    candidatePayments: 0,
    xeroCalls: 0,
    confirmedDeleted: [],
    confirmedLive: [],
    unconfirmed: [],
    deferred: [],
    retiredLinks: 0,
  };
}

/**
 * At inbound reconcile: retire the active payment links of `document` whose
 * payment its payload no longer lists and Xero confirms DELETED. `localScope`
 * is the document's related local rows, which every link written for its
 * payments belongs to. Provider failures defer, never throw; a database
 * failure throws like any other link write, so the event is retried.
 */
export async function retireDeletedPaymentLinksAbsentFromPayload(input: {
  session: XeroClientSession;
  document: DeletedPaymentDocument;
  payments: PaymentsForAbsence;
  localScope: Array<{ localModel: string; localId: string }>;
}): Promise<DeletedPaymentLinkOutcome> {
  if (!input.payments.trusted) return emptyOutcome(input.payments.reason);
  if (input.localScope.length === 0) return emptyOutcome();

  const key = metadataKeyFor(input.document);
  const roles = deletedPaymentCandidateRoles(input.document);
  const presentIds = input.payments.presentIds;
  const rows = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "PAYMENT",
      active: true,
      role: { in: [...roles] },
      metadata: { path: [key], equals: input.document.id },
      xeroObjectId: { notIn: [...presentIds] },
      OR: input.localScope.map(({ localModel, localId }) => ({ localModel, localId })),
    },
    select: { ...DELETED_PAYMENT_LINK_SELECT, xeroObjectType: true, active: true },
    orderBy: { id: "asc" },
  });
  // The query says all of this; it is re-checked so no other row can be retired.
  const candidates = rows.filter(
    (row) =>
      row.xeroObjectType === "PAYMENT" &&
      row.active &&
      roles.includes(row.role) &&
      asMetadataRecord(row.metadata)[key] === input.document.id &&
      !presentIds.has(row.xeroObjectId),
  );

  const { outcome, retired } = await judgeCandidatePayments({
    session: input.session,
    byPayment: groupByPayment(candidates),
    expectedFor: () => input.document,
    workflow: "retireDeletedXeroPaymentLinks",
  });
  await auditRetiredPaymentLinks(DELETED_PAYMENT_RETIRED_AUDIT_SOURCE, retired, { [key]: input.document.id });
  if (outcome.deferred.length > 0 || outcome.unconfirmed.length > 0 || outcome.confirmedLive.length > 0) {
    logger.warn(
      { document: input.document, deferred: outcome.deferred, unconfirmed: outcome.unconfirmed, confirmedLive: outcome.confirmedLive },
      "Payments missing from a Xero document were left active until Xero confirms them deleted",
    );
  }
  return outcome;
}

export type DeletedPaymentRecheckOutcome = DeletedPaymentLinkOutcome & { skipped?: true; reason?: string };

/** The document a pending link names, so its answer is judged against it. */
function documentNamedBy(links: DeletedPaymentLinkRow[]): DeletedPaymentDocument | undefined {
  const metadata = asMetadataRecord(links[0]?.metadata);
  if (typeof metadata.invoiceId === "string") return { kind: "INVOICE", id: metadata.invoiceId };
  if (typeof metadata.creditNoteId === "string") return { kind: "CREDIT_NOTE", id: metadata.creditNoteId };
  return undefined;
}

/**
 * The scheduled re-check, run by the inbound cron cycle: at most every
 * `DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS`, it asks Xero again about links
 * still marked pending, least recently written first (a failed answer rewrites
 * the link, so a payment Xero never answers for cannot starve the others),
 * under the same cap and budget gate. It reads only marked links: there is no
 * sweep of all links. Provider failures defer, never throw.
 */
export async function recheckPendingDeletedPaymentLinks(options?: {
  minimumIntervalMs?: number;
  session?: XeroClientSession;
}): Promise<DeletedPaymentRecheckOutcome> {
  const minimumIntervalMs = options?.minimumIntervalMs ?? DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS;
  const cursor = await getXeroSyncCursor(DELETED_PAYMENT_RECHECK_CURSOR_RESOURCE, DEFAULT_XERO_SYNC_SCOPE);
  if (minimumIntervalMs > 0 && cursor?.lastSuccessfulSyncAt && Date.now() - cursor.lastSuccessfulSyncAt.getTime() < minimumIntervalMs) {
    return { ...emptyOutcome(), skipped: true, reason: "Pending deleted-payment checks ran recently." };
  }
  const rows = await prisma.xeroObjectLink.findMany({
    where: { xeroObjectType: "PAYMENT", active: true, metadata: { path: [DELETION_CHECK_PENDING_KEY], equals: true } },
    select: { ...DELETED_PAYMENT_LINK_SELECT, xeroObjectType: true, active: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  const pending = rows.filter((row) => row.xeroObjectType === "PAYMENT" && row.active && isPendingDeletionCheck(row.metadata));
  let result: { outcome: DeletedPaymentLinkOutcome; retired: DeletedPaymentLinkRow[] } = { outcome: emptyOutcome(), retired: [] };
  if (pending.length > 0) {
    result = await judgeCandidatePayments({
      session: options?.session ?? (await getAuthenticatedXeroClient()),
      byPayment: groupByPayment(pending),
      expectedFor: documentNamedBy,
      workflow: "recheckPendingDeletedPaymentLinks",
    });
    await auditRetiredPaymentLinks(DELETED_PAYMENT_RETIRED_AUDIT_SOURCE, result.retired, { recheck: true });
  }
  await upsertXeroSyncCursor({
    resourceType: DELETED_PAYMENT_RECHECK_CURSOR_RESOURCE,
    scope: DEFAULT_XERO_SYNC_SCOPE,
    lastSuccessfulSyncAt: new Date(),
  });
  return result.outcome;
}
