/**
 * Real-PostgreSQL proof for fork triyder/AlpineClubBookingsNZ#132: the adult-member hosting linked-move
 * offer's "comes back" figure counts the account credit a lower price frees on a
 * booking that is still pending, so the figure the member accepts equals the
 * change in their credit balance.
 *
 * The owner's own PAID booking hosts (they stay on it as an adult member); a
 * second booking of theirs, still PAYMENT_PENDING with account credit applied,
 * holds a non-member guest whom only that adult covers (`SAME_BOOKING_OWNER`).
 * Moving the host two weeks later would strand the dependent, so the member is
 * offered the linked move. The later nights are cheaper for a non-member, so the
 * dependent's price falls below the credit already applied to it, and the F20
 * (#1887) clamp returns the excess to the owner's balance. That credit is in
 * the one "comes back" total, as the maintainers' 18 Nov money review on #5149
 * checked (https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211).
 *
 * Every step is the REAL code — `offerLinkedDateMove` and `applyLinkedDateMove`,
 * which run both `modifyBookingBatch` calls in one transaction under the global
 * `lock(1)` and the lodge capacity key, the real hosting engine, pricing engine
 * and credit ledger.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL the race harness provisions (#1881) and the `realdb-all`
 * job finds it by its name; it cleans its own `race-132-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { resetStripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double (pass-through unless hooked).
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-132-owner";
const LODGE_ID = "race-132-lodge";
const POLICY_ID = "race-132-policy";
const EARLY_SEASON_ID = "race-132-early";
const LATE_SEASON_ID = "race-132-late";
const HOST_BOOKING_ID = "race-132-host";
const DEPENDENT_BOOKING_ID = "race-132-dependent";
const BOOKING_IDS = [HOST_BOOKING_ID, DEPENDENT_BOOKING_ID];
const HOST_PAYMENT_ID = "race-132-host-payment";
const DEPENDENT_PAYMENT_ID = "race-132-dependent-payment";
const PAYMENT_IDS = [HOST_PAYMENT_ID, DEPENDENT_PAYMENT_ID];
const NON_MEMBER_TYPE_KEY = "NON_MEMBER";

// FUTURE against the frozen suite clock (1 July 2026). Four nights each way.
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const STAY = { checkIn: "2026-08-03", checkOut: "2026-08-07" };
const MOVED = { checkIn: "2026-08-17", checkOut: "2026-08-21" };
const NIGHTS = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"].map(day);
const NIGHT_CENTS = 5_000;
/** A non-member's nightly rate in the late season; members pay `NIGHT_CENTS` in both. */
const LATE_NON_MEMBER_NIGHT_CENTS = 3_000;
const PRICE_CENTS = NIGHTS.length * NIGHT_CENTS;
const MOVED_DEPENDENT_PRICE_CENTS = NIGHTS.length * LATE_NON_MEMBER_NIGHT_CENTS;
/** Applied to the pending dependent: more than its moved price, so the move frees some. */
const CREDIT_APPLIED_CENTS = 18_000;
const FREED_CREDIT_CENTS = CREDIT_APPLIED_CENTS - MOVED_DEPENDENT_PRICE_CENTS;

let prisma: PrismaClient;
let linkedMove: typeof import("@/lib/booking-linked-date-move-service");
let linkedMoveQuote: typeof import("@/lib/adult-member-hosting-linked-move");
let clubTimeServer: typeof import("@/lib/club-time/server");
let memberCredit: typeof import("@/lib/member-credit");
/** The edit's post-commit Xero queueing runs unawaited; teardown waits for it (#4234). */
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: { in: BOOKING_IDS } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function clean(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
  const localIds = [...BOOKING_IDS, ...PAYMENT_IDS, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: { in: BOOKING_IDS } },
        { entityId: { in: [...BOOKING_IDS, ...PAYMENT_IDS] } },
        { memberId: OWNER_ID },
        { actorMemberId: OWNER_ID },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  // The edits' member emails, withheld (no environment role is declared, so no
  // provider is contacted) and kept as queued rows against each booking.
  await prisma.emailLog.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await releaseBookingJournalForTeardown(prisma, BOOKING_IDS);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: OWNER_ID } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.paymentRefund.deleteMany({ where: { payment: { bookingId: { in: BOOKING_IDS } } } });
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: { in: BOOKING_IDS } } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: BOOKING_IDS } } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
}

async function teardownFixtures(): Promise<void> {
  await prisma.adultMemberHostingPolicy.deleteMany({ where: { id: POLICY_ID } });
  await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: { in: [EARLY_SEASON_ID, LATE_SEASON_ID] } } });
  await prisma.season.deleteMany({ where: { id: { in: [EARLY_SEASON_ID, LATE_SEASON_ID] } } });
  await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
  await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.member.deleteMany({ where: { id: OWNER_ID } });
}

/**
 * The two bookings, as the booking flow writes them:
 *  - the host: PAID by card, the owner staying on it as an adult member;
 *  - the dependent: PAYMENT_PENDING, one non-member adult guest, with
 *    `CREDIT_APPLIED_CENTS` of the owner's account credit applied and the rest
 *    still to pay on an open card intent. The owner's balance stands at 0.
 */
async function seed(): Promise<void> {
  const stay = { lodgeId: LODGE_ID, memberId: OWNER_ID, checkIn: day(STAY.checkIn), checkOut: day(STAY.checkOut) };
  const nights = { create: NIGHTS.map((stayDate) => ({ stayDate, priceCents: NIGHT_CENTS, priceSource: "SOLD" as const })) };
  await prisma.booking.create({
    data: { id: HOST_BOOKING_ID, ...stay, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
  });
  await prisma.bookingGuest.create({
    data: {
      bookingId: HOST_BOOKING_ID,
      firstName: "Owner",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      memberId: OWNER_ID,
      stayStart: stay.checkIn,
      stayEnd: stay.checkOut,
      priceCents: PRICE_CENTS,
      nights,
    },
  });
  await prisma.payment.create({
    data: {
      id: HOST_PAYMENT_ID,
      bookingId: HOST_BOOKING_ID,
      amountCents: PRICE_CENTS,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_race_132_host",
      transactions: {
        create: {
          kind: "PRIMARY",
          source: "STRIPE",
          amountCents: PRICE_CENTS,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_race_132_host",
        },
      },
    },
  });

  await prisma.booking.create({
    data: {
      id: DEPENDENT_BOOKING_ID,
      ...stay,
      status: "PAYMENT_PENDING",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
      hasNonMembers: true,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      bookingId: DEPENDENT_BOOKING_ID,
      firstName: "Visiting",
      lastName: "Friend",
      ageTier: "ADULT",
      isMember: false,
      stayStart: stay.checkIn,
      stayEnd: stay.checkOut,
      priceCents: PRICE_CENTS,
      nights,
    },
  });
  const cardCents = PRICE_CENTS - CREDIT_APPLIED_CENTS;
  await prisma.payment.create({
    data: {
      id: DEPENDENT_PAYMENT_ID,
      bookingId: DEPENDENT_BOOKING_ID,
      amountCents: cardCents,
      creditAppliedCents: CREDIT_APPLIED_CENTS,
      source: "STRIPE",
      status: "PENDING",
      stripePaymentIntentId: "pi_race_132_open",
      transactions: {
        create: {
          kind: "PRIMARY",
          source: "STRIPE",
          amountCents: cardCents,
          status: "PENDING",
          stripePaymentIntentId: "pi_race_132_open",
        },
      },
    },
  });
  await prisma.memberCredit.create({
    data: { memberId: OWNER_ID, amountCents: CREDIT_APPLIED_CENTS, type: "ADMIN_ADJUSTMENT", description: "race 132 opening balance" },
  });
  await prisma.$transaction((tx) =>
    memberCredit.applyCreditToBooking(OWNER_ID, CREDIT_APPLIED_CENTS, DEPENDENT_BOOKING_ID, tx, CLUB_FORMAT_TEST),
  );
}

async function moveArgs() {
  return {
    bookingId: HOST_BOOKING_ID,
    actor: { id: OWNER_ID, role: Role.USER },
    input: { checkIn: MOVED.checkIn, checkOut: MOVED.checkOut },
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  };
}

/** The offer the member is shown. `offerLinkedDateMove` always throws it. */
async function offer() {
  const thrown = await linkedMove.offerLinkedDateMove(await moveArgs()).then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(linkedMoveQuote.SameOwnerCoverageLinkedMoveRequiredError);
  return thrown as InstanceType<typeof linkedMoveQuote.SameOwnerCoverageLinkedMoveRequiredError>;
}

async function bookingRows() {
  return prisma.booking.findMany({
    where: { id: { in: BOOKING_IDS } },
    select: { id: true, status: true, checkIn: true, checkOut: true, finalPriceCents: true },
    orderBy: { id: "asc" },
  });
}

(RUN ? describe : describe.skip)("the linked move counts freed account credit, on PostgreSQL (fork triyder/AlpineClubBookingsNZ#132)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Linked move freed credit");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    linkedMove = await import("@/lib/booking-linked-date-move-service");
    linkedMoveQuote = await import("@/lib/adult-member-hosting-linked-move");
    clubTimeServer = await import("@/lib/club-time/server");
    memberCredit = await import("@/lib/member-credit");
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    // Pass-through: the harness imports every suite into one process.
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (BOOKING_IDS.includes(input.bookingId)) pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();

    await clean();
    await teardownFixtures();
    await prisma.member.create({
      data: {
        id: OWNER_ID,
        email: `${OWNER_ID}@example.invalid`,
        passwordHash: "not-a-real-password",
        firstName: "Owner",
        lastName: "Proof",
        ageTier: "ADULT",
        canLogin: true,
        role: Role.USER,
      },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 132 Lodge", slug: "race-132" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.create({
      data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100 },
    });
    // A non-member needs an adult member on the same night, from this booking or
    // another of the same owner's (#2576).
    await prisma.adultMemberHostingPolicy.create({
      data: {
        id: POLICY_ID,
        lodgeId: LODGE_ID,
        scopeKey: LODGE_ID,
        mode: "ENFORCED",
        capacityMode: "NO_HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: true,
      },
    });
    // Members pay one rate throughout, so the host's price does not move; a
    // non-member pays less in the late season, so the dependent's price falls.
    const membershipTypes = await prisma.membershipType.findMany({ select: { id: true, key: true } });
    for (const [id, startDate, endDate, nonMemberCents] of [
      [EARLY_SEASON_ID, "2026-07-01", "2026-08-15", NIGHT_CENTS],
      [LATE_SEASON_ID, "2026-08-16", "2026-09-30", LATE_NON_MEMBER_NIGHT_CENTS],
    ] as const) {
      await prisma.season.create({
        data: {
          id,
          name: `Race 132 ${id}`,
          type: "WINTER",
          startDate: day(startDate),
          endDate: day(endDate),
          active: true,
          lodgeId: LODGE_ID,
          membershipTypeRates: {
            create: membershipTypes.map((type) => ({
              membershipTypeId: type.id,
              ageTier: null,
              pricePerNightCents: type.key === NON_MEMBER_TYPE_KEY ? nonMemberCents : NIGHT_CENTS,
            })),
          },
        },
      });
    }
  }, 120_000);

  beforeEach(async () => {
    resetStripeRaceHooks();
    await clean();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await teardownFixtures();
    } finally {
      resetStripeRaceHooks();
      restoreXeroQueue?.();
    }
  });

  it("offers a 'comes back' figure that equals the owner's credit-balance change", async () => {
    await seed();
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
    const before = await bookingRows();

    const shown = await offer();
    expect(shown.quote.feasibility).toBe("AVAILABLE");
    expect(shown.quote.linked.map((booking) => booking.bookingId)).toEqual([DEPENDENT_BOOKING_ID]);
    expect(shown.quote.primary.priceDiffCents).toBe(0);
    expect(shown.quote.linked[0]!.priceDiffCents).toBe(MOVED_DEPENDENT_PRICE_CENTS - PRICE_CENTS);
    // The dependent has taken no card money, so no settlement arm runs and no
    // card-or-credit choice is asked: what comes back is the freed credit alone.
    expect(shown.quote.combinedAmountDueCents).toBe(0);
    expect(shown.quote.settlementMethodRequired).toBe(false);
    expect(shown.quote.combinedRefundCents).toBe(FREED_CREDIT_CENTS);
    expect(shown.message).toContain("$60.00 would come back to you");
    // The probe rolled back: nothing moved and no credit came back yet.
    expect(await bookingRows()).toEqual(before);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);

    await linkedMove.applyLinkedDateMove({
      ...(await moveArgs()),
      linkedMove: { choice: "MOVE_BOTH", acknowledged: true, stateKey: shown.acceptStateKey },
    });

    const moved = await bookingRows();
    for (const row of moved) {
      expect(row.checkIn).toEqual(day(MOVED.checkIn));
      expect(row.checkOut).toEqual(day(MOVED.checkOut));
    }
    expect(moved.find((row) => row.id === DEPENDENT_BOOKING_ID)?.finalPriceCents).toBe(MOVED_DEPENDENT_PRICE_CENTS);
    // THE CLAIM: the figure the member accepted is the change in their balance.
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(shown.quote.combinedRefundCents);
  }, 120_000);
});
