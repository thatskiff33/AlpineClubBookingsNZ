/**
 * Real-PostgreSQL proof of the nightly booking money check (#4910,
 * `INV-PAY-163`).
 *
 * The unit suite proves the summary and the alert rules on injected census
 * reports. What it cannot show is the job reading a real database through the
 * censuses' own snapshot stores, and writing nothing but its alert claims. So
 * two card bookings are settled by the real settle; one then has its payment
 * column moved away from its ledger lines. Three claims:
 *
 *  1. The run's summary names the disagreeing booking and not the consistent
 *     one.
 *  2. Every table but `AlertCooldown` holds as many rows after the run as
 *     before. (`CronJobRun` is written by the scheduler, not by this run, and
 *     the alert's email rows by the real send, which is replaced here.)
 *  3. The finding is alerted once: a second run, after the other booking has
 *     drifted too, sends the new finding and not the first again.
 *
 * Ordinary Vitest runs skip the file. Sekreton's `kept-change-realdb` check
 * runs it against a disposable loopback PostgreSQL; it cleans its own
 * `race-4910-` rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import type { BookingMoneyCensusSummary } from "@/lib/booking-money-census-summary";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4910-member";
const OFFICER_ID = "race-4910-officer";
const LODGE_ID = "race-4910-lodge";
const ROOM_ID = "race-4910-room";
const CONSISTENT = "race-4910-consistent";
const DRIFTED = "race-4910-drifted";
const BOOKINGS = [CONSISTENT, DRIFTED];
const KEY_PREFIX = "booking-money-census:";
const D1 = new Date("2027-09-01T00:00:00.000Z");
const D2 = new Date("2027-09-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-03T00:00:00.000Z");
const DELIVERED = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };

let prisma: PrismaClient;
let job: typeof import("@/lib/cron-booking-money-census");

async function clean(): Promise<void> {
  const where = { bookingId: { in: BOOKINGS } };
  const payments = await prisma.payment.findMany({ where, select: { id: true } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...BOOKINGS, ...payments.map((p) => p.id)] } } });
  await releaseBookingJournalForTeardown(prisma, BOOKINGS);
  await prisma.bookingLedgerLine.deleteMany({ where });
  await prisma.bedAllocation.deleteMany({ where });
  await prisma.bookingEvent.deleteMany({ where });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
  await prisma.payment.deleteMany({ where });
  await prisma.bookingGuest.deleteMany({ where });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKINGS } } });
  await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: KEY_PREFIX } } });
}

async function cleanFixtures(): Promise<void> {
  await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
  await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
}

/** A two-night, two-guest card booking settled by the real settle. */
async function settledCardBooking(id: string): Promise<void> {
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
  const intent = `pi_${id.replaceAll("-", "_")}`;
  await prisma.payment.create({
    data: { id: `${id}-payment`, bookingId: id, amountCents: 20_000, source: "STRIPE", status: "PENDING", stripePaymentIntentId: intent },
  });
  const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
  const settled = await markBookingPaymentSucceeded({ bookingId: id, paymentIntentId: intent, amountCents: 20_000, paymentMethodId: null, format: CLUB_FORMAT_TEST });
  expect(settled.outcome).toBe("paid");
}

/** Rows in every table of the schema, by table. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name`;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`);
    counts[name] = Number(row.n);
  }
  return counts;
}

/** The census classes the summary names `bookingId` under. */
function classesNaming(summary: BookingMoneyCensusSummary, bookingId: string): string[] {
  return summary.classes.filter((entry) => entry.bookingIds.includes(bookingId)).map((entry) => entry.class);
}

(RUN ? describe : describe.skip)("the nightly booking money check, against PostgreSQL (#4910)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Nightly booking money check");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    job = await import("@/lib/cron-booking-money-census");

    await clean();
    await cleanFixtures();
    for (const id of [MEMBER_ID, OFFICER_ID]) {
      await prisma.member.create({
        data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Proof", ageTier: "ADULT" },
      });
    }
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4910 Lodge", slug: "race-4910" } });
    await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 4910 Room" } });
    await prisma.lodgeBed.createMany({
      data: Array.from({ length: 4 }, (_, index) => ({ id: `race-4910-bed-${index}`, roomId: ROOM_ID, name: `Bed ${index}`, bedType: "SINGLE" as const })),
    });

    await settledCardBooking(CONSISTENT);
    await settledCardBooking(DRIFTED);
    // The payment column now says less was captured than its ledger lines do.
    await prisma.payment.update({ where: { bookingId: DRIFTED }, data: { amountCents: 19_000 } });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await cleanFixtures();
  });

  it("names the disagreeing booking, not the consistent one, writes only its alert claims, and alerts once", async () => {
    const before = await rowCounts();
    const sendAlert = vi.fn(async () => DELIVERED);

    const summary = await job.runBookingMoneyCensus({ sendAlert });

    expect(summary.verdict).toBe("GATE_CLOSED");
    expect(classesNaming(summary, DRIFTED)).toContain("disagreement:CAPTURED");
    expect(classesNaming(summary, CONSISTENT)).toEqual([]);

    const after = await rowCounts();
    const changed = Object.keys({ ...before, ...after }).filter((table) => before[table] !== after[table]);
    expect(changed).toEqual(["AlertCooldown"]);
    await expect(
      prisma.alertCooldown.count({ where: { key: `${KEY_PREFIX}disagreement:CAPTURED:${DRIFTED}` } }),
    ).resolves.toBe(1);

    // The first night sends the finding. By the second, another booking has
    // drifted: that one is sent, the first is not sent again.
    const alerted = () => sendAlert.mock.calls.map((call) => JSON.stringify(call));
    expect(alerted().some((call) => call.includes(DRIFTED))).toBe(true);
    const sentBefore = sendAlert.mock.calls.length;
    await prisma.payment.update({ where: { bookingId: CONSISTENT }, data: { amountCents: 19_500 } });
    const again = await job.runBookingMoneyCensus({ sendAlert });
    expect(classesNaming(again, DRIFTED)).toContain("disagreement:CAPTURED");
    expect(classesNaming(again, CONSISTENT)).toContain("disagreement:CAPTURED");
    const secondNight = alerted().slice(sentBefore);
    expect(secondNight.some((call) => call.includes(CONSISTENT))).toBe(true);
    expect(secondNight.some((call) => call.includes(DRIFTED))).toBe(false);
  }, 120_000);
});
