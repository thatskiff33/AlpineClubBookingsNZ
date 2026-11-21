/**
 * Real-PostgreSQL proof of #5228 (`INV-INT-025`, `INV-INT-029`): a queued Xero
 * operation that a pre-HTTP cooldown refuses AFTER its handler saved the
 * execution request on the row goes back to PENDING in a shape the next pass
 * can claim and send - it is never left PENDING and skipped on every pass.
 *
 * Before the fix the handler's execution request (`creditNotes`/`invoices`, no
 * `queueType`) stayed on the row, the outbox built the fallback claim (an
 * invoice for a member) from it, could not claim the row, and skipped it for
 * ever: the refund note or booking invoice never reached Xero, and nothing
 * failed or alerted.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking history (`booking-ledger-history`), its card refund as
 *   the webhook records it.
 * - REAL: the card settle (which enqueues the booking invoice), the refund-note
 *   enqueue, the outbox worker and the real handlers
 *   (`createXeroInvoiceForBooking`, `createXeroCreditNote`), each saving its
 *   execution request before the refused call. Xero itself is a fake (no
 *   provider call); `callXeroApi` refuses the named create once with the
 *   breaker's own pre-HTTP `XeroTransientOutageError`, as the breaker raises it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5228-";
const names = historyNames(PREFIX);
const PRICE = 20_000;

let prisma: PrismaClient;

type Sent = { operation: string; cents: number };

/** Xero's ids, unique across the file as Xero's own are. */
let documents = 0;

/**
 * A fake Xero for the real senders: the client, the invoiced party's contact,
 * the contact-repair wrapper and the refund settlement are stood in for, and
 * each create records what it was sent. `refuse` names the creates the
 * breaker refuses once each, before any call.
 */
async function fakeXero(sent: Sent[], refuse: Set<string>) {
  const apiClient = await import("@/lib/xero-api-client");
  const contacts = await import("@/lib/xero-contacts");
  const invoicedParty = await import("@/lib/organisation-xero-contacts");
  const invoicePayments = await import("@/lib/xero-invoice-payments");
  const cents = (lines: Array<{ unitAmount?: number; quantity?: number }>) =>
    lines.reduce((sum, line) => sum + Math.round((line.unitAmount ?? 0) * 100) * (line.quantity ?? 1), 0);
  const handlers: Record<string, (...args: never[]) => unknown> = {
    createInvoices: async (_tenant: string, body: { invoices: Array<{ lineItems: Array<{ unitAmount?: number; quantity?: number }> }> }) => {
      const total = cents(body.invoices[0]!.lineItems) / 100;
      sent.push({ operation: "createInvoices", cents: Math.round(total * 100) });
      const id = `${PREFIX}xero-invoice-${++documents}`;
      return { body: { invoices: [{ invoiceID: id, invoiceNumber: `INV-${id}`, status: "AUTHORISED", total, amountDue: total, amountPaid: 0 }] } };
    },
    createPayment: async () => ({ body: { payments: [{ paymentID: `${PREFIX}xero-payment-${++documents}` }] } }),
    createPayments: async () => ({ body: { payments: [{ paymentID: `${PREFIX}xero-payment-${++documents}` }] } }),
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount?: number; quantity?: number }> }> }) => {
      const total = cents(body.creditNotes[0]!.lineItems) / 100;
      sent.push({ operation: "createCreditNotes", cents: Math.round(total * 100) });
      const id = `${PREFIX}xero-note-${++documents}`;
      return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${id}`, status: "AUTHORISED", total, remainingCredit: total, payments: [] }] } };
    },
    createCreditNoteAllocation: async () => ({ body: { allocations: [{ amount: 0 }] } }),
    getCreditNote: async () => ({ body: { creditNotes: [] } }),
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
  vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: "tenant-5228" } as never);
  vi.spyOn(apiClient, "callXeroApi").mockImplementation((async (call: () => unknown, options?: { operation?: string }) => {
    if (options?.operation && refuse.delete(options.operation)) {
      // The breaker's own refusal, raised before any HTTP (`throwIfXeroTransientOutageActive`).
      throw new apiClient.XeroTransientOutageError(60, true);
    }
    return call();
  }) as never);
  vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-5228");
  vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
    options.run({ contactId: options.currentContactId })) as never);
  vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-5228" });
}

/** The outbox worker running `operationId` alone: it is made the oldest row so the scan takes it first. */
async function runOutbox(operationId: string) {
  await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")}, "updatedAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
  const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
  return processQueuedXeroOutboxOperations({ limit: 1 });
}

async function row(operationId: string) {
  return prisma.xeroSyncOperation.findUniqueOrThrow({
    where: { id: operationId },
    select: { status: true, queueType: true, requestPayload: true, startedAt: true, completedAt: true, lastErrorCode: true },
  });
}

let sequence = 0;

(RUN ? describe : describe.skip)(
  "a queued Xero operation a pre-HTTP cooldown refuses goes back to PENDING claimable - real PostgreSQL (#5228)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Cooldown give-back keeps the queued request (#5228)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await cleanHistories(prisma, PREFIX);
      await seedHistoryFixtures(prisma, PREFIX);
    }, 120_000);

    const sent: Sent[] = [];
    const refuse = new Set<string>();
    beforeEach(async () => {
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      sent.length = 0;
      refuse.clear();
      await fakeXero(sent, refuse);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      // Each case's rows, so a row one case left stuck is never the next case's oldest.
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
    });

    afterAll(async () => {
      if (prisma) await cleanHistories(prisma, PREFIX);
    }, 120_000);

    /** A card-paid booking, settled through the real settle; returns its id and its queued invoice row. */
    async function paidBooking(): Promise<{ bookingId: string; paymentId: string; invoiceRow: string }> {
      const bookingId = `${PREFIX}b${++sequence}`;
      await createHistoryBooking(prisma, names, bookingId, { payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${bookingId}` } });
      await settleHistoryByCard(bookingId, PRICE);
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

    it("REPRO: a booking invoice refused by the breaker after its handler saved the invoice goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { invoiceRow } = await paidBooking();
      refuse.add("createInvoices");

      const refused = await runOutbox(invoiceRow);
      expect(refused).toMatchObject({ processed: 1, skipped: 1, failed: 0, cooldownDeferred: 1 });
      expect(sent).toEqual([]);
      const given = await row(invoiceRow);
      expect(given).toMatchObject({ status: "PENDING", queueType: "BOOKING_INVOICE", startedAt: null, completedAt: null, lastErrorCode: null });
      expect(given.requestPayload).toMatchObject({ queueType: "BOOKING_INVOICE" });

      const resent = await runOutbox(invoiceRow);
      expect(resent).toMatchObject({ processed: 1, succeeded: 1, skipped: 0, failed: 0 });
      expect(sent).toEqual([{ operation: "createInvoices", cents: PRICE }]);
      expect((await row(invoiceRow)).status).toBe("SUCCEEDED");
    });

    it("REPRO: a refund credit note refused by the breaker after its handler saved the note goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { paymentId, invoiceRow } = await paidBooking();
      expect(await runOutbox(invoiceRow)).toMatchObject({ succeeded: 1 });
      sent.length = 0;

      // A $50 card refund, as the webhook records it, and its note queued by the real enqueue.
      const transaction = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId }, select: { id: true, stripePaymentIntentId: true } });
      await prisma.paymentRefund.create({
        data: {
          paymentId, paymentTransactionId: transaction.id, stripeRefundId: `re_${paymentId}`, stripePaymentIntentId: transaction.stripePaymentIntentId,
          amountCents: 5_000, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-30T00:00:00.000Z"),
        },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { refundedAmountCents: { increment: 5_000 }, status: "PARTIALLY_REFUNDED" } });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const noteRow = (await enqueueXeroRefundCreditNoteOperation(paymentId, 5_000)).queueOperationId!;
      expect(noteRow).toEqual(expect.any(String));
      refuse.add("createCreditNotes");

      const refused = await runOutbox(noteRow);
      expect(refused).toMatchObject({ processed: 1, skipped: 1, failed: 0, cooldownDeferred: 1 });
      expect(sent).toEqual([]);
      const given = await row(noteRow);
      expect(given).toMatchObject({ status: "PENDING", queueType: "REFUND_CREDIT_NOTE", startedAt: null, completedAt: null, lastErrorCode: null });
      expect(given.requestPayload).toMatchObject({ queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000 });

      const resent = await runOutbox(noteRow);
      expect(resent).toMatchObject({ processed: 1, succeeded: 1, skipped: 0, failed: 0 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: 5_000 }]);
      expect((await row(noteRow)).status).toBe("SUCCEEDED");
    });
  },
);
