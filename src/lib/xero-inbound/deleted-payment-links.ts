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
 * hours (`recheckPendingDeletedPaymentLinks`). A link whose local row still has
 * a Xero operation that may run again is never retired: that retry would read
 * the link's absence as "not recorded" and send the payment again
 * (`findRerunnableOperation`); it stays marked until the operation is done. The backfill
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
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
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
import { findRerunnableOperation, type RerunnableOperation } from "./deleted-payment-holdback";

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
/** The operation that held a retire back, and when; rewritten on each check so a held link rotates to the back. */
const DELETION_CHECK_BLOCKED_BY_KEY = "deletionCheckBlockedBy";
const DELETION_CHECK_BLOCKED_AT_KEY = "deletionCheckBlockedAt";
/** When the re-check stopped asking about a link Xero never answered for; the backfill is its remedy. */
const DELETION_CHECK_GAVE_UP_AT_KEY = "deletionCheckGaveUpAt";
/** Failed answers after which the scheduled re-check stops asking on its own. */
export const MAX_DELETION_CHECK_ATTEMPTS = 5;
const DELETION_CHECK_KEYS = [
  DELETION_CHECK_PENDING_KEY,
  DELETION_CHECK_PENDING_SINCE_KEY,
  DELETION_CHECK_ATTEMPTS_KEY,
  DELETION_CHECK_BLOCKED_BY_KEY,
  DELETION_CHECK_BLOCKED_AT_KEY,
  DELETION_CHECK_GAVE_UP_AT_KEY,
];

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
 * Every entry must carry an id (an entry without one may be the very payment a
 * link names), and every counted entry - every one not already DELETED - a
 * readable amount.
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

/**
 * Whether a failed deferrable read should wait for a later run rather than be
 * judged: Xero's daily limit or outage cooldown (`called` only when the HTTP
 * request went out), a rate limit (429) or a server error. Null otherwise.
 */
export function deferrableXeroFailure(err: unknown): { called: boolean } | null {
  if (err instanceof XeroDailyLimitError || err instanceof XeroTransientOutageError) {
    return { called: !err.preHttp };
  }
  const statusCode = getXeroErrorStatusCode(err);
  return statusCode === 429 || isRetryableXeroTransientStatus(statusCode) ? { called: true } : null;
}

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
    const deferrable = deferrableXeroFailure(err);
    if (deferrable) return { confirmation: "DEFERRED", called: deferrable.called };
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

type GuardedWriteResult = { result: "written" } | { result: "unchanged" } | { result: "blocked"; operation: RerunnableOperation };

/**
 * One guarded write to an ACTIVE payment link: `change` builds the update from
 * the metadata as stored, or returns null for no write. Guarded on the row being
 * still active with that metadata, so a concurrent writer's metadata is never
 * overwritten; a lost guard re-reads and tries once more. `holdBack`, when
 * given, is asked immediately before every attempt and stops the write.
 */
async function writeActivePaymentLink(
  link: DeletedPaymentLinkRow,
  change: (metadata: unknown) => { active?: false; metadata: Record<string, unknown> } | null,
  holdBack?: () => Promise<RerunnableOperation | null>,
): Promise<GuardedWriteResult> {
  let metadata: unknown = link.metadata;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = change(metadata);
    if (!next) return { result: "unchanged" };
    const operation = holdBack ? await holdBack() : null;
    if (operation) return { result: "blocked", operation };
    const { count } = await prisma.xeroObjectLink.updateMany({
      where: { id: link.id, xeroObjectType: "PAYMENT", active: true, metadata: sameMetadata(metadata) },
      // Built here, so the write guard can see it names no `xeroObjectUrl`.
      data: { ...(next.active === false ? { active: false } : {}), metadata: next.metadata as Prisma.InputJsonValue },
    });
    if (count === 1) return { result: "written" };
    const reread = await prisma.xeroObjectLink.findUnique({
      where: { id: link.id },
      select: { active: true, metadata: true },
    });
    if (!reread?.active) return { result: "unchanged" };
    metadata = reread.metadata;
  }
  return { result: "unchanged" };
}

export type RetireResult = "retired" | "blocked" | "unchanged";

/**
 * Retire one link of a payment Xero confirmed DELETED: inactive, its recorded
 * status DELETED, every other metadata field kept but the pending marker.
 *
 * Not while its local row has an operation that may still run
 * (`findRerunnableOperation`), asked immediately before each guarded write
 * rather than in a transaction with it: nothing can make that answer wrong in
 * between. An operation leaves the set by finishing, which only makes the
 * hold-back stricter than needed; it never re-enters it (a recorded outcome is
 * final, `INV-INT-029`, and a retry claim moves FAILED/PARTIAL to RUNNING,
 * inside the set). The only new entry is a new operation, which never holds
 * this payment's link. A held link is marked pending with the operation that
 * held it, so the scheduled re-check tries again once it is done.
 * Replays write nothing.
 */
export async function retireDeletedXeroPaymentLink(link: DeletedPaymentLinkRow): Promise<RetireResult> {
  const written = await writeActivePaymentLink(
    link,
    (metadata) => ({ active: false, metadata: { ...withoutPendingMarker(metadata), status: DELETED_XERO_PAYMENT_STATUS } }),
    () => findRerunnableOperation(link),
  );
  if (written.result === "blocked") {
    await markPendingDeletionCheck(link, false, written.operation);
    logger.warn(
      { linkId: link.id, paymentId: link.xeroObjectId, operation: written.operation },
      "A payment deleted in Xero kept its link: an operation on its record may still run, and would pay again",
    );
    return "blocked";
  }
  return written.result === "written" ? "retired" : "unchanged";
}

/**
 * Mark a candidate Xero could not judge; `failedAnswer` counts an answer that
 * failed, and `blockedBy` names the operation that held a retire back.
 */
async function markPendingDeletionCheck(
  link: DeletedPaymentLinkRow,
  failedAnswer: boolean,
  blockedBy?: RerunnableOperation,
): Promise<void> {
  await writeActivePaymentLink(link, (metadata) => {
    const record = asMetadataRecord(metadata);
    if (record[DELETION_CHECK_PENDING_KEY] === true && !failedAnswer && !blockedBy) return null;
    const attempts = (typeof record[DELETION_CHECK_ATTEMPTS_KEY] === "number" ? (record[DELETION_CHECK_ATTEMPTS_KEY] as number) : 0) + (failedAnswer ? 1 : 0);
    // D5: after MAX_DELETION_CHECK_ATTEMPTS failed answers the re-check stops
    // asking on its own; the link stays active, and only a fresh inbound read
    // of its document or the backfill asks again.
    const gaveUp = attempts >= MAX_DELETION_CHECK_ATTEMPTS;
    return {
      metadata: {
        ...record,
        [DELETION_CHECK_PENDING_KEY]: !gaveUp,
        [DELETION_CHECK_PENDING_SINCE_KEY]: record[DELETION_CHECK_PENDING_SINCE_KEY] ?? new Date().toISOString(),
        [DELETION_CHECK_ATTEMPTS_KEY]: attempts,
        ...(gaveUp ? { [DELETION_CHECK_GAVE_UP_AT_KEY]: record[DELETION_CHECK_GAVE_UP_AT_KEY] ?? new Date().toISOString() } : {}),
        ...(blockedBy
          ? { [DELETION_CHECK_BLOCKED_BY_KEY]: blockedBy.id, [DELETION_CHECK_BLOCKED_AT_KEY]: new Date().toISOString() }
          : {}),
      },
    };
  });
}

/** Clear the marker once Xero says the payment is live. */
async function clearPendingDeletionCheck(link: DeletedPaymentLinkRow): Promise<void> {
  await writeActivePaymentLink(link, (metadata) =>
    DELETION_CHECK_KEYS.some((key) => key in asMetadataRecord(metadata)) ? { metadata: withoutPendingMarker(metadata) } : null,
  );
}

/**
 * A payment none of whose links may be retired now: each has an operation
 * that may still run. Asking Xero about it would spend a call for nothing, so
 * each link is marked with its operation and Xero is not asked.
 */
export async function holdBackIfEveryLinkBlocked(links: DeletedPaymentLinkRow[]): Promise<boolean> {
  const operations = await Promise.all(links.map((link) => findRerunnableOperation(link)));
  if (operations.some((operation) => !operation)) return false;
  for (const [index, link] of links.entries()) await markPendingDeletionCheck(link, false, operations[index]!);
  return true;
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
  /** Payments with a link held back by an operation on its record that may still run. */
  blocked: string[];
  /** Payments the re-check stopped asking about after `MAX_DELETION_CHECK_ATTEMPTS` failed answers. */
  gaveUp: string[];
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
    if (await holdBackIfEveryLinkBlocked(links)) {
      outcome.blocked.push(paymentId);
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
      const attempts = asMetadataRecord(links[0]?.metadata)[DELETION_CHECK_ATTEMPTS_KEY];
      if ((typeof attempts === "number" ? attempts : 0) + 1 >= MAX_DELETION_CHECK_ATTEMPTS) {
        outcome.gaveUp.push(paymentId);
        logger.error(
          { paymentId, attempts: MAX_DELETION_CHECK_ATTEMPTS },
          "Xero has not answered whether this payment was deleted; the scheduled re-check stopped asking - run the deleted-payment link backfill",
        );
      }
    } else {
      outcome.confirmedDeleted.push(paymentId);
      for (const link of links) {
        const result = await retireDeletedXeroPaymentLink(link);
        if (result === "retired") retired.push(link);
        else if (result === "blocked" && !outcome.blocked.includes(paymentId)) outcome.blocked.push(paymentId);
      }
    }
  }
  outcome.retiredLinks = retired.length;
  return { outcome, retired };
}

/** Candidate links grouped by Xero payment, so each payment is asked about once. */
export function groupByPayment<Row extends { xeroObjectId: string }>(rows: Row[]): Map<string, Row[]> {
  const byPayment = new Map<string, Row[]>();
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
    blocked: [],
    gaveUp: [],
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
  if (outcome.deferred.length > 0 || outcome.unconfirmed.length > 0 || outcome.confirmedLive.length > 0 || outcome.blocked.length > 0) {
    logger.warn(
      { document: input.document, deferred: outcome.deferred, unconfirmed: outcome.unconfirmed, confirmedLive: outcome.confirmedLive, blocked: outcome.blocked },
      "Payments missing from a Xero document were left active until Xero confirms them deleted",
    );
  }
  return outcome;
}

export type DeletedPaymentRecheckOutcome = DeletedPaymentLinkOutcome & { skipped?: true; reason?: string };

/**
 * #4531 (PR #4596 review D3): the Xero document a payment link records its
 * payment on, chosen by role. A refund payment sits on its credit note, though
 * its link also names the invoice it refunds; every other payment link names
 * its invoice. Read by the re-check (so an answer is judged against that
 * document) and by the backfill's report.
 */
export function documentNamedByLink(link: Pick<DeletedPaymentLinkRow, "role" | "metadata">): DeletedPaymentDocument | undefined {
  const metadata = asMetadataRecord(link.metadata);
  const key = link.role === REFUND_PAYMENT_ROLE ? "creditNoteId" : "invoiceId";
  const id = metadata[key];
  if (typeof id !== "string") return undefined;
  return key === "creditNoteId" ? { kind: "CREDIT_NOTE", id } : { kind: "INVOICE", id };
}

/**
 * D4: claim this run's slot before any call - create the cursor row once, or
 * move its `lastSuccessfulSyncAt` forward only if the interval has passed, in
 * one guarded write - so concurrent cycles (the cron and each webhook's kick)
 * cannot each spend the cap. A run that dies after its claim waits a full
 * interval; the links stay marked.
 */
async function claimRecheckSlot(minimumIntervalMs: number): Promise<boolean> {
  const now = new Date();
  try {
    await prisma.xeroSyncCursor.create({
      data: { resourceType: DELETED_PAYMENT_RECHECK_CURSOR_RESOURCE, scope: DEFAULT_XERO_SYNC_SCOPE, lastSuccessfulSyncAt: now },
    });
    return true;
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
  }
  const { count } = await prisma.xeroSyncCursor.updateMany({
    where: {
      resourceType: DELETED_PAYMENT_RECHECK_CURSOR_RESOURCE,
      scope: DEFAULT_XERO_SYNC_SCOPE,
      OR: [{ lastSuccessfulSyncAt: null }, { lastSuccessfulSyncAt: { lte: new Date(now.getTime() - minimumIntervalMs) } }],
    },
    data: { lastSuccessfulSyncAt: now },
  });
  return count === 1;
}

/**
 * The scheduled re-check, run by the inbound cron cycle: at most every
 * `DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS` (claimed before any call), it asks
 * Xero again about links still marked pending, least recently written first (a
 * failed answer or a held-back check rewrites the link, so one cannot starve
 * the others), under the same cap and budget gate. After
 * `MAX_DELETION_CHECK_ATTEMPTS` failed answers a link is no longer pending, and
 * only the backfill or a fresh read of its document asks again. It reads only
 * marked links: there is no sweep of all links. Provider failures defer, never
 * throw.
 */
export async function recheckPendingDeletedPaymentLinks(options?: {
  minimumIntervalMs?: number;
  session?: XeroClientSession;
}): Promise<DeletedPaymentRecheckOutcome> {
  const minimumIntervalMs = options?.minimumIntervalMs ?? DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS;
  if (!(await claimRecheckSlot(minimumIntervalMs))) {
    return { ...emptyOutcome(), skipped: true, reason: "Pending deleted-payment checks ran recently." };
  }
  const rows = await prisma.xeroObjectLink.findMany({
    where: { xeroObjectType: "PAYMENT", active: true, metadata: { path: [DELETION_CHECK_PENDING_KEY], equals: true } },
    select: { ...DELETED_PAYMENT_LINK_SELECT, xeroObjectType: true, active: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  const pending = rows.filter((row) => row.xeroObjectType === "PAYMENT" && row.active && isPendingDeletionCheck(row.metadata));
  if (pending.length === 0) return emptyOutcome();
  const { outcome, retired } = await judgeCandidatePayments({
    session: options?.session ?? (await getAuthenticatedXeroClient()),
    byPayment: groupByPayment(pending),
    expectedFor: (links) => (links[0] ? documentNamedByLink(links[0]) : undefined),
    workflow: "recheckPendingDeletedPaymentLinks",
  });
  await auditRetiredPaymentLinks(DELETED_PAYMENT_RETIRED_AUDIT_SOURCE, retired, { recheck: true });
  if (outcome.blocked.length > 0 || outcome.unconfirmed.length > 0 || outcome.deferred.length > 0) {
    logger.warn(
      { blocked: outcome.blocked, unconfirmed: outcome.unconfirmed, deferred: outcome.deferred, gaveUp: outcome.gaveUp },
      "Links pending a deleted-payment check were left active by the scheduled re-check",
    );
  }
  return outcome;
}
