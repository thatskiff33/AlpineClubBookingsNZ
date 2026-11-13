/**
 * Real-PostgreSQL proof for ALP-573: a price-preserving booking edit (a guest
 * name fix, a credit election) previews and saves the SAME figures, and moves
 * no money.
 *
 * Each case sends the request through the real preview route
 * (`POST /api/bookings/[id]/modify-quote`), then the identical request through
 * the real save (`modifyBookingBatch`), and holds the save to what the preview
 * showed: the same price difference, change fee and final price, all of them
 * the stored booking's, with nothing written to the ledger, no credit, no
 * refund task and no night repriced.
 *
 * The two shapes that used to disagree:
 *
 *  - a stored final price out of step with its total plus promotion (a data
 *    fault). The preview echoed the stored final price with a $0 difference;
 *    the save re-derived it from the total and settled the drift as the name
 *    fix's "difference";
 *  - a rename resending the stored names, after the season rate has moved. The
 *    preview classified it as identity-only and echoed; the save classified it
 *    by the names that actually changed (none), so it repriced.
 *
 * Envelope: identical to `edit-auto-pricing-doors.realdb.test.ts`; the describe
 * runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against a loopback database on
 * port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/price-preserving-edit-preview-save.realdb.test.ts
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-573-owner";
const OFFICER_ID = "race-573-officer";
const LODGE_ID = "race-573-lodge";
const SEASON_ID = "race-573-season";
const BOOKING_ID = "race-573-booking";
const GUEST_ID = "race-573-guest";

/** Today's season rate for a non-member adult. */
const RATE = 5_000;
const NIGHTS = ["2026-08-10", "2026-08-11"];
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

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
let clubTimeServer: typeof import("@/lib/club-time/server");
let quoteRoute: typeof import("@/app/api/bookings/[id]/modify-quote/route");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function clean(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
  const modifications = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true },
  });
  const localIds = [BOOKING_ID, ...modifications.map((row) => row.id)];
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
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** One unpaid booking for one non-member guest, two nights sold at `nightCents`. */
async function seed(options: { nightCents: number; finalPriceCents?: number }): Promise<void> {
  const total = options.nightCents * NIGHTS.length;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: D(NIGHTS[0]!),
      checkOut: D("2026-08-12"),
      status: "PAYMENT_PENDING",
      totalPriceCents: total,
      finalPriceCents: options.finalPriceCents ?? total,
      hasNonMembers: true,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Jon",
      lastName: "Smith",
      ageTier: "ADULT",
      isMember: false,
      stayStart: D(NIGHTS[0]!),
      stayEnd: D("2026-08-12"),
      priceCents: total,
      nights: {
        create: NIGHTS.map((day) => ({
          stayDate: D(day),
          priceCents: options.nightCents,
          priceSource: "SOLD" as const,
        })),
      },
    },
  });
}

/** What the save recorded the edit as (`GUEST_UPDATE`, `CREDIT_ELECTION`, `BATCH_MODIFY`...). */
async function recordedAs(): Promise<string> {
  return (await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING_ID } }))
    .modificationType;
}

async function guestName(): Promise<string> {
  const guest = await prisma.bookingGuest.findUniqueOrThrow({ where: { id: GUEST_ID } });
  return `${guest.firstName} ${guest.lastName}`;
}

/** The booking's money, and every night's price, as stored. */
async function storedMoney() {
  const row = await prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    include: { guests: { include: { nights: { orderBy: { stayDate: "asc" } } } } },
  });
  return {
    totalPriceCents: row.totalPriceCents,
    discountCents: row.discountCents,
    promoAdjustmentCents: row.promoAdjustmentCents,
    finalPriceCents: row.finalPriceCents,
    guests: row.guests.map((guest) => ({
      priceCents: guest.priceCents,
      nights: guest.nights.map((night) => [night.priceCents, night.priceSource]),
    })),
  };
}

/** What the real preview route answers the officer. */
async function preview(body: Record<string, unknown>) {
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
      newPromoAdjustmentCents: number;
      newFinalPriceCents: number;
      priceDiffCents: number;
      changeFeeCents: number;
      netChargeCents: number;
    };
  } finally {
    raceSession.current = null;
  }
}

/** The real save, for the same request. */
async function save(body: Record<string, unknown>) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: body as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

/**
 * Preview, then save the same request, and hold the save to the preview: the
 * figures it settles are the ones the member was shown, and none of them moves
 * money.
 */
async function previewThenSave(body: Record<string, unknown>) {
  const before = await storedMoney();
  const quoted = await preview(body);
  const result = await save(body);
  const after = await storedMoney();

  // The save settles exactly what the preview showed.
  expect(result.priceDiffCents).toBe(quoted.priceDiffCents);
  expect(result.changeFeeCents).toBe(quoted.changeFeeCents);
  expect(result.priceDiffCents + result.changeFeeCents).toBe(quoted.netChargeCents);
  expect(after.finalPriceCents).toBe(quoted.newFinalPriceCents);
  expect(after.totalPriceCents).toBe(quoted.newTotalPriceCents);
  expect(after.promoAdjustmentCents).toBe(quoted.newPromoAdjustmentCents);

  // And what it showed is no movement at all.
  expect(quoted.priceDiffCents).toBe(0);
  expect(quoted.netChargeCents).toBe(0);
  expect({
    additionalAmountCents: result.additionalAmountCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
  }).toEqual({ additionalAmountCents: 0, refundAmountCents: 0, accountCreditAmountCents: 0 });
  expect(after).toEqual(before);
  expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
  expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
}

(RUN ? describe : describe.skip)(
  "ALP-573: a price-preserving edit previews and saves the same figures, moving no money - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      batchService = await import("@/lib/booking-batch-modification-service");
      clubTimeServer = await import("@/lib/club-time/server");
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
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 573 Lodge", slug: "race-573" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 20 } });
      await prisma.cancellationPolicy.create({
        data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100 },
      });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.create({
        data: {
          id: SEASON_ID,
          name: "Race 573 season",
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

    describe("a stored final price out of step with its total plus promotion", () => {
      // $100 of nights and no promotion, but a stored final price of $90: the
      // data fault `booking-final-price.ts` describes. A name fix must neither
      // bill the $10 nor repair it.
      const DRIFTED = { nightCents: RATE, finalPriceCents: 2 * RATE - 1_000 };

      it("a name fix keeps the stored final price, as the preview showed it", async () => {
        await seed(DRIFTED);

        await previewThenSave({
          guestUpdates: [{ guestId: GUEST_ID, firstName: "John", lastName: "Smith" }],
        });

        expect(await recordedAs()).toBe("GUEST_UPDATE");
        expect(await guestName()).toBe("John Smith");
        expect((await storedMoney()).finalPriceCents).toBe(DRIFTED.finalPriceCents);
      });

      it("a credit election keeps the stored final price, as the preview showed it", async () => {
        await seed(DRIFTED);

        await previewThenSave({ applyCreditCents: 0 });

        expect(await recordedAs()).toBe("CREDIT_ELECTION");
        expect((await storedMoney()).finalPriceCents).toBe(DRIFTED.finalPriceCents);
      });
    });

    it("a rename resending the stored names, after the season rate has moved, reprices nothing", async () => {
      // Sold at $40 a night; today's rate is $50.
      await seed({ nightCents: 4_000 });

      await previewThenSave({
        guestUpdates: [{ guestId: GUEST_ID, firstName: "Jon", lastName: "Smith" }],
      });

      // The preview and the save classify it the same way: a rename, priced as
      // stored, that changed no name.
      expect(await recordedAs()).toBe("GUEST_UPDATE");
      expect(await guestName()).toBe("Jon Smith");
    });
  },
);
