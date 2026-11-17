/**
 * Real-PostgreSQL proof of #4449's floor-alert rule (verify low 2,
 * `INV-ADDPAY-021`): one inbound credit-note sync alerts a bank-transfer
 * payment held at its own refund detail ONCE, whichever of its writers
 * decided it - the allocation write, the removal, or the recount.
 *
 * The allocation write and the removal hold their alerts; the sync's recount
 * (`repairRefundedPaymentBusinessState`) floors and alerts every payment it
 * decides; the held alerts then go out only for payments it did not decide
 * (`sendFloorAlertsNotRecounted`): a removed invoice's payment, and an invoice
 * correction's payment whose receipt was recorded from cash.
 *
 * Each case runs the REAL sync (`reconcileXeroCreditNote`) against a fake
 * Xero (no provider call), over a booking, payment, receipt with recorded
 * refund detail, edit and note seeded as their writers leave them, and counts
 * the `refund-ledger-divergence` alerts the bank-transfer floor sends.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions,
 * which imports this file so CI reaches it; it cleans its own `race-4449a-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4449a";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const PRIMARY_ID = `${P}-primary`;
const INVOICE_ID = `${P}-invoice`;
const NOTE_ID = `${P}-note`;
// A second invoice the note was allocated to, with no payment of its own; its link sorts after the payment's.
const OTHER_INVOICE_ID = `${P}-zinvoice`;
const MODIFICATION_ID = `${P}-modification`;
const PAYMENT_CENTS = 50_000;
const NOTE_CENTS = 4_000;
const CHECK_IN = new Date("2027-11-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-11-02T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "one floor alert per payment per inbound credit-note sync - real PostgreSQL (#4449 verify, INV-ADDPAY-021)",
  { timeout: 60_000 },
  () => {
    let floorAlerts: Array<{ operation: string; errorMessage: string }> = [];

    async function clean() {
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }, { metadata: { path: ["creditNoteId"], equals: NOTE_ID } }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } }, { xeroObjectId: { in: [INVOICE_ID, OTHER_INVOICE_ID, NOTE_ID] } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4449 one floor alert per sync");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Floor", lastName: "Alert", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4449a Lodge", slug: P } });
    }, 60_000);

    beforeEach(async () => {
      await clean();
      vi.restoreAllMocks();
      floorAlerts = [];
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockImplementation((async (alert: { errorType: string; operation: string; errorMessage: string }) => {
        if (alert.errorType === "refund-ledger-divergence") floorAlerts.push({ operation: alert.operation, errorMessage: alert.errorMessage });
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
     * A $500 bank transfer, paid, with `detailCents` of hand-backs recorded on
     * its receipt and `storedCents` refunded on the payment; an edit's note
     * (a bank refund, or an invoice correction) in the rows its builder leaves,
     * optionally already allocated to the invoice.
     */
    async function seed(input: { storedCents: number; detailCents: number; correction?: boolean; receiptReason?: string; allocated?: boolean; alsoOther?: boolean }) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CONFIRMED", totalPriceCents: PAYMENT_CENTS, finalPriceCents: PAYMENT_CENTS },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAYMENT_CENTS, source: "INTERNET_BANKING",
          status: input.storedCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED", refundedAmountCents: input.storedCents,
          reference: "BOOKING-RACE4449A", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4449A",
          transactions: {
            create: {
              id: PRIMARY_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAYMENT_CENTS, status: input.detailCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED",
              refundedAmountCents: input.detailCents, reference: "BOOKING-RACE4449A", reason: input.receiptReason ?? "internet_banking_booking_payment",
              xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4449A",
            },
          },
        },
      });
      await prisma.bookingModification.create({
        data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -NOTE_CENTS, changeFeeCents: 0 },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "BookingModification", localId: MODIFICATION_ID,
          idempotencyKey: `${P}-mod-credit-note`, correlationKey: `${P}-mod-credit-note`, status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID,
          requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: NOTE_CENTS, ...(input.correction ? { noteWording: "invoice-correction" } : { refundMethod: "internet-banking" }) },
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "MODIFICATION_CREDIT_NOTE", active: true },
      });
      if (input.allocated) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", xeroObjectId: `${NOTE_ID}:${INVOICE_ID}:${NOTE_CENTS}`,
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active: true, metadata: { creditNoteId: NOTE_ID, invoiceId: INVOICE_ID, amountCents: NOTE_CENTS },
          },
        });
      }
      if (input.alsoOther) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", xeroObjectId: `${NOTE_ID}:${OTHER_INVOICE_ID}:${NOTE_CENTS}`,
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active: true, metadata: { creditNoteId: NOTE_ID, invoiceId: OTHER_INVOICE_ID, amountCents: NOTE_CENTS },
          },
        });
      }
    }

    /** The REAL inbound sync of the AUTHORISED note, allocated to the invoice or (`listed: false`) to nothing. */
    async function sync(listed: boolean) {
      const note = {
        creditNoteID: NOTE_ID, creditNoteNumber: "CN-4449A", status: "AUTHORISED", total: NOTE_CENTS / 100,
        appliedAmount: listed ? NOTE_CENTS / 100 : 0, remainingCredit: listed ? 0 : NOTE_CENTS / 100,
        updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"),
        allocations: listed ? [{ invoice: { invoiceID: INVOICE_ID }, amount: NOTE_CENTS / 100 }] : [],
        payments: [],
      };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4449a" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        return await reconcileXeroCreditNote(NOTE_ID);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    const refunded = async () =>
      (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents;
    const allocationActive = async () =>
      (await prisma.xeroObjectLink.findFirst({
        where: { xeroObjectType: "ALLOCATION", localId: MODIFICATION_ID, role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", xeroObjectId: { contains: `:${INVOICE_ID}:` } },
        select: { active: true },
      }))?.active ?? null;

    it("a listed write that leaves the total at the floor: no alert from the write, one from the recount", async () => {
      // $100 handed back and recorded; the $40 note's links say less: held at $100, unmoved.
      await seed({ storedCents: 10_000, detailCents: 10_000 });
      await sync(true);
      expect(await allocationActive()).toBe(true);
      expect(await refunded()).toBe(10_000);
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]!.operation).toBe(`inbound-credit-note-repair:${NOTE_ID}`);
    });

    it("MUTATION (always send the writes' alerts): a listed write that moves the total to the floor: one alert in all, the recount's", async () => {
      // $150 stored above the $100 detail: the write brings it down to the floor, and the recount sees it held there.
      await seed({ storedCents: 15_000, detailCents: 10_000 });
      await sync(true);
      expect(await refunded()).toBe(10_000);
      expect(floorAlerts).toHaveLength(1);
    });

    it("MUTATION (writes never alert): a correction on a receipt recorded from cash, which the recount does not decide: the write's one alert", async () => {
      // The correction counts against no cash-sized receipt, so the recount leaves this payment out; the write decided it.
      await seed({ storedCents: 15_000, detailCents: 10_000, correction: true, receiptReason: "xero_invoice_paid_cash" });
      await sync(true);
      expect(await refunded()).toBe(10_000);
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]!.operation).toBe(`inbound-credit-note-repair:${NOTE_ID}`);
    });

    it("MUTATION (removals alert only when they move): a removal held at the floor with the total unmoved: exactly one alert, naming the note", async () => {
      // The officer removed the note's allocation in Xero: Xero now shows $0 against $100 recorded.
      await seed({ storedCents: 10_000, detailCents: 10_000, allocated: true });
      await sync(false);
      expect(await allocationActive()).toBe(false);
      expect(await refunded()).toBe(10_000);
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]!.operation).toBe(`inbound-credit-note-repair:${NOTE_ID}`);
    });

    it("a removal held at the floor that moves the total: exactly one alert", async () => {
      await seed({ storedCents: 15_000, detailCents: 10_000, allocated: true });
      await sync(false);
      expect(await refunded()).toBe(10_000);
      expect(floorAlerts).toHaveLength(1);
    });

    it("MUTATION (send only on success): the recount throws after a removal held at the floor: one alert naming the note, the error still thrown, and the retry sends no second", async () => {
      await seed({ storedCents: 10_000, detailCents: 10_000, allocated: true });
      const repairs = await import("@/lib/xero-inbound/credit-note-repairs");
      const failure = new Error("race-4449a recount failed");
      const spy = vi.spyOn(repairs, "repairRefundedPaymentBusinessState").mockRejectedValueOnce(failure);
      await expect(sync(false)).rejects.toBe(failure);
      spy.mockRestore();
      // The removal committed; nothing else will alert this payment.
      expect(await allocationActive()).toBe(false);
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]!.operation).toBe(`inbound-credit-note-repair:${NOTE_ID}`);

      // The retried sync cannot see the removal again (its link is off) and does not recount the payment.
      await sync(false);
      expect(floorAlerts).toHaveLength(1);
    });

    it("MUTATION (send only on success): a later removal in the loop throws after an earlier one committed: the earlier removal's alert goes out once", async () => {
      await seed({ storedCents: 10_000, detailCents: 10_000, allocated: true, alsoOther: true });
      const xeroSync = await import("@/lib/xero-sync");
      const original = xeroSync.upsertXeroObjectLink;
      const failure = new Error("race-4449a second removal failed");
      const spy = vi.spyOn(xeroSync, "upsertXeroObjectLink").mockImplementation((async (...args: Parameters<typeof original>) => {
        if (args[0].xeroObjectId.includes(OTHER_INVOICE_ID) && args[0].active === false) throw failure;
        return original(...args);
      }) as never);
      try {
        await expect(sync(false)).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }
      expect(await allocationActive()).toBe(false);
      expect(floorAlerts).toHaveLength(1);
      expect(floorAlerts[0]!.operation).toBe(`inbound-credit-note-repair:${NOTE_ID}`);
    });

    it("a removal not held at the floor: no alert", async () => {
      // Nothing recorded: the $40 the note counted comes off, and Xero is not below anything the club recorded.
      await seed({ storedCents: NOTE_CENTS, detailCents: 0, allocated: true });
      await sync(false);
      expect(await refunded()).toBe(0);
      expect(floorAlerts).toHaveLength(0);
    });
  },
);
