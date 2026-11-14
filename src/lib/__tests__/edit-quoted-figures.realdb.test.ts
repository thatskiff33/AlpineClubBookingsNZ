/**
 * Real-PostgreSQL proof for #4924 (`INV-MOD-062`): an edit settles only the
 * figures the member was shown.
 *
 * THE SAVE IS THE REAL DOOR: `modifyBookingBatch`, under its real `lock(1)`,
 * lodge key and post-lock re-read. The stale state comes from the club day,
 * as it does in the field: the member previews the move while the stay is
 * still in the full-refund tier, the club day advances into the 50% tier, and
 * Save then sends the figures it was shown.
 *
 *  1. The figures are the save's own: on the preview's club day, a save
 *     carrying them goes through and records no change fee.
 *  2. A day later in the fee band, the same figures are refused with
 *     `EditPriceChangedError` carrying the fresh figures, and the booking, its
 *     guests and nights, payment rows, credit ledger, booking ledger, history,
 *     Xero outbox and email log are exactly as they were.
 *  3. Saving the fresh figures goes through and charges the fee it showed.
 *  4. A save with no figures (the blue-green compatibility window) saves as
 *     it always did.
 *  5. An unchanged world means equal figures: the figures the REAL
 *     `modify-quote` route returns, sent back unchanged on the same club day,
 *     are accepted. Cases 1 to 4 use fixed figures, so only this one would
 *     catch the preview and the save drifting apart for an ordinary move.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4924-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import type { EditQuotedFigures } from "@/lib/edit-quoted-figures";

// The quote route reads the session through `@/lib/auth`: the harness's one
// shared double, set per call on `raceSession` and put back to signed out.
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4924-owner";
const OFFICER_ID = "race-4924-officer";
const LODGE_ID = "race-4924-lodge";
const SEASON_ID = "race-4924-season";
const BOOKING_ID = "race-4924-booking";
const GUEST_ID = "race-4924-guest";
const PAYMENT_ID = "race-4924-payment";
const PRIMARY_ID = "race-4924-primary";
const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-07-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-12T00:00:00.000Z");
const MOVED = { checkIn: "2026-07-20", checkOut: "2026-07-22" };
// The preview's club day: check-in twenty days out, the full-refund tier.
const PREVIEW_DAY = "2026-06-20";
// The save's club day: nine days out, the 50% tier.
const SAVE_DAY = "2026-07-01";
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;
const FEE_CENTS = PRICE_CENTS / 2;

/** What the preview showed on `PREVIEW_DAY`: same rates, no fee. */
const PREVIEWED: EditQuotedFigures = {
  newFinalPriceCents: PRICE_CENTS,
  priceDiffCents: 0,
  changeFeeCents: 0,
  netChargeCents: 0,
};
/** What the save computes on `SAVE_DAY`: the move now costs the 50% tier's fee. */
const FRESH: EditQuotedFigures = { ...PREVIEWED, changeFeeCents: FEE_CENTS, netChargeCents: FEE_CENTS };

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let quotedFigures: typeof import("@/lib/edit-quoted-figures");
let quoteRoute: typeof import("@/app/api/bookings/[id]/modify-quote/route");
// The save queues its Xero settlement fire-and-forget; drained before each
// clean so a previous test's late write never lands in the next one's snapshot.
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function drainXeroWork(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
}

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function clean(): Promise<void> {
  await drainXeroWork();
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { entityId: { in: [BOOKING_ID, PAYMENT_ID] } },
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

/**
 * A paid Internet Banking booking: one guest for two nights, paid at the price.
 * Paid, because only a paid booking is charged the late-notice change fee the
 * proof moves across (owner decision, 10 Nov 2026, `late-notice-change-fee.ts`).
 */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAID",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Quoted",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: PRICE_CENTS,
      nights: {
        create: [
          { stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
          { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
        ],
      },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: PRICE_CENTS,
      source: "INTERNET_BANKING",
      status: "SUCCEEDED",
      reference: "BOOKING-RACE4924",
      internetBankingHoldSlots: true,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: PRICE_CENTS,
          status: "SUCCEEDED",
          reference: "BOOKING-RACE4924",
          reason: "internet_banking_booking_payment",
        },
      },
    },
  });
}

/** The officer's date move through the real batch door, on a given club day. */
async function save(todayAtClub: string, figures?: EditQuotedFigures) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: { ...MOVED, ...(figures ? { quotedFigures: figures } : {}) } as never,
    ipAddress: "127.0.0.1",
    todayAtClub: todayAtClub as never,
    format: CLUB_FORMAT_TEST,
  });
}

/** The officer's preview of the move through the real `modify-quote` route, on the frozen club day. */
async function previewThroughRoute(): Promise<EditQuotedFigures> {
  const { NextRequest } = await import("next/server");
  raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: ["ADMIN"], canLogin: true } };
  try {
    const response = await quoteRoute.POST(
      new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/modify-quote`, {
        method: "POST",
        body: JSON.stringify(MOVED),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: BOOKING_ID }) },
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json.quotedFigures).toBeDefined();
    return json.quotedFigures as EditQuotedFigures;
  } finally {
    raceSession.current = null;
  }
}

/** Every row a save could write, so a refusal can be shown to have written none. */
async function everythingASaveTouches() {
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  return {
    booking: await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } }),
    guests: await prisma.bookingGuest.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
    nights: await prisma.bookingGuestNight.findMany({
      where: { bookingGuest: { bookingId: BOOKING_ID } },
      orderBy: [{ bookingGuestId: "asc" }, { stayDate: "asc" }],
    }),
    payments: await prisma.payment.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
    transactions: await prisma.paymentTransaction.findMany({
      where: { payment: { bookingId: BOOKING_ID } },
      orderBy: { id: "asc" },
    }),
    credits: await prisma.memberCredit.findMany({ where: { memberId: OWNER_ID }, orderBy: { id: "asc" } }),
    modifications: await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } }),
    ledgerLines: await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
    events: await prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
    xeroOutbox: await prisma.xeroSyncOperation.findMany({ where: { localId: { in: localIds } }, orderBy: { id: "asc" } }),
    emails: await prisma.emailLog.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
    allocations: await prisma.bedAllocation.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { id: "asc" } }),
  };
}

async function theEdit() {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { changeFeeCents: true },
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

(RUN ? describe : describe.skip)("an edit saves only the figures its preview showed, on PostgreSQL (#4924)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Edit quoted figures");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    quotedFigures = await import("@/lib/edit-quoted-figures");
    quoteRoute = await import("@/app/api/bookings/[id]/modify-quote/route");
    const editSettlement = await import("@/lib/xero-booking-edit-settlement");
    const queue = editSettlement.queueXeroBookingEditSettlement;
    // Pass-through: the harness imports every suite into one process.
    const spy = vi.spyOn(editSettlement, "queueXeroBookingEditSettlement").mockImplementation((input) => {
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

    for (const [id, firstName, role] of [
      [OWNER_ID, "Owner", Role.USER],
      [OFFICER_ID, "Officer", Role.ADMIN],
    ] as const) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName,
          lastName: "Proof",
          ageTier: "ADULT",
          canLogin: true,
          role,
        },
      });
    }
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4924 Lodge", slug: "race-4924" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 },
      ],
    });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 4924 winter",
        type: "WINTER",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        membershipTypeRates: {
          create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
          ],
        },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
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

  it("on the preview's club day, the previewed figures are the save's own", async () => {
    await save(PREVIEW_DAY, PREVIEWED);

    expect((await theEdit()).changeFeeCents).toBe(0);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).checkIn).toEqual(
      new Date(`${MOVED.checkIn}T00:00:00.000Z`),
    );
  });

  it("a day in the fee band later, the same figures are refused with the fresh ones and nothing is written", async () => {
    const before = await everythingASaveTouches();

    const refusal = await save(SAVE_DAY, PREVIEWED).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(quotedFigures.EditPriceChangedError);
    expect((refusal as InstanceType<typeof quotedFigures.EditPriceChangedError>).figures).toEqual(FRESH);
    expect(await everythingASaveTouches()).toEqual(before);
  });

  it("saving the fresh figures goes through and charges the fee they showed", async () => {
    await save(SAVE_DAY, FRESH);

    expect((await theEdit()).changeFeeCents).toBe(FEE_CENTS);
  });

  it("the real preview's figures, sent back unchanged on the same club day, are accepted", async () => {
    // The suite clock is frozen on SAVE_DAY, so the route prices the move in
    // the 50% tier: it must quote exactly what the save then settles.
    const previewed = await previewThroughRoute();
    expect(previewed).toEqual(FRESH);

    await save(SAVE_DAY, previewed);

    expect((await theEdit()).changeFeeCents).toBe(FEE_CENTS);
  });

  it("a save with no figures, from a panel older than #4924, saves as before", async () => {
    await save(SAVE_DAY);

    expect((await theEdit()).changeFeeCents).toBe(FEE_CENTS);
  });
});
