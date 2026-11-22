/**
 * #5228: the fixtures the queued-request real-PostgreSQL suites share - a fake
 * Xero for the real senders, a card-paid booking settled through the real
 * settle, a card refund as the webhook records it, a queued group settlement
 * invoice, the outbox worker run on one row, and an officer's Retry. No
 * provider is called.
 */
import type { PrismaClient } from "@prisma/client";
import { expect, vi } from "vitest";

import type { SuiteEnvironmentRoleDeclaration } from "../helpers/environment-role";
import { createGroupHistory, groupHistory, type GroupHistory } from "./booking-ledger-group-history";
import { createHistoryBooking, settleHistoryByCard, type HistoryNames } from "./booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./club-format-fixture";
import { assertNoForeignPendingXeroOperations } from "./race-harness-outbox-guard";

export type SentDocument = { operation: "createInvoices" | "createCreditNotes"; cents: number };

/** Xero's ids, unique across a run as Xero's own are. */
let documents = 0;

type Lines = Array<{ unitAmount?: number; quantity?: number }>;
const linesCents = (lines: Lines) => lines.reduce((sum, line) => sum + Math.round((line.unitAmount ?? 0) * 100) * (line.quantity ?? 1), 0);

/**
 * The real senders against a fake Xero: the client, the invoiced party's
 * contact, the contact-repair wrapper and the refund settlement are stood in
 * for, and each create records what it was sent. `refuse` maps a create to the
 * error `callXeroApi` raises for it, once, before any call.
 */
export async function fakeXero(prefix: string, sent: SentDocument[], refuse: Map<string, () => Error>): Promise<void> {
  const apiClient = await import("@/lib/xero-api-client");
  const contacts = await import("@/lib/xero-contacts");
  const invoicedParty = await import("@/lib/organisation-xero-contacts");
  const invoicePayments = await import("@/lib/xero-invoice-payments");
  // An edit's credit note reads its invoice's amount due before creating anything (#3993).
  const invoices = new Map<string, Record<string, unknown>>();
  const notes = new Map<string, Record<string, unknown>>();
  const handlers: Record<string, (...args: never[]) => unknown> = {
    createInvoices: async (_tenant: string, body: { invoices: Array<{ lineItems: Lines }> }) => {
      const cents = linesCents(body.invoices[0]!.lineItems);
      sent.push({ operation: "createInvoices", cents });
      const id = `${prefix}xero-invoice-${++documents}`;
      const invoice = { invoiceID: id, invoiceNumber: `INV-${id}`, status: "AUTHORISED", total: cents / 100, amountDue: cents / 100, amountPaid: 0 };
      invoices.set(id, invoice);
      return { body: { invoices: [invoice] } };
    },
    // The joining fee looks for an invoice already raised under its reference first: none here.
    getInvoices: async () => ({ body: { invoices: [] } }),
    getInvoice: async (_tenant: string, invoiceId: string) => {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw new Error(`The fake Xero holds no invoice ${invoiceId}`);
      return { body: { invoices: [invoice] } };
    },
    createPayment: async () => ({ body: { payments: [{ paymentID: `${prefix}xero-payment-${++documents}` }] } }),
    createPayments: async () => ({ body: { payments: [{ paymentID: `${prefix}xero-payment-${++documents}` }] } }),
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Lines }> }) => {
      const cents = linesCents(body.creditNotes[0]!.lineItems);
      sent.push({ operation: "createCreditNotes", cents });
      const id = `${prefix}xero-note-${++documents}`;
      const note = { creditNoteID: id, creditNoteNumber: `CN-${id}`, status: "AUTHORISED", total: cents / 100, remainingCredit: cents / 100, payments: [] };
      notes.set(id, note);
      return { body: { creditNotes: [note] } };
    },
    createCreditNoteAllocation: async () => ({ body: { allocations: [{ amount: 0 }] } }),
    // A note this fake raised is read back as it was raised (#5368: the retry leg that pays a note reads it first).
    getCreditNote: async (_tenant: string, creditNoteId: string) => ({ body: { creditNotes: notes.has(creditNoteId) ? [notes.get(creditNoteId)] : [] } }),
  };
  const accountingApi = new Proxy(handlers, {
    get(target, name: string) {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      return () => {
        throw new Error(`The fake Xero was asked for ${name}, which this proof does not stand in for`);
      };
    },
  });
  vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: `tenant-${prefix}` } as never);
  vi.spyOn(apiClient, "callXeroApi").mockImplementation((async (call: () => unknown, options?: { operation?: string }) => {
    const refusal = options?.operation ? refuse.get(options.operation) : undefined;
    if (refusal) {
      refuse.delete(options!.operation!);
      throw refusal();
    }
    return call();
  }) as never);
  vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(`${prefix}contact`);
  vi.spyOn(contacts, "findOrCreateXeroContact").mockResolvedValue(`${prefix}contact`);
  vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
    options.run({ contactId: options.currentContactId })) as never);
  vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: prefix });
}

/** The breaker's own refusal, raised before any HTTP (`throwIfXeroTransientOutageActive`). */
export async function breakerRefusal(): Promise<() => Error> {
  const { XeroTransientOutageError } = await import("@/lib/xero-api-client");
  return () => new XeroTransientOutageError(60, true);
}

/** Each run's row is dated a second before the last one's, so it is always the oldest. */
let runs = 0;

/**
 * The outbox worker running `operationId` alone: made the oldest row, so the
 * scan takes it first (after 2010, where the tax schedule starts). #4234:
 * first, no PENDING row but the suite's own (`prefix`) may be there to consume.
 */
export async function runOutboxRow(prisma: PrismaClient, operationId: string, prefix: string) {
  const pending = await prisma.xeroSyncOperation.findMany({ where: { status: "PENDING", localId: { startsWith: prefix } }, select: { localId: true } });
  await assertNoForeignPendingXeroOperations(prisma, pending.map((row) => row.localId!));
  const oldest = new Date(Date.UTC(2020, 0, 1) - ++runs * 1_000);
  await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${oldest}, "updatedAt" = ${oldest} WHERE "id" = ${operationId}`;
  const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
  return processQueuedXeroOutboxOperations({ limit: 1 });
}

/** A card-paid booking settled through the real settle, and its queued primary invoice row. */
export async function paidCardBooking(prisma: PrismaClient, names: HistoryNames, bookingId: string, priceCents: number) {
  await createHistoryBooking(prisma, names, bookingId, { payment: { amountCents: priceCents, source: "STRIPE", intent: `pi_${bookingId}` } });
  await settleHistoryByCard(bookingId, priceCents);
  const paymentId = `${bookingId}-payment`;
  const queued = await prisma.xeroSyncOperation.findFirst({
    where: { localModel: "Payment", localId: paymentId, queueType: "BOOKING_INVOICE", status: "PENDING" },
    select: { id: true },
  });
  if (queued) return { bookingId, paymentId, invoiceRow: queued.id };
  const { enqueueXeroBookingInvoiceOperation } = await import("@/lib/xero-operation-outbox");
  const enqueued = await enqueueXeroBookingInvoiceOperation(bookingId, { invoiceEmailDelivery: null });
  return { bookingId, paymentId, invoiceRow: enqueued.queueOperationId! };
}

/**
 * A two-child group paid by internet banking whose combined invoice is not raised yet, and its queued group
 * settlement invoice row. The invoice's email is gated on a declared environment: this declares a copy and stands in
 * for the send. The caller restores the returned `role` (and Vitest's mocks) when its case ends.
 */
export async function queuedGroupSettlementInvoice(
  prisma: PrismaClient,
  names: HistoryNames,
  prefix: string,
  key: string,
): Promise<{ g: GroupHistory; groupRow: string; role: SuiteEnvironmentRoleDeclaration }> {
  const g = groupHistory(prefix, key, "INTERNET_BANKING", 2);
  await createGroupHistory(prisma, names, g);
  // Not yet invoiced: the combined invoice is what the row raises.
  await prisma.groupBookingSettlement.update({ where: { id: g.settlement }, data: { xeroInvoiceId: null } });
  // The group invoice's email is gated on a declared environment; a copy, here.
  const { declareEnvironmentRoleForSuite } = await import("../helpers/environment-role");
  const role = declareEnvironmentRoleForSuite("non-production");
  try {
    const allow = { kind: "allow", clearance: {} } as never;
    const invoiceEmail = await import("@/lib/xero-invoice-email");
    vi.spyOn(invoiceEmail, "resolveXeroInvoiceEmailPolicy").mockResolvedValue(allow);
    vi.spyOn(invoiceEmail, "reassertXeroInvoiceEmailPolicy").mockResolvedValue(allow);
    vi.spyOn(invoiceEmail, "sendXeroInvoiceEmail").mockResolvedValue({ body: { emailed: true } } as never);
    const { enqueueXeroGroupSettlementInvoiceOperation } = await import("@/lib/xero-group-settlement-invoice-outbox");
    const groupRow = (await enqueueXeroGroupSettlementInvoiceOperation(g.settlement, { newAttempt: false })).queueOperationId!;
    expect(groupRow).toEqual(expect.any(String));
    return { g, groupRow, role };
  } catch (error) {
    // Never leave the declaration behind for the next suite in the shared harness.
    role.restore();
    throw error;
  }
}

/** The retry cron's drain of queued officer Retries (`processQueuedXeroOperationRetries`). */
export async function drainOfficerRetries() {
  const { processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
  return processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST);
}

/** An officer's Retry of `operationId`, queued and drained as the Retry button and the cron run it. */
export async function officerRetry(operationId: string, officerMemberId: string) {
  const { enqueueXeroSyncOperationRetry } = await import("@/lib/xero-operation-queue");
  await enqueueXeroSyncOperationRetry(operationId, { createdByMemberId: officerMemberId });
  return drainOfficerRetries();
}

/** A card refund as the `charge.refunded` webhook records it, and the payment's mirror. */
export async function recordCardRefund(prisma: PrismaClient, paymentId: string, cents: number, name: string): Promise<void> {
  const transaction = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId }, select: { id: true, stripePaymentIntentId: true } });
  await prisma.paymentRefund.create({
    data: {
      paymentId, paymentTransactionId: transaction.id, stripeRefundId: `re_${paymentId}-${name}`, stripePaymentIntentId: transaction.stripePaymentIntentId,
      amountCents: cents, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-30T00:00:00.000Z"),
    },
  });
  await prisma.payment.update({ where: { id: paymentId }, data: { refundedAmountCents: { increment: cents }, status: "PARTIALLY_REFUNDED" } });
}

/**
 * The refund's note, queued by the real enqueue as the refund webhook queues it.
 *
 * #5368 item 5: each send of this note logs "A refund document does not match the journal" with
 * COMPONENT_UNUSABLE. That is not a gap in these fixtures. On a card payment the note is sized on the payment's
 * refunded watermark and names no door (no card refund, request, review or bank record), so
 * `resolveRefundNoteObligation` answers "a note sized on the payment's watermark answers no one refund debt" before
 * it reads any journal row: recording the refund's debt here would not change it
 * (docs/design/member-money-ledger.md, section 7). The booking itself is journalled: its primary invoice and
 * capture receipt manifests are COVERED.
 */
export async function queueRefundNote(paymentId: string, cents: number): Promise<string> {
  const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
  const queued = await enqueueXeroRefundCreditNoteOperation(paymentId, cents);
  expect(queued.queueOperationId).toEqual(expect.any(String));
  return queued.queueOperationId!;
}

/**
 * A row as a give-back before #5228 left it: its real handler saves the
 * execution request and then fails on a refused call (here a plain failure, so
 * this build's give-back does not run), and the row is put back exactly as the
 * pre-#5228 give-back wrote it - PENDING, unclaimed, errors cleared, the
 * execution request left in place. The one hand-written step is that write.
 */
export async function strandAsBeforeTheFix(prisma: PrismaClient, operationId: string, refuse: Map<string, () => Error>, call: string, prefix: string): Promise<void> {
  refuse.set(call, () => new Error("refused before #5228's fix"));
  expect(await runOutboxRow(prisma, operationId, prefix)).toMatchObject({ processed: 1, failed: 1 });
  const stranded = await prisma.xeroSyncOperation.updateMany({
    where: { id: operationId, status: "FAILED" },
    data: { status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null },
  });
  expect(stranded.count).toBe(1);
  const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { requestPayload: true } });
  expect(row.requestPayload, "the handler saved no execution request").not.toHaveProperty("queueType");
}
