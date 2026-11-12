/**
 * Real-PostgreSQL proof for #4493 (`INV-ADDPAY-046`): a refund of a
 * credit-release capture the sweep has already recorded in Xero raises one
 * credit note for the refunded cents, against that booking invoice, and a
 * second delivery of the same refund raises none.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking and its payment; the card capture's charge row; the
 *   sweep's `CREDIT_RELEASE_PAYMENT` link (the marker `recordOne` writes once
 *   Xero has the payment); and, for the bank-transfer case, the payment's
 *   canonical refund note, already linked. The payment's own invoice id is a
 *   different document, so a note that names the booking invoice read the
 *   sweep's link.
 * - REAL: `charge.refunded` (`processStripeWebhookEvent`), Stripe's refund list
 *   through the harness's shared `@/lib/stripe` double, and the outbox worker
 *   against a fake Xero. No provider call.
 *
 * An intent a late-capture task owns still takes that route and gets no
 * credit-release note (#4380). Ordinary Vitest runs skip the file. CI's
 * `realdb-all` job runs it. It owns and cleans its own `race-4493-` fixtures.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertNoForeignPendingXeroOperations } from "./support/race-harness-outbox-guard";

vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4493";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const CARD_TXN_ID = `${P}-card-txn`;
const BOOKING_INVOICE = `${P}-booking-invoice`;
const OTHER_INVOICE = `${P}-other-invoice`;
const CANONICAL_NOTE = `${P}-canonical`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let refundCreated = 0;
let eventSequence = 0;

(RUN ? describe : describe.skip)(
  "a refund of a recorded credit-release capture raises one Xero credit note — real PostgreSQL (#4493)",
  { timeout: 90_000 },
  () => {
    async function clearRun() {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${P}_` } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: `evt_${P}_` } } });
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, CARD_TXN_ID] } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, CARD_TXN_ID] } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { entityId: { startsWith: P } }] } });
      await prisma.booking.updateMany({ where: { id: BOOKING_ID }, data: { status: "CONFIRMED" } });
    }

    async function deleteFixtures() {
      if (!prisma) return;
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Credit-release refund note (#4493)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      const { cardRefundNoteCutoverSeconds } = await import("@/lib/card-refund-own-note-share");
      const cutover = await cardRefundNoteCutoverSeconds(prisma);
      if (cutover === Number.POSITIVE_INFINITY) {
        throw new Error("The bank-transfer card refund note cutover has not finished; #4493 cannot be proven here");
      }
      refundCreated = (cutover ?? 0) + 86_400;
      await prisma.member.create({
        data: {
          id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password",
          firstName: "Credit", lastName: "Release", role: "USER", ageTier: "ADULT", canLogin: false,
          accessRoles: { create: { role: "USER" } },
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4493 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CONFIRMED",
          totalPriceCents: 10_000, finalPriceCents: 10_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await clearRun();
      eventSequence = 0;
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      await deleteFixtures();
    }, 60_000);

    /** The capture, and the sweep's link recording it against the booking invoice. */
    async function capture(source: "INTERNET_BANKING" | "STRIPE", intent: string, options?: { canonicalNote?: boolean }) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10_000, source, status: "SUCCEEDED",
          xeroInvoiceId: OTHER_INVOICE,
          ...(source === "STRIPE" ? { stripePaymentIntentId: intent } : {}),
          ...(options?.canonicalNote ? { xeroRefundCreditNoteId: CANONICAL_NOTE } : {}),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: CARD_TXN_ID, paymentId: PAYMENT_ID, kind: source === "STRIPE" ? "PRIMARY" : "ADDITIONAL",
          source: "STRIPE", stripePaymentIntentId: intent, amountCents: 4_000, status: "SUCCEEDED",
        },
      });
      const { CREDIT_RELEASE_PAYMENT_ROLE } = await import("@/lib/credit-release-xero-payment");
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "PaymentTransaction", localId: CARD_TXN_ID, xeroObjectType: "PAYMENT",
          xeroObjectId: `${P}-xero-payment`, role: CREDIT_RELEASE_PAYMENT_ROLE,
          metadata: { invoiceId: BOOKING_INVOICE, amountCents: 4_000, paymentIntentId: intent },
        },
      });
      if (options?.canonicalNote) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: CANONICAL_NOTE, role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 1_000 },
          },
        });
      }
    }

    function refund(id: string, intent: string, chargeId: string): Stripe.Refund {
      return {
        id, object: "refund", amount: 4_000, currency: "nzd", status: "succeeded",
        reason: "requested_by_customer", created: refundCreated, charge: chargeId, payment_intent: intent,
        metadata: { bookingId: BOOKING_ID, reason: "edit_financial_review" },
      } as unknown as Stripe.Refund;
    }

    async function deliver(intent: string, chargeId: string, refunds: Stripe.Refund[]) {
      eventSequence += 1;
      stripeRaceHooks.listChargeRefunds = async () => refunds;
      const event = {
        id: `evt_${P}_${eventSequence}`, object: "event", type: "charge.refunded", request: null,
        data: {
          object: {
            id: chargeId, object: "charge", payment_intent: intent, amount: 4_000,
            amount_refunded: refunds.reduce((sum, row) => sum + row.amount, 0),
            refunds: { data: refunds },
          },
        },
      } as unknown as Stripe.Event;
      const webhook = await import("@/lib/stripe-webhook-service");
      await webhook.processStripeWebhookEvent(event);
    }

    async function noteRows() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, requestPayload: true },
      });
      const { parsePaymentCreditNoteRetryInput } = await import("@/lib/xero-payment-credit-note-payload");
      return rows.map((row) => {
        const recorded = parsePaymentCreditNoteRetryInput(row);
        const allocation = (row.requestPayload as { allocation?: { invoiceId?: string } } | null)?.allocation;
        return {
          id: row.id, status: row.status, cents: recorded?.amountCents ?? null,
          cardRefundId: recorded?.cardRefundId ?? null,
          creditsInvoiceId: recorded?.creditsInvoiceId ?? null,
          allocationInvoiceId: allocation?.invoiceId ?? null,
        };
      });
    }

    /** The outbox worker for the one queued note, against a fake Xero. Returns the cents Xero was asked to raise. */
    async function raiseQueuedNote(operationId: string, noteId: string): Promise<number[]> {
      const sent: number[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            sent.push(Math.round(total * 100));
            return { body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4493" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4493"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          opts.run({ contactId: opts.currentContactId })) as never),
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: P }),
      ];
      try {
        await assertNoForeignPendingXeroOperations(prisma, [PAYMENT_ID, CARD_TXN_ID]);
        await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        await processQueuedXeroOutboxOperations({ limit: 1 });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true } });
      expect(row.status).toBe("SUCCEEDED");
      return sent;
    }

    it("a bank-transfer payment that already has its canonical note: one own note for the refund, and a second delivery adds none", async () => {
      const intent = "pi_race_4493_bank";
      const chargeId = "ch_race_4493_bank";
      await capture("INTERNET_BANKING", intent, { canonicalNote: true });
      const made = refund("re_race_4493_bank", intent, chargeId);

      await deliver(intent, chargeId, [made]);
      const [own] = await noteRows();
      expect(await noteRows()).toEqual([
        expect.objectContaining({ status: "PENDING", cents: 4_000, cardRefundId: made.id, creditsInvoiceId: BOOKING_INVOICE }),
      ]);

      await deliver(intent, chargeId, [made]);
      expect(await noteRows()).toHaveLength(1);

      expect(await raiseQueuedNote(own!.id, `${P}-own-note`)).toEqual([4_000]);
      expect(await noteRows()).toEqual([
        expect.objectContaining({
          status: "SUCCEEDED", cents: 4_000, cardRefundId: made.id,
          creditsInvoiceId: BOOKING_INVOICE, allocationInvoiceId: BOOKING_INVOICE,
        }),
      ]);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId).toBe(CANONICAL_NOTE);

      await deliver(intent, chargeId, [made]);
      expect(await noteRows()).toHaveLength(1);
    });

    it("a card payment the sweep recorded, with no other receipt: one delta note naming that invoice, and a replay adds none", async () => {
      const intent = "pi_race_4493_card";
      const chargeId = "ch_race_4493_card";
      await capture("STRIPE", intent);
      const made = refund("re_race_4493_card", intent, chargeId);

      await deliver(intent, chargeId, [made]);
      const [delta] = await noteRows();
      expect(await noteRows()).toEqual([
        expect.objectContaining({ status: "PENDING", cents: 4_000, cardRefundId: null, creditsInvoiceId: BOOKING_INVOICE }),
      ]);

      await deliver(intent, chargeId, [made]);
      expect(await noteRows()).toHaveLength(1);

      expect(await raiseQueuedNote(delta!.id, `${P}-delta-note`)).toEqual([4_000]);
      expect(await noteRows()).toEqual([
        expect.objectContaining({
          status: "SUCCEEDED", cents: 4_000, cardRefundId: null,
          creditsInvoiceId: BOOKING_INVOICE, allocationInvoiceId: BOOKING_INVOICE,
        }),
      ]);

      await deliver(intent, chargeId, [made]);
      expect(await noteRows()).toHaveLength(1);
    });

    it("a late capture keeps its own route and gets no credit-release note", async () => {
      const intent = "pi_race_4493_late";
      const chargeId = "ch_race_4493_late";
      await capture("STRIPE", intent);
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      await prisma.manualRefundTask.create({
        data: {
          id: `${P}-late-task`, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 4_000, raisedAmountCents: 4_000,
          kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: intent, reason: `${P} held late capture`, status: "DISMISSED",
        },
      });
      const { findLateCapturePaymentIntents } = await import("@/lib/late-capture-xero-receipt");
      expect([...(await findLateCapturePaymentIntents([intent]))]).toEqual([intent]);

      await deliver(intent, chargeId, [refund("re_race_4493_late", intent, chargeId)]);
      expect(await noteRows()).toEqual([]);
    });
  },
);
