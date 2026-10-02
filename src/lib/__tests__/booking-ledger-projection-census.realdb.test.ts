/**
 * Real-PostgreSQL proof of the booking-ledger projection census (#3583,
 * `INV-MONEY-037`).
 *
 * The unit suite proves the identities and classes on lines the planners
 * wrote. What it cannot show is the census reading what the REAL writers left
 * in a real database, through its own one-snapshot store: so here bookings are
 * built only through the writers production uses, and the census must find
 * nothing to say about them. Four claims:
 *
 *  1. A card booking confirmed by the real settle (`markBookingPaymentSucceeded`),
 *     re-dated through the real admin date shift and part-refunded through the
 *     real card-refund writer agrees on every identity.
 *  2. A booking paid partly with account credit (`applyCreditToBooking`) and
 *     the rest by card agrees, the credit identity included.
 *  3. A cash booking settled through the real mark-paid, cancelled through the
 *     real `cancelBooking` at a 50% tier, reads as an in-flight hand-back until
 *     the real resolver completes it, and then agrees, its refunded total
 *     named as a hand-back.
 *  4. One rogue line posted through the write door is named: a disagreement
 *     with both figures and the delta, and the line as source drift.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3583-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3583-member";
const OFFICER_ID = "race-3583-officer";
const LODGE_ID = "race-3583-lodge";
const ROOM_ID = "race-3583-room";
const CARD = "race-3583-card";
const CREDIT = "race-3583-credit";
const CASH = "race-3583-cash";
const BOOKINGS = [CARD, CREDIT, CASH];
// A stay well after today, in the policy's one tier.
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeProjectionCensusRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Projection-census proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run projection-census proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Projection-census proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Projection-census proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let censusStore: typeof import("@/lib/booking-ledger-projection-census-store");

async function clean(): Promise<void> {
  const where = { bookingId: { in: BOOKINGS } };
  await prisma.bookingLedgerLine.deleteMany({ where });
  await prisma.bedAllocation.deleteMany({ where });
  await prisma.bookingModification.deleteMany({ where });
  await prisma.bookingEvent.deleteMany({ where });
  await prisma.manualRefundTask.deleteMany({ where });
  await prisma.paymentRecoveryOperation.deleteMany({ where });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  const payments = await prisma.payment.findMany({ where, select: { id: true } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
  await prisma.payment.deleteMany({ where });
  await prisma.bookingGuest.deleteMany({ where });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKINGS } } });
}

async function createBooking(id: string, payment: { amountCents: number; source: "STRIPE" | "INTERNET_BANKING"; intent?: string } | null) {
  await prisma.booking.create({
    // Admitted by an officer over capacity (#1771), so the settle's capacity
    // check passes on a lodge this suite gives no capacity setting.
    data: {
      id,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn: D1,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: 20_000,
      finalPriceCents: 20_000,
      capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
      capacityOverriddenByMemberId: OFFICER_ID,
    },
  });
  for (const guest of ["g1", "g2"]) {
    await prisma.bookingGuest.create({
      data: {
        id: `${id}-${guest}`,
        bookingId: id,
        firstName: "Census",
        lastName: guest,
        ageTier: "ADULT",
        isMember: true,
        stayStart: D1,
        stayEnd: CHECK_OUT,
        priceCents: 10_000,
        nights: { create: [{ stayDate: D1, priceCents: 5_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
      },
    });
  }
  if (!payment) return;
  await prisma.payment.create({
    data: {
      id: `${id}-payment`,
      bookingId: id,
      amountCents: payment.amountCents,
      source: payment.source,
      status: "PENDING",
      stripePaymentIntentId: payment.intent ?? null,
    },
  });
}

async function census(): Promise<BookingLedgerCensusReport> {
  return censusStore.censusBookingLedgerProjection(prisma);
}

/** Everything the report says about one booking, so another suite's rows cannot colour it. */
function about(report: BookingLedgerCensusReport, bookingId: string) {
  return {
    disagreements: report.disagreements.filter((row) => row.bookingId === bookingId),
    coverage: Object.entries(report.coverage).flatMap(([kind, ids]) => (ids.includes(bookingId) ? [kind] : [])),
    integrity: report.integrity.findings.filter((finding) => finding.bookingId === bookingId).map((finding) => finding.kind),
    classes: Object.entries(report.classes).flatMap(([name, entry]) =>
      entry.instances.filter((instance) => instance.bookingId === bookingId).map((instance) => `${name}:${instance.identity}`),
    ),
  };
}

const NOTHING = { disagreements: [], coverage: [], integrity: [], classes: [] };

(RUN ? describe : describe.skip)("the booking-ledger projection census, against PostgreSQL and the real writers (#3583)", () => {
  beforeAll(async () => {
    assertSafeProjectionCensusRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    censusStore = await import("@/lib/booking-ledger-projection-census-store");

    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
    await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    for (const id of [MEMBER_ID, OFFICER_ID]) {
      await prisma.member.create({
        data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Proof", ageTier: "ADULT" },
      });
    }
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3583 Lodge", slug: "race-3583" } });
    await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 3583 Room" } });
    await prisma.lodgeBed.createMany({
      data: Array.from({ length: 8 }, (_, index) => ({ id: `race-3583-bed-${index}`, roomId: ROOM_ID, name: `Bed ${index}`, bedType: "SINGLE" as const })),
    });
    // One tier: half back, however far ahead.
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
    await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
  });

  it("a card booking settled, re-dated and part-refunded by the real writers agrees on every identity", async () => {
    await createBooking(CARD, { amountCents: 20_000, source: "STRIPE", intent: "pi_race_3583_card" });
    const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
    const settled = await markBookingPaymentSucceeded({ bookingId: CARD, paymentIntentId: "pi_race_3583_card", amountCents: 20_000, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    expect(settled.outcome).toBe("paid");

    const { adminShiftBookingDates } = await import("@/lib/booking-date-modification-service");
    await adminShiftBookingDates({
      bookingId: CARD,
      actor: { id: OFFICER_ID, role: "ADMIN" },
      input: { checkIn: "2027-08-08", checkOut: "2027-08-10", confirmOverCapacity: true, notifyMember: false },
      ipAddress: "127.0.0.1",
    });

    const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
    const capture = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${CARD}-payment`, kind: "PRIMARY" }, select: { id: true } });
    await recordStripeRefundsAgainstTransaction({
      paymentId: `${CARD}-payment`,
      paymentTransactionId: capture.id,
      refunds: [{ id: "re_race_3583_goodwill", amount: 3_000, currency: "nzd", status: "succeeded", created: null }],
      store: prisma,
    });

    const lines = await prisma.bookingLedgerLine.findMany({ where: { bookingId: CARD }, select: { kind: true, anchorKind: true } });
    expect(lines.filter((line) => line.anchorKind === "CONFIRMATION")).toHaveLength(4);
    expect(lines.some((line) => line.anchorKind === "MODIFICATION")).toBe(true);
    expect(lines.some((line) => line.kind === "CARD_REFUND")).toBe(true);
    expect(about(await census(), CARD)).toEqual(NOTHING);
  }, 120_000);

  it("account credit applied by the real writer, the rest by card: the credit identity agrees too", async () => {
    // No payment row yet: the settle creates it and writes its credit mirror,
    // as it does for a booking whose member paid the rest by card.
    await createBooking(CREDIT, null);
    await prisma.memberCredit.create({ data: { memberId: MEMBER_ID, amountCents: 10_000, type: "ADMIN_ADJUSTMENT", description: "race 3583 opening balance" } });
    const credit = await import("@/lib/member-credit");
    await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, 4_000, CREDIT, tx, CLUB_FORMAT_TEST));
    const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
    const settled = await markBookingPaymentSucceeded({ bookingId: CREDIT, paymentIntentId: "pi_race_3583_credit", amountCents: 16_000, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    expect(settled.outcome).toBe("paid");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: CREDIT }, select: { creditAppliedCents: true } });
    expect(payment.creditAppliedCents).toBe(4_000);
    expect(about(await census(), CREDIT)).toEqual(NOTHING);
  }, 120_000);

  it("cash marked paid, cancelled at 50% by the real cancelBooking: an in-flight hand-back until the real resolver completes it", async () => {
    await createBooking(CASH, { amountCents: 20_000, source: "INTERNET_BANKING" });
    const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
    await markBookingPaymentManuallySettled({ bookingId: CASH, actingAdminMemberId: OFFICER_ID, note: "cash at the lodge", expectedAmountCents: 20_000, notifyMember: false, format: CLUB_FORMAT_TEST });

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const cancelled = await cancelBooking(CASH, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(cancelled.status).toBe(200);
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: CASH }, select: { id: true, amountCents: true } });
    expect(task.amountCents).toBe(10_000);

    const inFlight = about(await census(), CASH);
    expect(inFlight).toEqual({ ...NOTHING, classes: ["IN_FLIGHT_HAND_BACK:PRICE"] });

    const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
    await resolveManualRefundTask(
      { taskId: task.id, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
      CLUB_FORMAT_TEST,
    );
    expect(about(await census(), CASH)).toEqual({ ...NOTHING, classes: ["REFUND_MIRROR_HAND_BACK:REFUNDED"] });
  }, 120_000);

  it("names one rogue line posted through the write door: a disagreement with both figures, and source drift", async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { bookingId: CARD }, select: { amountCents: true } });
    const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
    await prisma.$transaction((tx) =>
      postBookingLedgerLines(tx, [
        {
          bookingId: CARD,
          lodgeId: LODGE_ID,
          side: "SETTLEMENT",
          kind: "CARD_CAPTURE",
          sign: 1,
          quantity: 1,
          unitCents: 1,
          anchorKind: "PAYMENT_TRANSACTION",
          anchorId: "race-3583-rogue",
          settlementMethod: "CARD",
          narration: "Rogue",
          postingKey: "capture:race-3583-rogue",
        },
      ]),
    );
    const rogue = await prisma.bookingLedgerLine.findUniqueOrThrow({ where: { postingKey: "capture:race-3583-rogue" }, select: { id: true } });
    const report = await census();
    expect(about(report, CARD).disagreements).toEqual([
      { bookingId: CARD, identity: "CAPTURED", columnCents: before.amountCents, ledgerCents: before.amountCents + 1, deltaCents: -1 },
    ]);
    expect(report.integrity.findings.filter((finding) => finding.bookingId === CARD)).toEqual([
      expect.objectContaining({ lineId: rogue.id, kind: "SOURCE_DRIFT" }),
    ]);
    expect(report.verdict).toBe("GATE_CLOSED");
  }, 120_000);
});
