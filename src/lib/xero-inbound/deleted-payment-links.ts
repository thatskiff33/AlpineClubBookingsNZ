/**
 * #4531 (`INV-INT-031`): retiring the link of a payment Xero has deleted.
 *
 * Xero leaves a deleted payment out of its invoice's (or credit note's)
 * `Payments`, so the inbound reconcile, which writes links only for the
 * payments a payload names, never saw one again: its link stayed active, and
 * a hand re-entry (deleted, then entered again) left a document "paid twice".
 *
 * Absence only nominates a CANDIDATE. A payload that cannot be trusted to list
 * every payment nominates none, and a candidate is retired only once Xero says
 * the payment itself is DELETED (`GET /Payments/{id}`). The confirmation is a
 * deferrable call: it is capped per reconcile and spends the daily budget only
 * below the usage panel's "critical" threshold, and a deferred or unanswered
 * candidate simply stays active for the next re-read or the backfill
 * (`xero-deleted-payment-link-backfill.ts`). Nothing here runs inside a
 * transaction; the retire is one guarded statement per link.
 */
import type { CreditNote, Invoice } from "xero-node";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  callXeroApi,
  XeroDailyLimitError,
  XeroTransientOutageError,
  type getAuthenticatedXeroClient,
} from "@/lib/xero-api-client";
import { xeroDailyBudgetAllowsDeferrableCall } from "@/lib/xero-api-usage";
import { quantifyXeroInvoiceCashCents } from "./invoice-paid-effects";
import { DELETED_XERO_PAYMENT_STATUS, isDeletedXeroPaymentStatus } from "./object-links";
import { writeXeroInboundAuditLogs } from "./audit";

/** The most payments one reconcile asks Xero about; the rest wait for the next. */
export const MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE = 5;

/** The audit source naming a link retired because Xero deleted its payment. */
export const DELETED_PAYMENT_RETIRED_AUDIT_SOURCE = "xero-inbound-deleted-payment-retired";

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
 * The payments a payload lists, or why it cannot be trusted to list them all.
 * Every entry must carry an id and a readable amount: an entry without an id
 * may be the very payment a link names.
 */
function listedPayments(payments: PayloadPayment[] | undefined | null): PaymentsForAbsence & { cents?: number } {
  if (!Array.isArray(payments)) {
    return { trusted: false, reason: "The payload carries no Payments list." };
  }
  const presentIds = new Set<string>();
  let cents = 0;
  for (const payment of payments) {
    if (!payment?.paymentID) {
      return { trusted: false, reason: "A listed payment has no PaymentID." };
    }
    const paymentCents = providerAmountToCents(payment.amount);
    if (paymentCents === null) {
      return { trusted: false, reason: `Payment ${payment.paymentID} has no readable amount.` };
    }
    presentIds.add(payment.paymentID);
    if (!isDeletedXeroPaymentStatus(payment.status)) cents += paymentCents;
  }
  return { trusted: true, presentIds, cents };
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
 * Ask Xero whether one payment is deleted. Shared by the inbound reconcile and
 * the backfill. DEFERRED means no answer may be sought now (the daily budget
 * gate, or Xero's daily-limit or outage cooldown) and the caller stops asking;
 * UNCONFIRMED means this one payment could not be judged. A payment whose
 * document Xero names, when it is not the expected one, is never DELETED here.
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
      },
    );
    payment = response.body.payments?.[0];
  } catch (err) {
    if (err instanceof XeroDailyLimitError || err instanceof XeroTransientOutageError) {
      return { confirmation: "DEFERRED", called: !err.preHttp };
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

/**
 * Retire one link of a payment Xero confirmed DELETED: inactive, its recorded
 * status DELETED, every other metadata field kept. The write is guarded on the
 * row being still active with the metadata it was read with, so a concurrent
 * writer's metadata is never overwritten; a lost guard re-reads and tries once
 * more. Replays write nothing. Returns whether this call retired it.
 */
export async function retireDeletedXeroPaymentLink(link: DeletedPaymentLinkRow): Promise<boolean> {
  let metadata: unknown = link.metadata;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { count } = await prisma.xeroObjectLink.updateMany({
      where: { id: link.id, xeroObjectType: "PAYMENT", active: true, metadata: sameMetadata(metadata) },
      data: {
        active: false,
        metadata: { ...asMetadataRecord(metadata), status: DELETED_XERO_PAYMENT_STATUS },
      },
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
  const presentIds = input.payments.presentIds;
  const rows = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "PAYMENT",
      active: true,
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
      asMetadataRecord(row.metadata)[key] === input.document.id &&
      !presentIds.has(row.xeroObjectId),
  );
  const byPayment = new Map<string, DeletedPaymentLinkRow[]>();
  for (const row of candidates) {
    byPayment.set(row.xeroObjectId, [...(byPayment.get(row.xeroObjectId) ?? []), row]);
  }

  const outcome = emptyOutcome();
  outcome.candidatePayments = byPayment.size;
  const retired: DeletedPaymentLinkRow[] = [];
  let stop = false;
  for (const [paymentId, links] of byPayment) {
    if (stop || outcome.xeroCalls >= MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE) {
      outcome.deferred.push(paymentId);
      continue;
    }
    const { confirmation, called } = await confirmXeroPaymentDeleted(input.session, paymentId, {
      workflow: "retireDeletedXeroPaymentLinks",
      expected: input.document,
    });
    if (called) outcome.xeroCalls += 1;
    if (confirmation === "DEFERRED") {
      stop = true;
      outcome.deferred.push(paymentId);
    } else if (confirmation === "LIVE") {
      outcome.confirmedLive.push(paymentId);
    } else if (confirmation === "UNCONFIRMED") {
      outcome.unconfirmed.push(paymentId);
    } else {
      outcome.confirmedDeleted.push(paymentId);
      for (const link of links) {
        if (await retireDeletedXeroPaymentLink(link)) retired.push(link);
      }
    }
  }
  outcome.retiredLinks = retired.length;

  await writeXeroInboundAuditLogs({
    source: DELETED_PAYMENT_RETIRED_AUDIT_SOURCE,
    links: retired.map((link) => ({
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: "PAYMENT",
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      role: link.role,
    })),
    metadata: { [key]: input.document.id, status: DELETED_XERO_PAYMENT_STATUS },
  });
  if (outcome.deferred.length > 0 || outcome.unconfirmed.length > 0 || outcome.confirmedLive.length > 0) {
    logger.warn(
      { document: input.document, deferred: outcome.deferred, unconfirmed: outcome.unconfirmed, confirmedLive: outcome.confirmedLive },
      "Payments missing from a Xero document were left active until Xero confirms them deleted",
    );
  }
  return outcome;
}
