/**
 * #4660 against real PostgreSQL: the two writers that settle a booking PAID
 * because account credit (or a $0 price) leaves nothing to pay post its
 * confirmation in their own transaction, as every other PAID does: the legacy
 * confirmation lines and the member-money journal's R01, once.
 *
 * The create is the real `createConfirmedBooking`, its credit applied and the
 * booking settled inside its transaction. The pay step is the real
 * `POST /api/payments/create-payment-intent`, honouring a stored credit
 * election that covers the whole price (`settleFullyCreditCoveredBooking`).
 * A replay of each changes nothing: the confirmation's own fence, and the pay
 * step's status-guarded claim. The judge is the database's deferred checks at
 * each commit and the census's `JOURNAL` comparison.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4660-";
const names = historyNames(PREFIX);
const JOURNAL = memberMoneyTestContext();
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const HISTORY_PRICE = 20_000;
const SEASON = `${PREFIX}season`;
const STAY_IN = new Date("2027-08-01T00:00:00.000Z");
const STAY_OUT = new Date("2027-08-03T00:00:00.000Z");
/** One full member, two nights at 40.00: what the real create prices. */
const CREATE_PRICE = 8_000;

let prisma: PrismaClient;
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let confirmation: typeof import("@/lib/booking-ledger-confirmation-sync");
let lodgeLock: typeof import("@/lib/lodge-capacity-lock");
let payRoute: typeof import("@/app/api/payments/create-payment-intent/route");

/** The journal events a booking posted, oldest first. */
async function events(bookingId: string) {
  return prisma.memberMoneyEvent.findMany({
    where: { sourceKind: "BOOKING", sourceIdentity: bookingId },
    orderBy: [{ recordedAt: "asc" }, { eventKey: "asc" }],
    select: { eventKey: true, kind: true },
  });
}

async function confirmationLines(bookingId: string): Promise<number> {
  return prisma.bookingLedgerLine.count({ where: { bookingId, anchorKind: "CONFIRMATION" } });
}

/** The census's JOURNAL identity agrees with the booking's price, and no line is left unbridged. */
async function expectJournalAgrees(bookingId: string, cents: number): Promise<void> {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  const identity = evaluation.identities.find((candidate) => candidate.identity === "JOURNAL");
  expect(identity, `${bookingId}: ${JSON.stringify(evaluation.identities)}`).toMatchObject({ status: "AGREE", columnCents: cents, ledgerCents: cents });
  expect(evaluation.integrity.filter((finding) => finding.kind === "UNBRIDGED_CHARGE_LINE" || finding.kind === "CONFIRMED_WITHOUT_R01")).toEqual([]);
}

/** A retry of the confirmation sync, under the locks a door holds: it must post nothing. */
async function confirmAgain(bookingId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lodgeLock.acquireLodgeCapacityLock(tx, names.lodgeId);
    await confirmation.postStoredBookingConfirmationLedgerLines(tx, bookingId, JOURNAL);
  });
}

async function grantCredit(cents: number): Promise<void> {
  await prisma.memberCredit.create({ data: { memberId: names.memberId, amountCents: cents, type: "ADMIN_ADJUSTMENT", description: "#4660 proof" } });
}

async function payStep(bookingId: string): Promise<number> {
  raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
  try {
    const response = await payRoute.POST(new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST", body: JSON.stringify({ bookingId }), headers: { "content-type": "application/json" },
    }));
    return response.status;
  } finally {
    raceSession.current = null;
  }
}

(RUN ? describe : describe.skip)("credit-covered PAID writers post their confirmation — real PostgreSQL (#4660)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Credit-covered confirmation");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    census = await import("@/lib/booking-ledger-projection-census-store");
    confirmation = await import("@/lib/booking-ledger-confirmation-sync");
    lodgeLock = await import("@/lib/lodge-capacity-lock");
    payRoute = await import("@/app/api/payments/create-payment-intent/route");
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await prisma.member.update({ where: { id: names.memberId }, data: { canLogin: true } });
    await seedPricing();
  }, 120_000);

  async function cleanup() {
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
    await prisma.season.deleteMany({ where: { id: SEASON } });
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: names.lodgeId } });
    await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: names.memberId } });
    await prisma.memberSubscription.deleteMany({ where: { memberId: names.memberId } });
    await cleanHistories(prisma, PREFIX);
  }

  /** The rates and lodge setting the real create prices against (the history support seeds none). */
  async function seedPricing() {
    await prisma.lodgeSettings.create({ data: { id: names.lodgeId, lodgeId: names.lodgeId, capacity: 10 } });
    const fullMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "FULL" } });
    await prisma.seasonalMembershipAssignment.create({ data: { memberId: names.memberId, seasonYear: 2027, membershipTypeId: fullMember.id } });
    await prisma.memberSubscription.create({ data: { memberId: names.memberId, seasonYear: 2027, status: "PAID", paidAt: new Date("2026-06-01T00:00:00.000Z") } });
    await prisma.season.create({ data: { id: SEASON, name: "Race 4660 season", lodgeId: names.lodgeId, type: "WINTER", active: true,
      startDate: new Date("2027-06-01T00:00:00.000Z"), endDate: new Date("2027-09-30T00:00:00.000Z"),
      membershipTypeRates: { create: [
        { membershipTypeId: fullMember.id, ageTier: "ADULT", pricePerNightCents: 4_000 },
        { membershipTypeId: fullMember.id, ageTier: null, pricePerNightCents: 4_000 },
      ] },
    } });
  }

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
  }, 120_000);

  it("a create its credit fully covers settles PAID with its confirmation lines and one R01; a replay posts nothing", async () => {
    await grantCredit(CREATE_PRICE);
    const { createConfirmedBooking } = await import("@/lib/booking-create");
    const { bookingGuestDietarySeeding } = await import("@/lib/member-dietary-booking-writes");
    const { requireCalendarDate } = await import("@/lib/club-time");
    const outcome = await createConfirmedBooking({
      format: CLUB_FORMAT_TEST, todayAtClub: requireCalendarDate("2026-07-01"), journal: JOURNAL,
      effectiveMemberId: names.memberId, isOnBehalf: true, sessionUserId: names.officerId, lodgeId: names.lodgeId,
      checkIn: STAY_IN, checkOut: STAY_OUT,
      guests: [{ firstName: "History", lastName: "Proof", ageTier: "ADULT", isMember: true, memberId: names.memberId, stayStart: STAY_IN, stayEnd: STAY_OUT }],
      status: "PAYMENT_PENDING", shouldBePending: false, holdDays: 7, notifyMember: false,
      applyCreditCents: CREATE_PRICE,
      guestDietarySeeding: bookingGuestDietarySeeding(false),
    });
    expect(outcome.type, JSON.stringify(outcome)).toBe("created");
    const created = outcome as Extract<typeof outcome, { type: "created" }>;
    expect(created.isZeroDollarConfirmed).toBe(true);
    const id = created.booking.id;
    expect(created.booking.finalPriceCents).toBe(CREATE_PRICE);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: "PAID" });

    expect(await confirmationLines(id)).toBe(2);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE" }]);
    await confirmAgain(id);
    expect(await confirmationLines(id)).toBe(2);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE" }]);
    await expectJournalAgrees(id, CREATE_PRICE);
  });

  it("the pay step settling a booking its stored credit election covers posts its confirmation once; a second pay attempt posts nothing", async () => {
    const id = `${PREFIX}election`;
    await createHistoryBooking(prisma, names, id, { payment: null });
    await prisma.booking.update({ where: { id }, data: { creditElectionCents: HISTORY_PRICE } });
    await grantCredit(HISTORY_PRICE);
    expect(await events(id)).toEqual([]);

    expect(await payStep(id)).toBe(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: "PAID" });
    expect(await confirmationLines(id)).toBe(4);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE" }]);

    // A paid booking is no longer payable: the route refuses before any write.
    expect(await payStep(id)).toBe(400);
    await confirmAgain(id);
    expect(await confirmationLines(id)).toBe(4);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE" }]);
    await expectJournalAgrees(id, HISTORY_PRICE);
  });
});
