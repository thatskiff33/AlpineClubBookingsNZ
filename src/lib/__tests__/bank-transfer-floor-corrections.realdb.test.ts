/**
 * Real-PostgreSQL proof of #5289 D (owner decision D2, `INV-ADDPAY-021`): the
 * bank-transfer floor is the payment's refund detail PLUS the invoice
 * corrections its links count, never above the stored total, and it sends no
 * shortfall alert while a refund note for the payment is still queued for Xero.
 *
 * The shape: a $100 invoice correction counted from the links, and a $200 bank
 * refund the treasurer recorded in the app whose credit note is still in the
 * outbox. Stored $300, detail $200, links $100. Before #5289 every writer
 * floored the total at the detail, $200: the net read $100 too high (a cancel
 * then over-refunds), and the alert told the officer a credit note may be
 * missing. Now each writer leaves $300 and sends nothing.
 *
 * Each writer runs for real: the kept settle (`syncInternetBankingPaymentsForPaidInvoice`),
 * the note sync's allocation write and recount (`reconcileXeroCreditNote`
 * against a fake Xero), and the recount after a kept settle
 * (`repairRefundedPaymentBusinessState` with no note being synced). The
 * `refund-ledger-divergence` alerts the floor sends are counted.
 *
 * #5289 F (owner decision D4): a keep held at the floor records its alert in
 * its own transaction (`ib_kept_settle_floor_alert`), and a sender claims the
 * marker before it sends, so a process stopped after the commit still alerts
 * once, from the retried delivery or the inbound cron, never from both.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions,
 * which imports this file so CI reaches it; it cleans its own `race-5289d-`
 * fixtures.
 */
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { syncFakeXeroCreditNote } from "./support/fake-xero-credit-note-sync";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-5289d";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const INVOICE_ID = `${P}-invoice`;
const NOTE_ID = `${P}-correction`;
const MODIFICATION_ID = `${P}-modification`;
const CORRECTION_CENTS = 10_000;
const BANK_REFUND_CENTS = 20_000;
const CHECK_IN = new Date("2028-01-10T00:00:00.000Z");
const CHECK_OUT = new Date("2028-01-11T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the bank-transfer floor adds back the corrections the links count - real PostgreSQL (#5289 D, INV-ADDPAY-021)",
  { timeout: 60_000 },
  () => {
    let floorAlerts: string[] = [];

    async function clean() {
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }, { metadata: { path: ["creditNoteId"], equals: NOTE_ID } }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } }, { xeroObjectId: { in: [INVOICE_ID, NOTE_ID] } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#5289 D bank-transfer floor corrections");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Floor", lastName: "Corrections", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5289d Lodge", slug: P } });
    }, 60_000);

    beforeEach(async () => {
      await clean();
      vi.restoreAllMocks();
      floorAlerts = [];
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockImplementation((async (alert: { errorType: string; errorMessage: string }) => {
        if (alert.errorType === "refund-ledger-divergence") floorAlerts.push(alert.errorMessage);
      }) as never);
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    /**
     * A $500 bank transfer whose receipt holds the stored figure, an edit's
     * $100 invoice correction synced and allocated to its invoice, and a $200
     * bank refund the treasurer recorded: on the receipt's detail and the
     * stored total ($300), its credit note queued in the outbox (`queued`).
     * `captured: false` leaves the receipt for the settle, the refund recorded
     * on a captured additional bank-transfer row instead.
     */
    async function seed(options: { captured?: boolean; queued?: boolean; correction?: boolean } = {}) {
      const captured = options.captured !== false;
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: captured ? "PAID" : "CONFIRMED", totalPriceCents: 40_000, finalPriceCents: 40_000 },
      });
      const primary = {
        kind: "PRIMARY" as const, source: "INTERNET_BANKING" as const, amountCents: 50_000, reference: "BOOKING-RACE5289D", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5289D",
      };
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, source: "INTERNET_BANKING", status: captured ? "PARTIALLY_REFUNDED" : "PENDING",
          amountCents: captured ? 50_000 : 70_000, refundedAmountCents: CORRECTION_CENTS + BANK_REFUND_CENTS,
          reference: "BOOKING-RACE5289D", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5289D",
          transactions: {
            create: captured
              ? [{ ...primary, status: "PARTIALLY_REFUNDED", refundedAmountCents: BANK_REFUND_CENTS, reason: "xero_invoice_paid_reconciliation" }]
              : [
                  { ...primary, status: "PENDING", refundedAmountCents: 0, reason: "internet_banking_booking_payment" },
                  { kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: 20_000, status: "REFUNDED", refundedAmountCents: BANK_REFUND_CENTS, reference: "BOOKING-RACE5289D-A" },
                ],
          },
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });
      // #5289 F: no correction at all - $100 of the stored $300 is a refund the rows never recorded.
      if (options.correction === false) return;
      await prisma.bookingModification.create({
        data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -CORRECTION_CENTS, changeFeeCents: 0 },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "BookingModification", localId: MODIFICATION_ID,
          idempotencyKey: `${P}-mod-credit-note`, correlationKey: `${P}-mod-credit-note`, status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID,
          requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: CORRECTION_CENTS, noteWording: "invoice-correction" },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "MODIFICATION_CREDIT_NOTE", active: true,
          metadata: { status: "AUTHORISED", total: CORRECTION_CENTS / 100 },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", xeroObjectId: `${NOTE_ID}:${INVOICE_ID}:${CORRECTION_CENTS}`,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active: true, metadata: { creditNoteId: NOTE_ID, invoiceId: INVOICE_ID, amountCents: CORRECTION_CENTS },
        },
      });
      if (options.queued !== false) {
        // The bank refund's own credit note, queued on the payment and not yet run.
        await prisma.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
            idempotencyKey: `${P}-refund-credit-note`, correlationKey: `${P}-refund-credit-note`, status: "PENDING",
            requestPayload: { refundAmountCents: BANK_REFUND_CENTS, refundMethod: "internet-banking" },
          },
        });
      }
    }

    const refunded = async () =>
      (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents;

    function syncCorrection() {
      return syncFakeXeroCreditNote({
        creditNoteID: NOTE_ID, creditNoteNumber: "CN-5289D", status: "AUTHORISED", total: CORRECTION_CENTS / 100, appliedAmount: CORRECTION_CENTS / 100, remainingCredit: 0,
        updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"), allocations: [{ invoice: { invoiceID: INVOICE_ID }, amount: CORRECTION_CENTS / 100 }], payments: [],
      });
    }

    it("MUTATION (D2 floor): the note sync's allocation write and recount leave $300, and send no alert while the refund note is queued", async () => {
      await seed();
      await syncCorrection();
      expect(await refunded()).toBe(CORRECTION_CENTS + BANK_REFUND_CENTS);
      expect(floorAlerts).toEqual([]);
    });

    it("MUTATION (outbox check): with no refund note queued, Xero really is $200 short: the total stays $300 and the officer is alerted once", async () => {
      await seed({ queued: false });
      await syncCorrection();
      expect(await refunded()).toBe(CORRECTION_CENTS + BANK_REFUND_CENTS);
      expect(floorAlerts).toHaveLength(1);
    });

    it("the recount after a kept settle (no note being synced) leaves $300 and sends no alert", async () => {
      await seed();
      const { repairRefundedPaymentBusinessState } = await import("@/lib/xero-inbound/credit-note-repairs");
      await repairRefundedPaymentBusinessState({ creditNoteId: null, creditNote: {}, directPaymentIds: [PAYMENT_ID], modificationRefundAmountsByPaymentId: new Map() });
      expect(await refunded()).toBe(CORRECTION_CENTS + BANK_REFUND_CENTS);
      expect(floorAlerts).toEqual([]);
    });

    it("a kept settle leaves $300 and sends no alert", async () => {
      await seed({ captured: false });
      const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
      // Paid with an unquantifiable amount, so the settle keeps the stored figure; the correction is applied to the invoice.
      const invoice = {
        invoiceID: INVOICE_ID, invoiceNumber: "INV-5289D", status: "PAID", amountPaid: "degraded", total: 500,
        payments: [{ paymentID: `${P}-xpay`, amount: 0, status: "AUTHORISED" }],
        creditNotes: [{ creditNoteID: NOTE_ID, appliedAmount: CORRECTION_CENTS / 100 }],
      } as unknown as Invoice;
      await syncInternetBankingPaymentsForPaidInvoice(invoice, [PAYMENT_ID], CLUB_FORMAT_TEST);
      expect(await refunded()).toBe(CORRECTION_CENTS + BANK_REFUND_CENTS);
      expect(floorAlerts).toEqual([]);
    });
    /** The kept settle of the invoice, paid with an unquantifiable amount and no note applied. */
    async function settleKeptPlain() {
      const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
      const invoice = {
        invoiceID: INVOICE_ID, invoiceNumber: "INV-5289D", status: "PAID", amountPaid: "degraded", total: 500,
        payments: [{ paymentID: `${P}-xpay`, amount: 0, status: "AUTHORISED" }], creditNotes: [],
      } as unknown as Invoice;
      return syncInternetBankingPaymentsForPaidInvoice(invoice, [PAYMENT_ID], CLUB_FORMAT_TEST);
    }

    const floorMarkers = () =>
      prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID, snapshot: { path: ["kind"], equals: "ib_kept_settle_floor_alert" } }, select: { id: true, type: true, snapshot: true } });

    /** A keep that lowers $300 to the $200 detail and is held there; the process stops after its commit, before the alert. */
    async function keepHeldAtFloorThenStop() {
      await seed({ captured: false, queued: false, correction: false });
      const followUp = await import("@/lib/xero-inbound/kept-settle-floor-alert");
      const stopped = new Error("race-5289d process stopped after the commit");
      const spy = vi.spyOn(followUp, "sendOwedKeptFloorAlerts").mockRejectedValueOnce(stopped);
      await settleKeptPlain();
      spy.mockRestore();
      expect(await refunded()).toBe(BANK_REFUND_CENTS);
      expect(floorAlerts).toEqual([]);
    }

    it("MUTATION (D4 record): a keep held at the floor records its alert with the total; stopped before the send, the retried delivery sends it once, and never again", async () => {
      await keepHeldAtFloorThenStop();
      const [marker] = await floorMarkers();
      expect(marker).toMatchObject({ type: "CANCELLED", snapshot: { paymentId: PAYMENT_ID, xeroDerivedCents: 0, floorCents: BANK_REFUND_CENTS, alertSentAt: null } });

      // The retried delivery: a replay now, whose keep moves nothing; before #5289 nothing alerted the officer at all.
      await settleKeptPlain();
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]).toContain(PAYMENT_ID);
      expect((await floorMarkers())[0]!.snapshot).toMatchObject({ alertSentAt: expect.any(String) });

      await settleKeptPlain();
      const { retryCashSettlementAlerts } = await import("@/lib/xero-inbound/cash-settlement-alert-retry");
      await prisma.bookingEvent.updateMany({ where: { id: marker!.id }, data: { createdAt: new Date("2026-06-30T00:00:00.000Z") } });
      await retryCashSettlementAlerts(CLUB_FORMAT_TEST);
      expect(floorAlerts).toHaveLength(1);
    });

    it("MUTATION (D4 claim): a retried delivery and the inbound cron racing for the owed alert send it exactly once", async () => {
      await keepHeldAtFloorThenStop();
      const [marker] = await floorMarkers();
      // Old enough for the cron's sweep, which leaves recent markers to their after-commit sender.
      await prisma.bookingEvent.updateMany({ where: { id: marker!.id }, data: { createdAt: new Date("2026-06-30T00:00:00.000Z") } });
      const { retryCashSettlementAlerts } = await import("@/lib/xero-inbound/cash-settlement-alert-retry");
      await Promise.all([settleKeptPlain(), retryCashSettlementAlerts(CLUB_FORMAT_TEST), retryCashSettlementAlerts(CLUB_FORMAT_TEST)]);
      expect(floorAlerts).toHaveLength(1);
    });

    it("a marker claimed by a sender still within its window is left to that sender; a failed send gives the claim back for the next", async () => {
      await keepHeldAtFloorThenStop();
      const [marker] = await floorMarkers();
      const claimed = { ...(marker!.snapshot as object), alertClaimedAt: new Date().toISOString() };
      await prisma.bookingEvent.update({ where: { id: marker!.id }, data: { snapshot: claimed } });
      await settleKeptPlain();
      expect(floorAlerts).toEqual([]);

      await prisma.bookingEvent.update({ where: { id: marker!.id }, data: { snapshot: { ...claimed, alertClaimedAt: null } } });
      const alerts = await import("@/lib/xero-error-alert");
      vi.mocked(alerts.notifyXeroSyncError).mockRejectedValueOnce(new Error("mail down"));
      await settleKeptPlain();
      expect((await floorMarkers())[0]!.snapshot).toMatchObject({ alertClaimedAt: null, alertSentAt: null });
      await settleKeptPlain();
      expect(floorAlerts).toHaveLength(1);
    });
  },
);
