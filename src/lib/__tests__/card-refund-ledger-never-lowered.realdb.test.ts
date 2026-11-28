/**
 * Real-PostgreSQL proof of #5289 E (owner decision D3, F5 #1353): a writer of
 * a refunded total from Xero never lowers a card payment's ledger. Only the
 * Xero-derived figure is clamped to the payment's amount; the raise-only floor
 * then keeps the stored total, logs it and raises `refund-ledger-divergence`.
 *
 * Before #5289 the shared step (`decideXeroRefundedColumns`) clamped AFTER the
 * floor, so a card payment whose stored refunded total was above its amount
 * was silently lowered to the amount by any refund-note sync.
 *
 * Runs the REAL inbound credit-note sync (`reconcileXeroCreditNote`, fake Xero)
 * of the payment's own refund note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions,
 * which imports this file so CI reaches it; it cleans its own `race-5289e-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { syncFakeXeroCreditNote } from "./support/fake-xero-credit-note-sync";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-5289e";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const NOTE_ID = `${P}-refund-note`;
const CHECK_IN = new Date("2028-02-10T00:00:00.000Z");
const CHECK_OUT = new Date("2028-02-11T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a Xero writer never lowers a card payment's refund ledger - real PostgreSQL (#5289 E, F5 #1353)",
  { timeout: 60_000 },
  () => {
    let alerts: string[] = [];

    async function clean() {
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }, { metadata: { path: ["creditNoteId"], equals: NOTE_ID } }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID] } }, { xeroObjectId: NOTE_ID }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#5289 E card ledger never lowered");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Card", lastName: "Ledger", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5289e Lodge", slug: P } });
    }, 60_000);

    beforeEach(async () => {
      await clean();
      vi.restoreAllMocks();
      alerts = [];
      const xeroAlerts = await import("@/lib/xero-error-alert");
      vi.spyOn(xeroAlerts, "notifyXeroSyncError").mockImplementation((async (alert: { errorType: string; errorMessage: string }) => {
        if (alert.errorType === "refund-ledger-divergence") alerts.push(alert.errorMessage);
      }) as never);
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("MUTATION (D3): a card payment whose stored refunded total is above its amount keeps it through its refund note's sync, logged and alerted", async () => {
      // $100 charged; $150 refunded on the ledger (a figure the amount no longer bounds); the refund note says $150.
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CANCELLED", totalPriceCents: 10_000, finalPriceCents: 10_000 },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, source: "STRIPE", status: "REFUNDED", amountCents: 10_000, refundedAmountCents: 15_000,
          stripePaymentIntentId: `pi_${P}`, xeroRefundCreditNoteId: NOTE_ID,
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "REFUND_CREDIT_NOTE", active: true, metadata: { status: "AUTHORISED", total: 150 } },
      });
      const logger = (await import("@/lib/logger")).default;
      const warn = vi.spyOn(logger, "warn");

      await syncFakeXeroCreditNote({
        creditNoteID: NOTE_ID, creditNoteNumber: "CN-5289E", status: "AUTHORISED", total: 150, appliedAmount: 0, remainingCredit: 150,
        updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"), allocations: [], payments: [],
      });

      // Before #5289 the clamp after the floor lowered it to $100, silently.
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } })).toEqual({ refundedAmountCents: 15_000, status: "REFUNDED" });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain("raise-only floor, #1353");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: PAYMENT_ID, localRefundedAmountCents: 15_000, xeroDerivedRefundedTotalCents: 10_000 }),
        expect.stringContaining("keeping the local ledger (raise-only floor)"),
      );
    });
  },
);
