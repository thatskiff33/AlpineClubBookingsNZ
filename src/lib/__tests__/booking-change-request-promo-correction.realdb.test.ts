/**
 * Real-PostgreSQL proof for #4533: an officer applies a member's missed promo
 * code to a FINISHED stay through an approved change request.
 *
 * Every step is the REAL code — `approveAndExecuteLockedPeriodChangeRequest`,
 * `prepareBatchModificationForCallerTransaction` and the canonical
 * `modifyBookingBatch` under `finishedStayCorrection` — against the real
 * advisory locks, the real promo row locks and caps, the real credit ledger and
 * the real Xero outbox. The claims:
 *
 *  1. Credit settlement: a card-paid, invoiced, COMPLETED stay gets its missed
 *     free night. The booking is re-priced, a `PromoRedemption` (with the
 *     member's allocation) counts the night as used, the reduction comes back
 *     IN FULL as account credit by default (no same-day tier, no fee), one
 *     unapplied account-credit note is queued, ledger lines are posted, and the
 *     request is linked to the modification it produced.
 *  2. Caps: a member who has used their assigned nights cannot get another
 *     through this path, and is told exactly what the ordinary edit of a future
 *     stay tells them. Nothing is written; the request stays pending.
 *  3. Replay is idempotent: approving again is a lost claim, and entering the
 *     same code on another request is refused — still one redemption, one
 *     credit, one credit note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL the race harness provisions (#1881) and joins the
 * `realdb-all` job by its name; it cleans its own `race-4533-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4533-owner";
const OFFICER_ID = "race-4533-officer";
const LODGE_ID = "race-4533-lodge";
const SEASON_ID = "race-4533-season";
const BOOKING_ID = "race-4533-booking";
const GUEST_ID = "race-4533-guest";
const PAYMENT_ID = "race-4533-payment";
const REQUEST_ID = "race-4533-request";
const REQUEST_2_ID = "race-4533-request-2";
const PRIOR_BOOKING_ID = "race-4533-prior-booking";
const FUTURE_BOOKING_ID = "race-4533-future-booking";
const FUTURE_GUEST_ID = "race-4533-future-guest";
const PROMO_ID = "race-4533-promo";
const PROMO_CODE = "RACE4533FREE";
// Fully past against the frozen suite clock (1 July 2026).
const CHECK_IN = new Date("2026-06-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-12T00:00:00.000Z");
const STORED_NIGHT_CENTS = 4_321;
const NIGHT_CENTS = 5_000;
const LIFETIME_FREE_NIGHTS = 2;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Promo correction proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing to run promo correction proofs against port ${parsed.port || "(none)"}: use 55442+.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Promo correction proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Promo correction proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let executor: typeof import("@/lib/booking-change-request-execution");
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

const ALL_BOOKINGS = [BOOKING_ID, PRIOR_BOOKING_ID, FUTURE_BOOKING_ID];

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: { in: ALL_BOOKINGS } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** This booking's queued Xero work for its modifications, once the post-commit leg has queued it. */
async function modificationXeroOps(expected: number) {
  const started = process.hrtime.bigint();
  for (;;) {
    await Promise.allSettled(pendingXeroWork);
    const rows = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: { in: await modificationIds() } },
      select: { localId: true, idempotencyKey: true },
    });
    if (rows.length >= expected || realElapsedMs(started) > 5_000) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function clean(): Promise<void> {
  const enqueueErrors: unknown[] = [];
  while (pendingXeroWork.length > 0) {
    for (const result of await Promise.allSettled(pendingXeroWork.splice(0))) {
      if (result.status === "rejected") enqueueErrors.push(result.reason);
    }
  }
  await prisma.xeroSyncOperation.deleteMany({
    where: { localModel: "BookingModification", localId: { in: await modificationIds() } },
  });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...ALL_BOOKINGS, PAYMENT_ID] } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: { in: [...ALL_BOOKINGS, REQUEST_ID, REQUEST_2_ID] } },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.bookingChangeRequest.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.manualRefundTask.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: OWNER_ID } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.promoRedemptionAllocation.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.promoRedemption.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.promoCode.updateMany({ where: { id: PROMO_ID }, data: { currentRedemptions: 0 } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: { in: ALL_BOOKINGS } } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: ALL_BOOKINGS } } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
  await prisma.booking.deleteMany({ where: { id: { in: ALL_BOOKINGS } } });
  if (enqueueErrors.length > 0) {
    throw new AggregateError(enqueueErrors, "#4533: real Xero fixture enqueues failed; owned fixtures cleaned");
  }
}

/** The owner as their own guest, two nights at a sold price that is NOT the season rate. */
async function ownerStay(
  bookingId: string,
  guestId: string,
  stay: { checkIn: Date; checkOut: Date; nights: Date[]; status: "COMPLETED" | "PAID" },
) {
  const total = stay.nights.length * STORED_NIGHT_CENTS;
  await prisma.booking.create({
    data: {
      id: bookingId,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      status: stay.status,
      totalPriceCents: total,
      finalPriceCents: total,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: guestId,
      bookingId,
      firstName: "Owner",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      memberId: OWNER_ID,
      stayStart: stay.checkIn,
      stayEnd: stay.checkOut,
      priceCents: total,
      nights: {
        create: stay.nights.map((stayDate) => ({ stayDate, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" as const })),
      },
    },
  });
  return total;
}

/**
 * The finished stay the officer booked for the owner without the code: paid in
 * full by card against an issued Xero invoice. A free-text request about it
 * (`REQUEST_ID`), on which the officer enters the code when approving; and,
 * where asked, the free nights the owner already used on an earlier stay.
 */
async function seed(options: { priorFreeNightsUsed?: number } = {}): Promise<void> {
  const total = await ownerStay(BOOKING_ID, GUEST_ID, {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    nights: [CHECK_IN, NIGHT_2],
    status: "COMPLETED",
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: total,
      source: "STRIPE",
      stripePaymentIntentId: "pi_race_4533",
      status: "SUCCEEDED",
      xeroInvoiceId: "race-4533-xero-invoice",
      xeroInvoiceNumber: "INV-4533",
    },
  });
  // The stay's confirmation lines, as its settle posted them: an edit posts
  // its own ledger lines only onto a booking the ledger already holds.
  const ledger = await import("@/lib/booking-ledger-confirmation-sync");
  await prisma.$transaction((tx) => ledger.postStoredBookingConfirmationLedgerLines(tx, BOOKING_ID));
  await freeTextRequest(REQUEST_ID);
  if (options.priorFreeNightsUsed) {
    await ownerStay(PRIOR_BOOKING_ID, "race-4533-prior-guest", {
      checkIn: new Date("2026-06-01T00:00:00.000Z"),
      checkOut: new Date("2026-06-03T00:00:00.000Z"),
      nights: [new Date("2026-06-01T00:00:00.000Z"), new Date("2026-06-02T00:00:00.000Z")],
      status: "COMPLETED",
    });
    await prisma.promoRedemption.create({
      data: {
        promoCodeId: PROMO_ID,
        bookingId: PRIOR_BOOKING_ID,
        memberId: OWNER_ID,
        discountCents: options.priorFreeNightsUsed * STORED_NIGHT_CENTS,
        priceAdjustmentCents: -options.priorFreeNightsUsed * STORED_NIGHT_CENTS,
        freeNightsUsed: options.priorFreeNightsUsed,
        eligibleGuestCount: 1,
      },
    });
    // The member's allocation is minted from this row by the database's own
    // trigger (`sync_promo_redemption_allocation_from_redemption`).
    await prisma.promoCode.update({ where: { id: PROMO_ID }, data: { currentRedemptions: 1 } });
  }
}

/** A request about the stay naming no change of its own: the officer enters the code. */
async function freeTextRequest(id: string) {
  await prisma.bookingChangeRequest.create({
    data: {
      id,
      bookingId: BOOKING_ID,
      requestedByMemberId: OWNER_ID,
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
      reason: "My committee free night wasn't applied to this stay.",
      requestedChanges: {
        original: {
          checkIn: "2026-06-10",
          checkOut: "2026-06-12",
          guests: [{ id: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12", nights: ["2026-06-10", "2026-06-11"] }],
        },
        requested: {
          checkIn: null,
          checkOut: null,
          addGuests: [],
          removeGuests: [],
          guestStayRanges: [],
          requestedEffectiveDate: null,
          summary: "Locked-period booking change",
        },
      },
    },
  });
}

type ExecutorParams = Parameters<typeof executor.approveAndExecuteLockedPeriodChangeRequest>[0];
type ExpectedFigures = NonNullable<ExecutorParams["expectedFigures"]>;

async function execute(
  requestId: string,
  expectedVersion: number,
  mode: { dryRun: true } | { expectedFigures: ExpectedFigures },
) {
  return executor.approveAndExecuteLockedPeriodChangeRequest({
    ...mode,
    requestId,
    expectedVersion,
    actorMemberId: OFFICER_ID,
    adminNotes: "Your free night is now applied.",
    internalNotes: null,
    confirmOverCapacity: false,
    officerPromoChange: { promoCode: PROMO_CODE },
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
    preTransaction: await batchService.prepareBatchModificationForCallerTransaction({ audience: "admin" }),
    ipAddress: "127.0.0.1",
  });
}

/** The officer's own sequence: check the figures, then approve with them. */
async function approve(requestId = REQUEST_ID, expectedVersion = 1) {
  const checked = await execute(requestId, expectedVersion, { dryRun: true });
  if (checked.outcome !== "quoted") return checked;
  return execute(requestId, expectedVersion, {
    expectedFigures: {
      additionalAmountCents: checked.additionalAmountCents,
      refundAmountCents: checked.refundAmountCents,
      accountCreditAmountCents: checked.accountCreditAmountCents,
    },
  });
}

/** What the booking holds of the promotion, the credit ledger and the outbox. */
async function promoState() {
  const [redemptions, allocations, credits, promo] = await Promise.all([
    prisma.promoRedemption.findMany({ where: { bookingId: BOOKING_ID } }),
    prisma.promoRedemptionAllocation.findMany({ where: { bookingId: BOOKING_ID } }),
    prisma.memberCredit.findMany({ where: { memberId: OWNER_ID } }),
    prisma.promoCode.findUniqueOrThrow({ where: { id: PROMO_ID } }),
  ]);
  return { redemptions, allocations, credits, promo };
}

(RUN ? describe : describe.skip)("a finished-stay promo correction, on PostgreSQL (#4533)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    executor = await import("@/lib/booking-change-request-execution");
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (ALL_BOOKINGS.includes(input.bookingId)) pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();

    await clean();
    await teardownFixtures();
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4533 Lodge", slug: "race-4533" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    // A same-day tier that keeps half: a correction measured at 0 days would
    // keep half the reduction if it were tiered. A promo correction is not.
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
      ],
    });
    // Every membership type, so whichever rate the owner's own nights resolve
    // to is priced; held nights keep their sold price whatever it says.
    const membershipTypes = await prisma.membershipType.findMany({ select: { id: true } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 4533 winter",
        type: "WINTER",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        membershipTypeRates: {
          create: membershipTypes.map((type) => ({
            membershipTypeId: type.id,
            ageTier: null,
            pricePerNightCents: NIGHT_CENTS,
          })),
        },
      },
    });
    // The owner's assigned committee free nights: one per booking, two in all,
    // on their own nights only.
    await prisma.promoCode.create({
      data: {
        id: PROMO_ID,
        code: PROMO_CODE,
        type: "FREE_NIGHTS",
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: LIFETIME_FREE_NIGHTS,
        assignedMembersOnlyOwnNights: true,
        assignments: { create: [{ memberId: OWNER_ID }] },
      },
    });
  }, 120_000);

  async function teardownFixtures() {
    await prisma.promoCodeAssignment.deleteMany({ where: { promoCodeId: PROMO_ID } });
    await prisma.promoCode.deleteMany({ where: { id: PROMO_ID } });
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
  }

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await teardownFixtures();
    } finally {
      restoreXeroQueue?.();
    }
  });

  it("applies the missed free night, counts it as used and returns it in full as account credit", async () => {
    // One of the owner's two lifetime free nights already used elsewhere.
    await seed({ priorFreeNightsUsed: 1 });
    const result = await approve();
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      priceDiffCents: -STORED_NIGHT_CENTS,
      changeFeeCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      // The whole reduction: the 50% same-day tier does not touch it.
      accountCreditAmountCents: STORED_NIGHT_CENTS,
      settlementMethod: "credit",
      promoChange: { codes: [PROMO_CODE], enteredBy: { officerMemberId: OFFICER_ID, enteredOn: "approval" } },
      notifyMember: true,
    });

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: { guests: { include: { nights: { orderBy: { stayDate: "asc" } } } } },
    });
    expect(booking.status).toBe("COMPLETED");
    expect(booking.promoAdjustmentCents).toBe(-STORED_NIGHT_CENTS);
    expect(booking.finalPriceCents).toBe(STORED_NIGHT_CENTS);
    // The sold nights stay as they were; the promotion is recorded beside them.
    expect(booking.guests[0]!.nights.map((night) => [night.priceCents, night.priceSource])).toEqual([
      [STORED_NIGHT_CENTS, "SOLD"],
      [STORED_NIGHT_CENTS, "SOLD"],
    ]);

    // The free night is now counted as used: the redemption and the owner's allocation.
    const state = await promoState();
    expect(state.redemptions).toEqual([
      expect.objectContaining({ promoCodeId: PROMO_ID, memberId: OWNER_ID, freeNightsUsed: 1, discountCents: STORED_NIGHT_CENTS }),
    ]);
    expect(state.allocations).toEqual([expect.objectContaining({ memberId: OWNER_ID, freeNightsUsed: 1 })]);
    expect(state.promo.currentRedemptions).toBe(2);

    // The credit, minted once from this modification.
    const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modifications).toHaveLength(1);
    const modification = modifications[0]!;
    expect(modification).toMatchObject({ changeFeeCents: 0, priceDiffCents: -STORED_NIGHT_CENTS });
    expect(modification.newData).toMatchObject({
      finishedStayCorrection: { changeRequestId: REQUEST_ID, changeFeeRule: "PROMO_ONLY_NO_FEE" },
    });
    expect(state.credits.filter((credit) => credit.amountCents > 0)).toEqual([
      expect.objectContaining({ amountCents: STORED_NIGHT_CENTS, sourceBookingModificationId: modification.id }),
    ]);

    // The app's own Xero document: one unapplied account-credit note for the reduction.
    const ops = await modificationXeroOps(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ localId: modification.id });
    expect(ops[0]!.idempotencyKey).toMatch(/account-credit/);

    // Ledger lines posted for the edit, under its own anchor.
    expect(
      await prisma.bookingLedgerLine.count({
        where: { bookingId: BOOKING_ID, anchorKind: "MODIFICATION", anchorId: modification.id },
      }),
    ).toBeGreaterThan(0);

    // The request joined to what it produced, the entry recorded on it.
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request).toMatchObject({ status: "APPROVED", version: 2, linkedModificationId: modification.id });
    expect(request.requestedChanges).toMatchObject({
      original: { promoCodes: [] },
      requested: { promoChange: { promoCode: PROMO_CODE, enteredBy: { onMemberBehalf: true, officerMemberId: OFFICER_ID } } },
    });
  }, 60_000);

  it("refuses a member whose assigned nights are used, with the ordinary edit's reason, and writes nothing", async () => {
    await seed({ priorFreeNightsUsed: LIFETIME_FREE_NIGHTS });
    // The same code on a FUTURE stay of the owner's, through the ordinary edit:
    // the reason Edit Booking gives.
    await ownerStay(FUTURE_BOOKING_ID, FUTURE_GUEST_ID, {
      checkIn: new Date("2026-08-10T00:00:00.000Z"),
      checkOut: new Date("2026-08-12T00:00:00.000Z"),
      nights: [new Date("2026-08-10T00:00:00.000Z"), new Date("2026-08-11T00:00:00.000Z")],
      status: "PAID",
    });
    const ordinary = await batchService
      .modifyBookingBatch({
        bookingId: FUTURE_BOOKING_ID,
        actor: { id: OFFICER_ID, role: "ADMIN" },
        input: { promoCode: PROMO_CODE, notifyMember: false },
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTimeServer.clubTime()).today(),
        format: CLUB_FORMAT_TEST,
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(ordinary).toBeTruthy();

    const refused = await approve().then(
      () => null,
      (error: Error) => error.message,
    );
    // Refused in its own right, and with exactly the ordinary edit's reason.
    expect(refused).toBeTruthy();
    expect(refused).toBe(ordinary);

    const state = await promoState();
    expect(state.redemptions).toEqual([]);
    expect(state.credits).toEqual([]);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).toMatchObject({
      promoAdjustmentCents: 0,
      finalPriceCents: 2 * STORED_NIGHT_CENTS,
    });
    expect(await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } })).toMatchObject({
      status: "REQUESTED",
      version: 1,
      linkedModificationId: null,
    });
  }, 60_000);

  it("is idempotent on replay: one redemption, one credit, one credit note", async () => {
    await seed({ priorFreeNightsUsed: 1 });
    await freeTextRequest(REQUEST_2_ID);
    expect(await approve()).toMatchObject({ outcome: "executed" });
    await modificationXeroOps(1);

    // The same approval again: the claim is lost and nothing runs.
    const expectedFigures = { additionalAmountCents: 0, refundAmountCents: 0, accountCreditAmountCents: STORED_NIGHT_CENTS };
    expect(await execute(REQUEST_ID, 1, { expectedFigures })).toEqual({ outcome: "claimLost" });
    expect(await execute(REQUEST_ID, 2, { expectedFigures })).toEqual({ outcome: "claimLost" });
    // The same code entered on another request about the stay: nothing to correct.
    const again = await approve(REQUEST_2_ID, 1);
    expect(again.outcome).toBe("keptPending");

    const state = await promoState();
    expect(state.redemptions).toHaveLength(1);
    expect(state.credits.filter((credit) => credit.amountCents > 0)).toHaveLength(1);
    expect(state.promo.currentRedemptions).toBe(2);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    expect(await modificationXeroOps(1)).toHaveLength(1);
    expect(await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_2_ID } })).toMatchObject({
      status: "REQUESTED",
      version: 1,
    });
  }, 60_000);
});
