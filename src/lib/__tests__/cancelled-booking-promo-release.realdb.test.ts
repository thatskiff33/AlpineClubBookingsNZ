import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
// No live provider is needed to expire a hold with no issued invoice.
vi.mock("@/lib/internet-banking-hold-payment-evidence", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/internet-banking-hold-payment-evidence")),
  readHoldPaymentEvidence: async () => ({ kind: "unpaid", readStartedAt: new Date("2026-07-01T00:00:00Z"), invoices: [] }),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email")),
  sendBookingCancelledEmail: vi.fn(async () => {}),
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const MEMBER = "race-4909-member";
const LODGE = "race-4909-lodge";
const BOOKING = "race-4909-booking";
const CODES = ["race-4909-z", "race-4909-a"];
let prisma: PrismaClient;

(RUN ? describe : describe.skip)("Cancellation returns promo uses — PostgreSQL (#4909)", { timeout: 60000 }, () => {
  async function clean() {
    await releaseBookingJournalForTeardown(prisma, [BOOKING]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING } });
    await prisma.auditLog.deleteMany({ where: { targetId: BOOKING } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING } });
    const payments = await prisma.payment.findMany({ where: { bookingId: BOOKING }, select: { id: true } });
    const ids = payments.map((p) => p.id);
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING, ...ids] } } });
    await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: ids } } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { bookingId: BOOKING } });
    await prisma.promoRedemption.deleteMany({ where: { bookingId: BOOKING } });
    await prisma.promoCode.deleteMany({ where: { id: { in: CODES } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING } });
    await prisma.booking.deleteMany({ where: { id: BOOKING } });
  }
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "Cancelled booking promos");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await clean();
    await prisma.member.create({ data: { id: MEMBER, email: "promo-race-4909@example.invalid", passwordHash: "x", firstName: "Promo", lastName: "Race", ageTier: "ADULT" } });
    // No beds: a subsequent card settlement must fail capacity.
    await prisma.lodge.create({ data: { id: LODGE, name: "Promo Race", slug: "race-4909" } });
  });
  beforeEach(async () => {
    resetStripeRaceHooks();
    await clean();
    await prisma.booking.create({ data: { id: BOOKING, memberId: MEMBER, lodgeId: LODGE, checkIn: new Date("2027-08-01"), checkOut: new Date("2027-08-03"), status: "PAYMENT_PENDING", totalPriceCents: 20000, finalPriceCents: 18000 } });
    await prisma.bookingGuest.create({ data: { bookingId: BOOKING, firstName: "Promo", lastName: "Race", memberId: MEMBER, ageTier: "ADULT", isMember: true, stayStart: new Date("2027-08-01"), stayEnd: new Date("2027-08-03"), priceCents: 20000 } });
    for (const id of CODES) {
      await prisma.promoCode.create({ data: { id, code: id.toUpperCase(), type: "PERCENTAGE", percentOff: 10, maxUsesPerMember: 1, maxRedemptionsTotal: 1, currentRedemptions: 1 } });
      // The compatibility trigger creates the allocation; the real release
      // must count and cascade it rather than trusting the discount scalar.
      await prisma.promoRedemption.create({ data: { bookingId: BOOKING, memberId: MEMBER, promoCodeId: id, discountCents: 1000, freeNightsUsed: 0 } });
    }
  });
  afterAll(async () => {
    resetStripeRaceHooks();
    if (!prisma) return;
    await clean();
    await prisma.lodge.delete({ where: { id: LODGE } });
    await prisma.member.delete({ where: { id: MEMBER } });
  });
  async function expectReleased() {
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING } })).status).toBe("CANCELLED");
    expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING } })).toBe(0);
    expect(await prisma.promoRedemptionAllocation.count({ where: { promoCodeId: { in: CODES } } })).toBe(0);
    expect((await prisma.promoCode.findMany({ where: { id: { in: CODES } } })).map((p) => p.currentRedemptions)).toEqual([0, 0]);
  }
  it("an unpaid bank hold expires, returns both codes and is a no-op on replay", async () => {
    await prisma.booking.update({ where: { id: BOOKING }, data: { status: "CONFIRMED" } });
    await prisma.payment.create({ data: { bookingId: BOOKING, amountCents: 18000, source: "INTERNET_BANKING", status: "PENDING", internetBankingHoldSlots: true, internetBankingHoldUntil: new Date("2026-06-30T00:00:00Z") } });
    const { releaseExpiredInternetBankingHolds } = await import("@/lib/internet-banking-payment-cron");
    expect((await releaseExpiredInternetBankingHolds()).released).toBe(1);
    await expectReleased();
    expect((await releaseExpiredInternetBankingHolds()).released).toBe(0);
    await expectReleased();
    // A new booking for this member can reserve each single-use code again:
    // both the per-member allocation query and total cap are back to zero.
    for (const promoCodeId of CODES) {
      expect(await prisma.promoRedemptionAllocation.count({ where: { promoCodeId, memberId: MEMBER } })).toBe(0);
    }
  });
  it("a two-code card booking loses capacity and releases every allocation atomically", async () => {
    stripeRaceHooks.refund = async () => { throw new Error("offline provider double; recovery remains queued"); };
    const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
    await markBookingPaymentSucceeded({ bookingId: BOOKING, paymentIntentId: "pi_race_4909", amountCents: 18000, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    await expectReleased();
  });
  it("a release rolled back with its cancellation leaves both codes and counters intact", async () => {
    const { releaseBookingPromoRedemptions } = await import("@/lib/promo");
    await expect(prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: BOOKING }, data: { status: "CANCELLED" } });
      await releaseBookingPromoRedemptions(tx, BOOKING);
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING } })).toBe(2);
    expect((await prisma.promoCode.findMany({ where: { id: { in: CODES } } })).map((p) => p.currentRedemptions)).toEqual([1, 1]);
  });
});
