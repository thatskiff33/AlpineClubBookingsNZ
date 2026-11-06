/**
 * Real-PostgreSQL proof for #4317 (epic #4302): every booking edit door PRICES an
 * edit from stored data, and none sends it to an officer.
 *
 * Each case is a shape that #3031/#3166/#3170 PARKED as an `EDIT_FINANCIAL_REVIEW`
 * task, driven through the REAL door against real rows, with the dollar answer
 * the `valueStrandNights` rule (`INV-MOD-028`, owner decision D1) gives:
 *
 *  - the guest removal (`removeBookingGuestInTransaction`): T2 beside a
 *    companion with blank rows (T8), with the ledger posting the reversal;
 *  - the date change (`modifyBookingDates`): a shortening that keeps a blank
 *    night at its valued share (T7/T8), and a whole-stay move that buys every
 *    night fresh and is charged the ordinary change fee (T5, D8);
 *  - the batch edit (`modifyBookingBatch`): a guest added beside an existing
 *    guest with no usable rows (T1/T8), an extension of that guest (T4), and an
 *    in-progress shortening of a strand whose rows reach past its stored
 *    `stayEnd` (T6) beside one whose rows do not add up (T9);
 *  - the in-progress batch edit that leaves less to pay than the booking's
 *    promotion takes off (#4317 review rounds 3 and 4): the code is carried,
 *    never re-validated, and capped at what is left. Driven through the quote
 *    route and the save, it pins quote = save, the scaled redemption and
 *    allocation, the night rows left on the stay, the money reconciliation and the
 *    ledger's promotion lines - for an expired fixed code (guest-scope row) and
 *    a 100% code (night-scope rows).
 *
 * Every case also asserts that no `ManualRefundTask` was written.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/edit-auto-pricing-doors.realdb.test.ts
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { raceSession } from "@/lib/__tests__/support/race-session-double";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

// The quote route reads the session through `@/lib/auth`: the harness's one
// shared double, set per call on `raceSession` and put back to signed out.
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4317-owner";
const OFFICER_ID = "race-4317-officer";
const LODGE_ID = "race-4317-lodge";
const SEASON_ID = "race-4317-season";
const BOOKING_ID = "race-4317-booking";
const GUEST_A = "race-4317-guest-a";
const GUEST_B = "race-4317-guest-b";
const PROMO_CODE_ID = "race-4317-promo";
const SECOND_CODE_ID = "race-4317-promo-2";

/** Today's season rate for a non-member adult. */
const RATE = 5_000;
/** The frozen suite clock's day. */
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("The race DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) {
    throw new Error("The race DB name must carry 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let removalService: typeof import("@/lib/booking-guest-removal-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let clubTimeKernel: typeof import("@/lib/club-time");
let nightAdjustments: typeof import("@/lib/night-adjustment-write");
let reconciliationStore: typeof import("@/lib/booking-money-reconciliation-store");
let quoteRoute: typeof import("@/app/api/bookings/[id]/modify-quote/route");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

type SeedNight = { day: string; cents: number | null };
type SeedGuest = {
  id: string;
  total: number;
  nights: SeedNight[];
  /** The stored envelope, when it should differ from the rows (T6). */
  stayEnd?: string;
};

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function clean(): Promise<void> {
  const errors: unknown[] = [];
  while (pendingXeroWork.length > 0) {
    for (const result of await Promise.allSettled(pendingXeroWork.splice(0))) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  const localIds = [BOOKING_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { actorMemberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoRedemptionGuestTarget.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoRedemptionAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoRedemption.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  await prisma.promoCode.deleteMany({ where: { id: { in: [PROMO_CODE_ID, SECOND_CODE_ID] } } });
  if (errors.length > 0) {
    throw new AggregateError(errors, "#4317: a fixture's Xero enqueue failed; all work drained and owned fixtures cleaned");
  }
}

/** One booking, its guests and their rows, exactly as stored. */
async function seed(options: {
  checkIn: string;
  checkOut: string;
  status: "CONFIRMED" | "PAID" | "PAYMENT_PENDING";
  guests: SeedGuest[];
}): Promise<void> {
  const total = options.guests.reduce((sum, guest) => sum + guest.total, 0);
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: D(options.checkIn),
      checkOut: D(options.checkOut),
      status: options.status,
      totalPriceCents: total,
      finalPriceCents: total,
      hasNonMembers: true,
    },
  });
  for (const guest of options.guests) {
    const days = guest.nights.map((night) => night.day).sort();
    const lastNight = D(days[days.length - 1]!);
    await prisma.bookingGuest.create({
      data: {
        id: guest.id,
        bookingId: BOOKING_ID,
        firstName: "Guest",
        lastName: guest.id.slice(-1).toUpperCase(),
        ageTier: "ADULT",
        isMember: false,
        stayStart: D(days[0]!),
        stayEnd: guest.stayEnd ? D(guest.stayEnd) : new Date(lastNight.getTime() + 86_400_000),
        priceCents: guest.total,
        nights: {
          create: guest.nights.map((night) => ({
            stayDate: D(night.day),
            priceCents: night.cents,
            priceSource: night.cents === null ? ("UNKNOWN" as const) : ("SOLD" as const),
          })),
        },
      },
    });
  }
}

/** The booking's confirmation lines for one guest's priced nights, as the settle posts them. */
async function confirmGuest(guestId: string, nights: SeedNight[]): Promise<void> {
  for (const night of nights) {
    if (night.cents === null) continue;
    await prisma.bookingLedgerLine.create({
      data: {
        bookingId: BOOKING_ID,
        side: "CHARGE",
        kind: "GUEST_NIGHT",
        sign: 1,
        quantity: 1,
        unitCents: night.cents,
        amountCents: night.cents,
        bookingGuestId: guestId,
        nightStart: D(night.day),
        nightEndExclusive: new Date(D(night.day).getTime() + 86_400_000),
        ageTier: "ADULT",
        guestNames: [guestId],
        anchorKind: "CONFIRMATION",
        anchorId: BOOKING_ID,
        narration: "race 4317 confirmation",
        lodgeId: LODGE_ID,
        postingKey: `race-4317-confirm-${guestId}-${night.day}`,
      },
    });
  }
}

async function guestRow(id: string) {
  return prisma.bookingGuest.findUniqueOrThrow({
    where: { id },
    include: { nights: { orderBy: { stayDate: "asc" } } },
  });
}

async function rowsOf(id: string) {
  return (await guestRow(id)).nights.map((night) => [
    night.stayDate.toISOString().slice(0, 10),
    night.priceCents,
    night.priceSource,
  ]);
}

async function booking() {
  return prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } });
}

async function noReviewRaised(): Promise<void> {
  expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
}

async function batch(input: Record<string, unknown>) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

/**
 * The booking's promotion as a live booking holds it: the code, its redemption,
 * the engine's own figures written by the shared re-price on the day it was
 * still valid, the per-night (or per-guest) rows, and the confirmation's
 * PROMOTION line beside its night lines.
 */
type SeedCode = (
  | { type: "FIXED_AMOUNT"; valueCents: number }
  | { type: "PERCENTAGE"; percentOff: number }
  | { type: "FREE_NIGHTS"; freeNightsPerIndividual: number }
) & { maxGuestsPerBooking?: number };

async function seedPromotion(
  code: SeedCode,
  options: { validUntil?: string; pricedOn: string },
): Promise<number> {
  return seedPromotions([{ id: PROMO_CODE_ID, code, validUntil: options.validUntil }], options.pricedOn);
}

/**
 * Several codes, in their application order: a later code covers only the
 * nights no earlier code claimed (INV-MONEY-038/039), as the engine decides.
 */
async function seedPromotions(
  codes: Array<{ id: string; code: SeedCode; validUntil?: string }>,
  pricedOn: string,
): Promise<number> {
  for (const [order, entry] of codes.entries()) {
    await prisma.promoCode.create({
      data: {
        id: entry.id,
        code: `RACE4317-${order}`,
        ...entry.code,
        ...(entry.validUntil ? { validUntil: D(entry.validUntil) } : {}),
      },
    });
    await prisma.promoRedemption.create({
      data: {
        promoCodeId: entry.id,
        bookingId: BOOKING_ID,
        memberId: OWNER_ID,
        discountCents: 0,
        applicationOrder: order,
      },
    });
  }
  const promoAdjustmentCents = await prisma.$transaction(async (tx) => {
    const stored = await tx.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: {
        guests: { include: { nights: { orderBy: { stayDate: "asc" } } }, orderBy: { id: "asc" } },
        promoRedemptions: {
          include: {
            guestTargets: { select: { bookingGuestId: true } },
            promoCode: {
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
            },
          },
        },
      },
    });
    const repriced = await removalService.recalculateBookingPromo({
      tx,
      bookingId: BOOKING_ID,
      booking: stored,
      newTotalPriceCents: stored.totalPriceCents,
      guestNightRates: stored.guests.map((guest) => ({
        bookingGuestId: guest.id,
        memberId: null,
        isMember: false,
        perNightRates: guest.nights.map((night) => night.priceCents ?? 0),
        nightDates: guest.nights.map((night) => night.stayDate),
        firstNight: guest.nights[0]!.stayDate,
        consentStatus: null,
      })),
      todayAtClub: clubTimeKernel.requireCalendarDate(pricedOn),
    });
    await tx.booking.update({
      where: { id: BOOKING_ID },
      data: {
        promoAdjustmentCents: repriced.newPromoAdjustmentCents,
        discountCents: repriced.newDiscountCents,
        finalPriceCents: stored.totalPriceCents + repriced.newPromoAdjustmentCents,
      },
    });
    await nightAdjustments.recordBookingNightAdjustments(tx, {
      bookingId: BOOKING_ID,
      guestIds: stored.guests.map((guest) => guest.id),
      targets: repriced.adjustmentTargets,
      writer: "race 4317 seed",
      format: CLUB_FORMAT_TEST,
    });
    return repriced.newPromoAdjustmentCents;
  });
  await prisma.bookingLedgerLine.create({
    data: {
      bookingId: BOOKING_ID,
      side: "CHARGE",
      kind: "PROMOTION",
      sign: -1,
      quantity: 1,
      unitCents: -promoAdjustmentCents,
      amountCents: promoAdjustmentCents,
      anchorKind: "CONFIRMATION",
      anchorId: BOOKING_ID,
      narration: "race 4317 promotion",
      lodgeId: LODGE_ID,
      postingKey: "race-4317-confirm-promotion",
    },
  });
  return promoAdjustmentCents;
}

/** What `POST /api/bookings/[id]/modify-quote` answers the officer, through the real route. */
async function quote(body: Record<string, unknown>) {
  const { NextRequest } = await import("next/server");
  raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: ["ADMIN"], canLogin: true } };
  try {
    const response = await quoteRoute.POST(
      new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/modify-quote`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: BOOKING_ID }) },
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    return json as {
      newTotalPriceCents: number;
      newDiscountCents: number;
      newPromoAdjustmentCents: number;
      newFinalPriceCents: number;
      priceDiffCents: number;
      changeFeeCents: number;
    };
  } finally {
    raceSession.current = null;
  }
}

async function removeGuest(guestId: string) {
  return prisma.$transaction(
    (tx) =>
      removalService.removeBookingGuestInTransaction({
        tx,
        bookingId: BOOKING_ID,
        guestId,
        actorMemberId: OFFICER_ID,
        actorRole: "ADMIN",
        today: TODAY,
        format: CLUB_FORMAT_TEST,
        journal: memberMoneyTestContext(),
      }),
    { maxWait: 10_000, timeout: 20_000 },
  );
}

(RUN ? describe : describe.skip)(
  "#4317: every edit door prices from stored data and raises no review - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      batchService = await import("@/lib/booking-batch-modification-service");
      dateService = await import("@/lib/booking-date-modification-service");
      removalService = await import("@/lib/booking-guest-removal-service");
      clubTimeServer = await import("@/lib/club-time/server");
      clubTimeKernel = await import("@/lib/club-time");
      nightAdjustments = await import("@/lib/night-adjustment-write");
      reconciliationStore = await import("@/lib/booking-money-reconciliation-store");
      quoteRoute = await import("@/app/api/bookings/[id]/modify-quote/route");
      const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
      const queue = xeroQueue.queueXeroBookingEditSettlement;
      const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
        const pending = queue(input);
        if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
        return pending;
      });
      restoreXeroQueue = () => spy.mockRestore();

      await clean();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });

      for (const [id, role] of [
        [OWNER_ID, Role.USER],
        [OFFICER_ID, Role.ADMIN],
      ] as const) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: id === OWNER_ID ? "Owner" : "Officer",
            lastName: "Proof",
            ageTier: "ADULT",
            canLogin: true,
            role,
          },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4317 Lodge", slug: "race-4317" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 20 } });
      // 45+ days out refunds in full; closer keeps half. A move from inside 45
      // days to outside it is to a more lenient tier, so it carries a fee (D8).
      await prisma.cancellationPolicy.createMany({
        data: [
          { lodgeId: LODGE_ID, daysBeforeStay: 45, refundPercentage: 100, creditRefundPercentage: 100 },
          { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
        ],
      });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.create({
        data: {
          id: SEASON_ID,
          name: "Race 4317 season",
          type: "WINTER",
          startDate: D("2026-06-01"),
          endDate: D("2026-09-30"),
          active: true,
          lodgeId: LODGE_ID,
          membershipTypeRates: {
            create: [
              { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: RATE },
              { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: RATE },
            ],
          },
        },
      });
    }, 120_000);

    beforeEach(async () => {
      await clean();
    });

    afterAll(async () => {
      try {
        if (!prisma) return;
        await clean();
        await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
        await prisma.season.deleteMany({ where: { id: SEASON_ID } });
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
        await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
        await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
        await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
      } finally {
        restoreXeroQueue?.();
      }
    });

    it("guest removal T2/T8: credits the departing guest's $120 beside a companion with blank rows, and posts the reversal", async () => {
      const leaving: SeedNight[] = [
        { day: "2026-08-10", cents: 6_000 },
        { day: "2026-08-11", cents: 6_000 },
      ];
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "CONFIRMED",
        guests: [
          { id: GUEST_A, total: 12_000, nights: leaving },
          // No usable rows: valued at $50 each (R2) from its stored $100.
          { id: GUEST_B, total: 10_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });
      await confirmGuest(GUEST_A, leaving);

      const result = await removeGuest(GUEST_A);

      expect(result.priceDiffCents).toBe(-12_000);
      expect((await booking()).totalPriceCents).toBe(10_000);
      expect((await booking()).finalPriceCents).toBe(10_000);
      // The companion keeps its stored total, and a removal rewrites nobody
      // else's rows: its blanks are left as they were.
      expect((await guestRow(GUEST_B)).priceCents).toBe(10_000);
      expect(await rowsOf(GUEST_B)).toEqual([
        ["2026-08-10", null, "UNKNOWN"],
        ["2026-08-11", null, "UNKNOWN"],
      ]);
      await noReviewRaised();
      // The ledger reverses the departing guest's two confirmation lines.
      const reversals = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, reversesLineId: { not: null } },
      });
      expect(reversals.map((line) => line.sign * line.unitCents * line.quantity)).toEqual([-6_000, -6_000]);
    });

    // D11 (a negative stored total valued at $0) is NOT exercised here, and
    // cannot be: `BookingGuest_price_nonnegative` (#2797, NOT VALID) refuses a
    // negative total on every INSERT and UPDATE, and the 11 Aug 2026 audit
    // measured the existing population at zero. The rule is pinned at the
    // planner and door unit level (`booking-edit-guest-ranges-sparse`,
    // `booking-guest-consent-authority`, `booking-edit-quote-save-parity`).

    it("date change T7/T8: a shortening keeps the blank night at its $50 share and credits the $40 night given back", async () => {
      // $40 + blank + $40 against a stored $130: the blank is worth $50 (R2).
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
        status: "PAYMENT_PENDING",
        guests: [
          {
            id: GUEST_A,
            total: 13_000,
            nights: [
              { day: "2026-08-10", cents: 4_000 },
              { day: "2026-08-11", cents: null },
              { day: "2026-08-12", cents: 4_000 },
            ],
          },
        ],
      });

      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-10", checkOut: "2026-08-12" } as never,
        ipAddress: "127.0.0.1",
      });

      expect(result.priceDiffCents).toBe(-4_000);
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_000, "SOLD"],
        ["2026-08-11", 5_000, "EVEN_SPLIT"],
      ]);
      await noReviewRaised();
    });

    it("date change T5/D8: a whole-stay move buys every night fresh and is charged the ordinary change fee", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
        status: "PAYMENT_PENDING",
        guests: [
          {
            id: GUEST_A,
            total: 13_000,
            nights: [
              { day: "2026-08-10", cents: 4_000 },
              { day: "2026-08-11", cents: null },
              { day: "2026-08-12", cents: 4_000 },
            ],
          },
        ],
      });

      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-20", checkOut: "2026-08-23" } as never,
        ipAddress: "127.0.0.1",
      });

      // The stored $130 is given back and three nights bought at $50: +$20.
      expect(result.priceDiffCents).toBe(2_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-20", RATE, "SOLD"],
        ["2026-08-21", RATE, "SOLD"],
        ["2026-08-22", RATE, "SOLD"],
      ]);
      // 40 days out to 50 days out crosses into the 100% tier: half the
      // original $130 is the fee, charged as on any edit (D8).
      expect(result.changeFeeCents).toBe(6_500);
      await noReviewRaised();
    });

    it("batch T1/T8: a guest added beside a strand with no usable rows charges exactly the added guest", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "PAYMENT_PENDING",
        guests: [
          { id: GUEST_A, total: 9_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });

      const result = await batch({
        addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }],
      });

      expect(result.priceDiffCents).toBe(2 * RATE);
      expect((await booking()).totalPriceCents).toBe(9_000 + 2 * RATE);
      // The existing guest keeps its $90, its blanks written at their $45 share.
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_500, "EVEN_SPLIT"],
        ["2026-08-11", 4_500, "EVEN_SPLIT"],
      ]);
      await noReviewRaised();
    });

    it("batch T4: an extension of a strand with no usable rows buys only the new night", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "PAYMENT_PENDING",
        guests: [
          { id: GUEST_A, total: 9_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });

      const result = await batch({ checkOut: "2026-08-13" });

      expect(result.priceDiffCents).toBe(RATE);
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000 + RATE);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_500, "EVEN_SPLIT"],
        ["2026-08-11", 4_500, "EVEN_SPLIT"],
        ["2026-08-12", RATE, "SOLD"],
      ]);
      await noReviewRaised();
    });

    it("batch in progress T6/T9: a shortening prices a strand whose rows outrun its stayEnd and one whose rows do not add up", async () => {
      // Under way: the frozen day is 1 July, so the edit window opens on 2 July.
      const run = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];
      await seed({
        checkIn: "2026-06-29",
        checkOut: "2026-07-03",
        status: "PAID",
        guests: [
          // T6: four $50 rows, but the stored stayEnd stops a morning short.
          { id: GUEST_A, total: 20_000, nights: run.map((day) => ({ day, cents: RATE })), stayEnd: "2026-07-02" },
          // T9: four $50 rows against a stored $201.01 — R3 splits the total:
          // $50.26, $50.25, $50.25, $50.25.
          { id: GUEST_B, total: 20_101, nights: run.map((day) => ({ day, cents: RATE })) },
        ],
      });

      const result = await batch({ checkOut: "2026-07-02", settlementMethod: "card" });

      // The 2nd is given back: $50 from A, $50.25 from B.
      expect(result.priceDiffCents).toBe(-(RATE + 5_025));
      expect((await guestRow(GUEST_A)).priceCents).toBe(3 * RATE);
      expect((await guestRow(GUEST_B)).priceCents).toBe(20_101 - 5_025);
      expect((await rowsOf(GUEST_B)).map((row) => row[1])).toEqual([5_026, 5_025, 5_025]);
      await noReviewRaised();
    });

    describe("batch in progress, a promotion larger than what is left (#4317 review rounds 3 and 4)", () => {
      // Under way since the 30th, eight $50 nights: $400. The frozen day is 1 July.
      const EIGHT = ["06-30", "07-01", "07-02", "07-03", "07-04", "07-05", "07-06", "07-07"].map((day) => ({
        day: `2026-${day}`,
        cents: RATE,
      }));

      const CASES = [
        {
          name: "an EXPIRED fixed $350 code, two nights cut: refunded, never charged; its guest-scope row is scaled to the cap",
          code: { type: "FIXED_AMOUNT" as const, valueCents: 35_000 },
          // Valid when it was redeemed, expired the day before the edit.
          validUntil: "2026-06-30",
          newCheckOut: "2026-07-06",
          // $300 left: the $350 code is capped at $300, so the stay costs $0
          // and the $50 paid comes back.
          expected: { total: 30_000, promo: -30_000, final: 0, priceDiff: -5_000 },
          // The stored row is the engine's -$350 for the guest; it is scaled
          // to the capped -$300 (INV-MONEY-029's one exception, owner decision
          // 24 Oct 2026 on #4302), so the booking reconciles fully.
          rows: [[null, -30_000]] as Array<[string | null, number]>,
          reconciliation: { state: "RECONCILED", reasons: [] },
        },
        {
          name: "a 100% code, cut to the two nights already slept: the rows on the nights that remain reconcile, so they are carried",
          code: { type: "PERCENTAGE" as const, percentOff: 100 },
          validUntil: undefined,
          newCheckOut: "2026-07-02",
          expected: { total: 10_000, promo: -10_000, final: 0, priceDiff: 0 },
          rows: [
            ["2026-06-30", -RATE],
            ["2026-07-01", -RATE],
          ] as Array<[string | null, number]>,
          reconciliation: { state: "RECONCILED", reasons: [] },
        },
      ];

      it.each(CASES)("$name", async (scenario) => {
        await seed({
          checkIn: "2026-06-30",
          checkOut: "2026-07-08",
          status: "PAID",
          guests: [{ id: GUEST_A, total: 8 * RATE, nights: EIGHT }],
        });
        const storedPromo = await seedPromotion(scenario.code, { validUntil: scenario.validUntil, pricedOn: "2026-06-15" });
        await confirmGuest(GUEST_A, EIGHT);
        const before = await booking();
        // The seed is a coherent booking: every identity holds before the edit.
        expect(await reconciliationStore.readBookingMoneyReconciliation(prisma, BOOKING_ID)).toEqual({
          state: "RECONCILED",
          reasons: [],
        });
        const counterBefore = (await prisma.promoCode.findUniqueOrThrow({ where: { id: PROMO_CODE_ID } }))
          .currentRedemptions;

        const quoted = await quote({ checkOut: scenario.newCheckOut });
        const result = await batch({ checkOut: scenario.newCheckOut, settlementMethod: "card" });
        const after = await booking();

        // Quote = save, and both are the carried code capped at what is left.
        expect(quoted.newTotalPriceCents).toBe(after.totalPriceCents);
        expect(quoted.newPromoAdjustmentCents).toBe(after.promoAdjustmentCents);
        expect(quoted.newDiscountCents).toBe(after.discountCents);
        expect(quoted.newFinalPriceCents).toBe(after.finalPriceCents);
        expect(quoted.priceDiffCents).toBe(result.priceDiffCents);
        expect(quoted.changeFeeCents).toBe(result.changeFeeCents);
        expect({
          total: after.totalPriceCents,
          promo: after.promoAdjustmentCents,
          final: after.finalPriceCents,
          priceDiff: result.priceDiffCents,
        }).toEqual(scenario.expected);
        expect(after.discountCents).toBe(-scenario.expected.promo);
        expect(result.promoRemoved).toBe(false);

        // The redemption stays, scaled to the cap with its holder's allocation;
        // the code was never re-validated, so its count is untouched.
        const redemptions = await prisma.promoRedemption.findMany({
          where: { bookingId: BOOKING_ID },
          include: { allocations: true },
        });
        expect(redemptions).toHaveLength(1);
        expect(redemptions[0]).toMatchObject({
          promoCodeId: PROMO_CODE_ID,
          priceAdjustmentCents: scenario.expected.promo,
          discountCents: -scenario.expected.promo,
        });
        expect(redemptions[0]!.allocations.map((allocation) => [allocation.memberId, allocation.priceAdjustmentCents])).toEqual([
          [OWNER_ID, scenario.expected.promo],
        ]);
        expect(
          (await prisma.promoCode.findUniqueOrThrow({ where: { id: PROMO_CODE_ID } })).currentRedemptions,
        ).toBe(counterBefore);

        // The night rows left on the stay, scaled to the cap where they no
        // longer add up to it, byte for byte where they do.
        const rows = await prisma.bookingGuestNightAdjustment.findMany({
          where: { bookingId: BOOKING_ID },
          include: { bookingGuestNight: { select: { stayDate: true } } },
        });
        expect(
          rows
            .map((row): [string | null, number] => [
              row.bookingGuestNight?.stayDate.toISOString().slice(0, 10) ?? null,
              row.amountCents ?? Number.NaN,
            ])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        ).toEqual(scenario.rows);
        expect(await reconciliationStore.readBookingMoneyReconciliation(prisma, BOOKING_ID)).toEqual(
          scenario.reconciliation,
        );

        // The ledger posts the edit: the nights given back, the old promotion
        // reversed and the capped one posted, adding up to the movement.
        const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
        const posted = await prisma.bookingLedgerLine.findMany({
          where: { bookingId: BOOKING_ID, anchorKind: "MODIFICATION", anchorId: modification.id },
        });
        const promotionLines = posted
          .filter((line) => line.kind === "PROMOTION")
          .map((line) => line.sign * line.unitCents * line.quantity)
          .sort((a, b) => a - b);
        expect(promotionLines).toEqual([scenario.expected.promo, -storedPromo].sort((a, b) => a - b));
        expect(posted.reduce((sum, line) => sum + line.sign * line.unitCents * line.quantity, 0)).toBe(
          result.priceDiffCents + result.changeFeeCents,
        );
        const charged = await prisma.bookingLedgerLine.findMany({
          where: { bookingId: BOOKING_ID, kind: { in: ["GUEST_NIGHT", "PROMOTION"] } },
        });
        expect(charged.reduce((sum, line) => sum + line.sign * line.unitCents * line.quantity, 0)).toBe(
          after.finalPriceCents,
        );
        expect(before.finalPriceCents + result.priceDiffCents).toBe(after.finalPriceCents);
        await noReviewRaised();
      });
    });

    describe("batch in progress, two codes stacked on one booking, capped (#4317 review round 6)", () => {
      // Two guests from 1 July, eight $50 nights each: $800. The frozen day is
      // 1 July, so the stay is cut to that night: $100 is left.
      const EIGHT = ["07-01", "07-02", "07-03", "07-04", "07-05", "07-06", "07-07", "07-08"].map((day) => ({
        day: `2026-${day}`,
        cents: RATE,
      }));

      const STACKED = [
        {
          name: "a 50% code for one guest beside a 50% code for the other: each is scaled on its own night, and the booking reconciles",
          // The first takes half of one guest's eight nights (-$200); the
          // second, half of the other's, which the first did not claim (-$200).
          codes: [
            { type: "PERCENTAGE" as const, percentOff: 50, maxGuestsPerBooking: 1 },
            { type: "PERCENTAGE" as const, percentOff: 50 },
          ],
          // Capped at -$100, shared in proportion: -$50 each. Each code's one
          // row left (-$25 on 1 July) is scaled to -$50: a whole $50 night.
          figures: [-5_000, -5_000],
          rowsByCode: [[-5_000], [-5_000]],
          reconciliation: { state: "RECONCILED", reasons: [] },
        },
        {
          name: "two free-nights codes: the first is scaled on the night left; the second freed only later nights, so it writes none",
          // The first frees both guests' first two nights (-$200); the second,
          // the next two, which the first did not claim (-$200).
          codes: [
            { type: "FREE_NIGHTS" as const, freeNightsPerIndividual: 2 },
            { type: "FREE_NIGHTS" as const, freeNightsPerIndividual: 2 },
          ],
          // Capped at -$100: -$50 each. The first code's two rows on 1 July
          // (-$50 each) scale to -$25; the second's rows were all on nights given
          // back, so it has nothing to scale from: its build-up is not known
          // while the first's rows stand (the booking's Xero promotion lines
          // fall back to the aggregate meanwhile).
          figures: [-5_000, -5_000],
          rowsByCode: [[-2_500, -2_500], []],
          reconciliation: { state: "UNRECONCILED", reasons: ["PROMO_BUILD_UP_NOT_KNOWN"] },
        },
      ];

      it.each(STACKED)("$name", async (scenario) => {
        await seed({
          checkIn: "2026-07-01",
          checkOut: "2026-07-09",
          status: "PAID",
          guests: [
            { id: GUEST_A, total: 8 * RATE, nights: EIGHT },
            { id: GUEST_B, total: 8 * RATE, nights: EIGHT },
          ],
        });
        const storedPromo = await seedPromotions(
          [
            { id: PROMO_CODE_ID, code: scenario.codes[0]! },
            { id: SECOND_CODE_ID, code: scenario.codes[1]! },
          ],
          "2026-06-15",
        );
        await confirmGuest(GUEST_A, EIGHT);
        await confirmGuest(GUEST_B, EIGHT);
        expect(await reconciliationStore.readBookingMoneyReconciliation(prisma, BOOKING_ID)).toEqual({
          state: "RECONCILED",
          reasons: [],
        });
        const before = await booking();

        const quoted = await quote({ checkOut: "2026-07-02" });
        const result = await batch({ checkOut: "2026-07-02", settlementMethod: "card" });
        const after = await booking();

        // Quote = save: the carried codes capped at the $100 left.
        expect(quoted.newTotalPriceCents).toBe(after.totalPriceCents);
        expect(quoted.newPromoAdjustmentCents).toBe(after.promoAdjustmentCents);
        expect(quoted.newFinalPriceCents).toBe(after.finalPriceCents);
        expect(quoted.priceDiffCents).toBe(result.priceDiffCents);
        expect([after.totalPriceCents, after.promoAdjustmentCents, after.finalPriceCents]).toEqual([2 * RATE, -2 * RATE, 0]);
        expect(result.priceDiffCents).toBe(-before.finalPriceCents);

        // Both redemptions stay, scaled in proportion, in application order.
        const redemptions = await prisma.promoRedemption.findMany({
          where: { bookingId: BOOKING_ID },
          orderBy: { applicationOrder: "asc" },
          include: { allocations: true },
        });
        expect(redemptions.map((redemption) => redemption.priceAdjustmentCents)).toEqual(scenario.figures);
        expect(redemptions.map((redemption) => redemption.allocations.map((allocation) => allocation.priceAdjustmentCents))).toEqual(
          scenario.figures.map((figure) => [figure]),
        );

        const rows = await prisma.bookingGuestNightAdjustment.findMany({
          where: { bookingId: BOOKING_ID },
          include: { bookingGuestNight: { select: { stayDate: true } } },
        });
        // Every row left sits on 1 July, the night kept.
        expect(new Set(rows.map((row) => row.bookingGuestNight?.stayDate.toISOString().slice(0, 10)))).toEqual(
          new Set(rows.length > 0 ? ["2026-07-01"] : []),
        );
        expect(
          redemptions.map((redemption) =>
            rows.filter((row) => row.promoRedemptionId === redemption.id).map((row) => row.amountCents),
          ),
        ).toEqual(scenario.rowsByCode);
        // The first code's rows reconcile to its own records either way.
        const first = redemptions[0]!;
        expect(
          nightAdjustments.deriveNightAdjustmentState({
            rows: rows.filter((row) => row.promoRedemptionId === first.id),
            redemption: { priceAdjustmentCents: first.priceAdjustmentCents, allocations: first.allocations.flatMap((allocation) => (allocation.memberId ? [{ memberId: allocation.memberId, priceAdjustmentCents: allocation.priceAdjustmentCents }] : [])) },
          }),
        ).toBe("KNOWN");
        expect(await reconciliationStore.readBookingMoneyReconciliation(prisma, BOOKING_ID)).toEqual(
          scenario.reconciliation,
        );

        // The ledger reverses the stored promotion and posts the capped one.
        const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
        const promotionLines = (
          await prisma.bookingLedgerLine.findMany({
            where: { bookingId: BOOKING_ID, anchorKind: "MODIFICATION", anchorId: modification.id, kind: "PROMOTION" },
          })
        )
          .map((line) => line.sign * line.unitCents * line.quantity)
          .sort((a, b) => a - b);
        expect(promotionLines).toEqual([-2 * RATE, -storedPromo].sort((a, b) => a - b));
        await noReviewRaised();
      });
    });
  },
);
