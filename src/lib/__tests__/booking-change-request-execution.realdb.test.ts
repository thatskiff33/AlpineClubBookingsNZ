/**
 * Real-PostgreSQL proof for #3750: approving a LOCKED_PERIOD change request on a
 * finished stay executes it exactly once, and serialises with a cancel.
 *
 * Every step is the REAL code — `approveAndExecuteLockedPeriodChangeRequest`,
 * `prepareBatchModificationForCallerTransaction` and the canonical
 * `modifyBookingBatch` it runs under `finishedStayCorrection` — against the real
 * advisory locks, the real version CAS and the real pricing tables. The claims:
 *
 *  1. An approved add-only request on a COMPLETED, internet-banking-paid stay
 *     adds the guest, prices their past nights at the stay's season rate while
 *     the existing guest's night rows stay byte-identical, raises the amount due
 *     as the ordinary additional ask, charges no change fee, links the
 *     modification and leaves the booking COMPLETED.
 *  2. Two officers approving at once: exactly one modification and one ask. The
 *     loser reports a lost claim and writes nothing.
 *  3. Approve versus cancel: an approval that arrives while a cancel holds the
 *     global lock(1) waits for it, then sees the cancelled booking and applies
 *     nothing — the request stays REQUESTED at its old version.
 *  4. The owner's fee rule: a removal refunds at the lodge's same-day tier, a
 *     swap is charged that tier's retention on the removed portion as its
 *     change fee (never netted away), and a mixed request executes every part.
 *  5. Refusals roll the claim back: a switched-off season refuses, and an
 *     over-capacity past night waits for the officer's confirmation.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3750-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-3750-owner";
const OFFICER_ID = "race-3750-officer";
const OFFICER_2_ID = "race-3750-officer-2";
const LODGE_ID = "race-3750-lodge";
const SEASON_ID = "race-3750-season";
const BOOKING_ID = "race-3750-booking";
const GUEST_ID = "race-3750-guest";
const GUEST_2_ID = "race-3750-guest-2";
const GUEST_3_ID = "race-3750-guest-3";
const PAYMENT_ID = "race-3750-payment";
const REQUEST_ID = "race-3750-request";
const OTHER_BOOKING_ID = "race-3750-other-booking";
const ROOM_ID = "race-3750-room";
const BED_A_ID = "race-3750-bed-a";
const BED_B_ID = "race-3750-bed-b";
// Fully past against the frozen suite clock (1 July 2026).
const CHECK_IN = new Date("2026-06-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-12T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const STORED_NIGHT_CENTS = 4_321; // deliberately NOT the season rate

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeChangeRequestExecutionRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Change-request execution proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run change-request execution proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Change-request execution proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Change-request execution proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let executor: typeof import("@/lib/booking-change-request-execution");
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * The supplementary invoices queued for this booking's modifications. The Xero
 * leg is queued post-commit without being awaited by the service, so this waits
 * (on the real clock — the suite's `Date` is frozen) for the expected count.
 */
async function supplementaryInvoices(expected: number) {
  const started = process.hrtime.bigint();
  for (;;) {
    const rows = await prisma.xeroSyncOperation.findMany({
      where: {
        localModel: "BookingModification",
        localId: { in: await modificationIds() },
        idempotencyKey: { contains: ":supplementary-invoice:" },
      },
      select: { localId: true, idempotencyKey: true },
    });
    if (rows.length >= expected || realElapsedMs(started) > 5_000) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function clean(): Promise<void> {
  // The batch's post-commit Xero leg is fire-and-forget. Let the real writer
  // finish before deleting operations and the modifications that identify them.
  const enqueueErrors: unknown[] = [];
  while (pendingXeroWork.length > 0) {
    const results = await Promise.allSettled(pendingXeroWork.splice(0));
    for (const result of results) {
      if (result.status === "rejected") enqueueErrors.push(result.reason);
    }
  }
  await prisma.xeroSyncOperation.deleteMany({
    where: { localModel: "BookingModification", localId: { in: await modificationIds() } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: { in: [BOOKING_ID, REQUEST_ID] } },
        { memberId: { in: [OWNER_ID, OFFICER_ID, OFFICER_2_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.bookingChangeRequest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: OTHER_BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({
    where: { bookingGuest: { bookingId: { in: [BOOKING_ID, OTHER_BOOKING_ID] } } },
  });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: [BOOKING_ID, OTHER_BOOKING_ID] } } });
  await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, OTHER_BOOKING_ID] } } });
  // Undo the per-case capacity and season changes (no-ops before the lodge exists).
  await prisma.lodgeSettings.updateMany({ where: { id: LODGE_ID }, data: { capacity: 10 } });
  await prisma.season.updateMany({ where: { id: SEASON_ID }, data: { active: true } });
  if (enqueueErrors.length > 0) {
    throw new AggregateError(enqueueErrors, "#4234: real Xero fixture enqueues failed; all work drained and owned fixtures cleaned");
  }
}

const ADD_LATE_FRIEND = {
  checkIn: null,
  checkOut: null,
  addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }],
  removeGuests: [] as Array<{ id: string }>,
  guestStayRanges: [] as Array<{ guestId: string; stayStart: string; stayEnd: string }>,
  requestedEffectiveDate: null,
  summary: "add Late Friend",
};

async function storedGuest(id: string, firstName: string) {
  await prisma.bookingGuest.create({
    data: {
      id,
      bookingId: BOOKING_ID,
      firstName,
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: 2 * STORED_NIGHT_CENTS,
      nights: {
        create: [
          { stayDate: CHECK_IN, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
          { stayDate: NIGHT_2, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
        ],
      },
    },
  });
}

/**
 * A COMPLETED two-night stay, paid in full by internet banking against an issued
 * Xero invoice, and one LOCKED_PERIOD request about it (by default: add a guest).
 */
async function seed(
  options: {
    secondGuest?: boolean;
    requested?: Record<string, unknown>;
    /** Unpaid (PAYMENT_PENDING, nothing captured); `invoiced` keeps the issued invoice. */
    unpaid?: { invoiced: boolean };
    /** A booking-level promotion with no per-night rows (pre-#3276 shape). */
    promoAdjustmentCents?: number;
    /** #4030: paid by card (Stripe) rather than internet banking, with no invoice. */
    card?: boolean;
    /** #3954 round 6: paid wholly with account credit - nothing captured, a card on file. */
    creditPaid?: boolean;
    /** #4088: the snapshot the route now writes — each guest's range and night rows. */
    originalNights?: boolean;
  } = {},
): Promise<void> {
  const guestIds = options.secondGuest ? [GUEST_ID, GUEST_2_ID] : [GUEST_ID];
  const totalCents = guestIds.length * 2 * STORED_NIGHT_CENTS;
  const promoAdjustmentCents = options.promoAdjustmentCents ?? 0;
  const priceCents = totalCents + promoAdjustmentCents;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: options.unpaid ? "PAYMENT_PENDING" : "COMPLETED",
      totalPriceCents: totalCents,
      ...(promoAdjustmentCents
        ? { promoAdjustmentCents, discountCents: -promoAdjustmentCents }
        : {}),
      finalPriceCents: priceCents,
    },
  });
  await storedGuest(GUEST_ID, "Original");
  if (options.secondGuest) await storedGuest(GUEST_2_ID, "Second");
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: options.creditPaid ? 0 : priceCents,
      ...(options.creditPaid
        ? { source: "STRIPE" as const, creditAppliedCents: priceCents, stripeCustomerId: "cus_race_3750" }
        : options.card
          ? { source: "STRIPE" as const, stripePaymentIntentId: "pi_race_4030" }
        : { source: "INTERNET_BANKING" as const, reference: "RACE3750" }),
      status: options.unpaid ? "PENDING" : "SUCCEEDED",
      // An issued primary invoice: the edit's extra is billed by a supplementary
      // invoice and asked for by internet banking.
      ...((options.unpaid && !options.unpaid.invoiced) || options.card
        ? {}
        : { xeroInvoiceId: "race-3750-xero-invoice", xeroInvoiceNumber: "INV-3750" }),
    },
  });
  await prisma.bookingChangeRequest.create({
    data: {
      id: REQUEST_ID,
      bookingId: BOOKING_ID,
      requestedByMemberId: OWNER_ID,
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
      reason: "My friend stayed both nights too.",
      requestedChanges: {
        original: {
          checkIn: "2026-06-10",
          checkOut: "2026-06-12",
          guests: guestIds.map((id) =>
            options.originalNights
              ? {
                  id,
                  firstName: id === GUEST_ID ? "Original" : "Second",
                  lastName: "Guest",
                  stayStart: "2026-06-10",
                  stayEnd: "2026-06-12",
                  nights: ["2026-06-10", "2026-06-11"],
                }
              : { id },
          ),
        },
        requested: { ...ADD_LATE_FRIEND, ...options.requested },
      },
    },
  });
}

const GAP_CHECK_OUT = new Date("2026-06-13T00:00:00.000Z");
const GAP_LAST_NIGHT = new Date("2026-06-12T00:00:00.000Z");

/**
 * #4157: a COMPLETED 10-13 June stay, paid in full, whose two guests each hold
 * 10 and 12 June only (a gap on the 11th, #713), and one LOCKED_PERIOD request
 * sent in date-range mode with the snapshot the route writes.
 */
async function seedGapped(requested: Record<string, unknown>): Promise<void> {
  const guestIds = [GUEST_ID, GUEST_2_ID];
  const totalCents = guestIds.length * 2 * STORED_NIGHT_CENTS;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: GAP_CHECK_OUT,
      status: "COMPLETED",
      totalPriceCents: totalCents,
      finalPriceCents: totalCents,
    },
  });
  for (const [id, firstName] of [
    [GUEST_ID, "Original"],
    [GUEST_2_ID, "Second"],
  ] as const) {
    await prisma.bookingGuest.create({
      data: {
        id,
        bookingId: BOOKING_ID,
        firstName,
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        stayStart: CHECK_IN,
        stayEnd: GAP_CHECK_OUT,
        priceCents: 2 * STORED_NIGHT_CENTS,
        nights: {
          create: [
            { stayDate: CHECK_IN, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
            { stayDate: GAP_LAST_NIGHT, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: totalCents,
      source: "INTERNET_BANKING",
      reference: "RACE3750",
      status: "SUCCEEDED",
      xeroInvoiceId: "race-3750-xero-invoice",
      xeroInvoiceNumber: "INV-3750",
    },
  });
  await prisma.bookingChangeRequest.create({
    data: {
      id: REQUEST_ID,
      bookingId: BOOKING_ID,
      requestedByMemberId: OWNER_ID,
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
      reason: "Range-mode request about a stay with gaps.",
      requestedChanges: {
        original: {
          checkIn: "2026-06-10",
          checkOut: "2026-06-13",
          guests: guestIds.map((id) => ({
            id,
            firstName: id === GUEST_ID ? "Original" : "Second",
            lastName: "Guest",
            stayStart: "2026-06-10",
            stayEnd: "2026-06-13",
            nights: ["2026-06-10", "2026-06-12"],
          })),
        },
        requested: {
          ...ADD_LATE_FRIEND,
          addGuests: [],
          summary: "update guest stay ranges",
          ...requested,
        },
      },
    },
  });
}

/** Each guest's night rows, as `[stayDate, priceCents, priceSource]`. */
async function guestNightRows() {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    include: { guests: { include: { nights: { orderBy: { stayDate: "asc" } } } } },
  });
  return {
    booking,
    nightsOf: (id: string) =>
      booking.guests
        .find((guest) => guest.id === id)!
        .nights.map((night) => [night.stayDate.toISOString().slice(0, 10), night.priceCents, night.priceSource]),
  };
}

type ExecutorParams = Parameters<typeof executor.approveAndExecuteLockedPeriodChangeRequest>[0];
type ExpectedFigures = NonNullable<ExecutorParams["expectedFigures"]>;
type ApproveOptions = {
  confirmOverCapacity?: boolean;
  officerEnteredGuests?: ExecutorParams["officerEnteredGuests"];
  /** The figures the approval was shown; when absent they are checked first. */
  expectedFigures?: ExpectedFigures;
  dryRun?: boolean;
};

async function execute(
  officerId: string,
  options: ApproveOptions,
  mode: { dryRun: true } | { expectedFigures: ExpectedFigures },
) {
  return executor.approveAndExecuteLockedPeriodChangeRequest({
    ...(options.officerEnteredGuests ? { officerEnteredGuests: options.officerEnteredGuests } : {}),
    ...mode,
    requestId: REQUEST_ID,
    expectedVersion: 1,
    actorMemberId: officerId,
    adminNotes: "Added your friend to the stay.",
    internalNotes: null,
    confirmOverCapacity: options.confirmOverCapacity === true,
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
    preTransaction: await batchService.prepareBatchModificationForCallerTransaction({
      audience: "admin",
    }),
    ipAddress: "127.0.0.1",
  });
}

/**
 * The officer's own sequence: check the figures (a dry run), then approve with
 * them. An approval cannot be sent without the figures it was shown (#4030
 * re-review of 72c933ffc), so a case that names none is checked first; a dry
 * run that does not quote is returned (or throws) as the approval would.
 * A race case checks with {@link checkFigures} BEFORE it sets up the race, so
 * the approval itself, not the check, is what meets the other writer.
 */
async function approve(officerId: string, options: ApproveOptions = {}) {
  if (options.dryRun) return execute(officerId, options, { dryRun: true });
  if (options.expectedFigures) {
    return execute(officerId, options, { expectedFigures: options.expectedFigures });
  }
  const checked = await execute(officerId, options, { dryRun: true });
  if (checked.outcome !== "quoted") return checked;
  return execute(officerId, options, { expectedFigures: figuresOf(checked) });
}

function figuresOf(quoted: ExpectedFigures): ExpectedFigures {
  return {
    additionalAmountCents: quoted.additionalAmountCents,
    refundAmountCents: quoted.refundAmountCents,
    accountCreditAmountCents: quoted.accountCreditAmountCents,
  };
}

/** The figures an officer's check shows, read before a race is set up. */
async function checkFigures(officerId: string, options: ApproveOptions = {}): Promise<ExpectedFigures> {
  const checked = await execute(officerId, options, { dryRun: true });
  if (checked.outcome !== "quoted") throw new Error(`expected a quote, got ${JSON.stringify(checked)}`);
  return figuresOf(checked);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

(RUN ? describe : describe.skip)("approving a finished-stay change request, on PostgreSQL (#3750)", () => {
  beforeAll(async () => {
    assertSafeChangeRequestExecutionRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    executor = await import("@/lib/booking-change-request-execution");
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
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
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [OFFICER_ID, OFFICER_2_ID] } } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID, OFFICER_2_ID] } } });

    for (const [id, firstName] of [
      [OWNER_ID, "Owner"],
      [OFFICER_ID, "Officer"],
      [OFFICER_2_ID, "Second"],
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
          role: id === OWNER_ID ? Role.USER : Role.ADMIN,
        },
      });
    }
    for (const memberId of [OFFICER_ID, OFFICER_2_ID]) {
      await prisma.memberAccessRole.create({ data: { memberId, role: "ADMIN" } });
    }
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3750 Lodge", slug: "race-3750" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    // The lodge's own cancellation policy: a same-day (0-day) tier that keeps
    // half, and a 14-day tier that refunds in full. A finished stay measured from
    // the real today would fall below every tier and refund NOTHING; the owner's
    // decision is the same-day tier, so a removal must refund half.
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
        name: "Race 3750 winter",
        type: "WINTER",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-06-30T00:00:00.000Z"),
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
      await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [OFFICER_ID, OFFICER_2_ID] } } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID, OFFICER_2_ID] } } });
    } finally {
      restoreXeroQueue?.();
    }
  });

  it("adds the guest, prices only their nights, raises the amount due and charges no change fee", async () => {
    await seed();
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 1,
      priceDiffCents: 2 * NIGHT_CENTS,
      changeFeeCents: 0,
    });

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: {
        guests: { include: { nights: { orderBy: { stayDate: "asc" } } }, orderBy: { createdAt: "asc" } },
        payment: true,
      },
    });
    expect(booking.status).toBe("COMPLETED");
    expect(booking.finalPriceCents).toBe(2 * STORED_NIGHT_CENTS + 2 * NIGHT_CENTS);
    expect(booking.guests).toHaveLength(2);
    const original = booking.guests.find((guest) => guest.id === GUEST_ID)!;
    // The existing guest's sold nights are untouched, byte for byte.
    expect(original.nights.map((night) => [night.stayDate.toISOString(), night.priceCents, night.priceSource])).toEqual([
      [CHECK_IN.toISOString(), STORED_NIGHT_CENTS, "SOLD"],
      [NIGHT_2.toISOString(), STORED_NIGHT_CENTS, "SOLD"],
    ]);
    const added = booking.guests.find((guest) => guest.id !== GUEST_ID)!;
    // Sold now, at the price now charged — the ordinary pipeline's provenance
    // for an added guest's nights.
    expect(added.nights.map((night) => [night.priceCents, night.priceSource])).toEqual([
      [NIGHT_CENTS, "SOLD"],
      [NIGHT_CENTS, "SOLD"],
    ]);

    // The ordinary additional-payment ask for an internet-banking booking: the
    // amount due, and the supplementary invoice that bills it (Xero is not
    // connected here, so it waits in the outbox).
    expect(result).toMatchObject({ additionalAmountCents: 2 * NIGHT_CENTS });

    const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modifications).toHaveLength(1);
    expect(modifications[0]).toMatchObject({ changeFeeCents: 0, priceDiffCents: 2 * NIGHT_CENTS });
    expect(modifications[0].newData).toMatchObject({
      finishedStayCorrection: { changeRequestId: REQUEST_ID, changeFeeRule: "ADD_ONLY_NO_FEE" },
    });
    // Settlement: one supplementary invoice for exactly the extra, no fee.
    const invoices = await supplementaryInvoices(1);
    expect(invoices).toEqual([
      {
        localId: modifications[0].id,
        idempotencyKey: `booking-mod:${modifications[0].id}:supplementary-invoice:${2 * NIGHT_CENTS}:0:v1`,
      },
    ]);

    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request).toMatchObject({
      status: "APPROVED",
      version: 2,
      reviewedByMemberId: OFFICER_ID,
      adminNotes: "Added your friend to the stay.",
      linkedModificationId: modifications[0].id,
    });
  }, 60_000);

  it("two officers approving at once produce exactly one modification and one ask", async () => {
    await seed();
    // Both checked the figures first; the approvals are what race.
    const expectedFigures = await checkFigures(OFFICER_ID);
    const results = await Promise.all([
      approve(OFFICER_ID, { expectedFigures }),
      approve(OFFICER_2_ID, { expectedFigures }),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["claimLost", "executed"]);

    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(2);
    const winner = results.find((result) => result.outcome === "executed");
    expect(winner).toMatchObject({ additionalAmountCents: 2 * NIGHT_CENTS });
    // One ask: one supplementary invoice, whichever officer won.
    expect(await supplementaryInvoices(1)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await supplementaryInvoices(1)).toHaveLength(1);
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request.version).toBe(2);
    expect(request.status).toBe("APPROVED");
  }, 60_000);

  it("a removal is priced as a same-day notice change: the 0-day tier, not the real (negative) notice", async () => {
    await seed({
      secondGuest: true,
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      removedGuestCount: 1,
      priceDiffCents: -2 * STORED_NIGHT_CENTS,
      // The same-day tier keeps half of the removed guest, as the change fee...
      changeFeeCents: STORED_NIGHT_CENTS,
      // ...and the other half comes back the way it was paid.
      refundAmountCents: STORED_NIGHT_CENTS,
    });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({
      finishedStayCorrection: {
        changeRequestId: REQUEST_ID,
        changeFeeRule: "SAME_DAY_NOTICE",
        removedPortionCents: 2 * STORED_NIGHT_CENTS,
        removalFeeCents: STORED_NIGHT_CENTS,
      },
      policyRetainedAmountCents: 0,
    });
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
  }, 60_000);

  it("a swap is charged the same-day fee on the removed guest's portion, not netted away", async () => {
    await seed({
      secondGuest: true,
      requested: { removeGuests: [{ id: GUEST_2_ID }], summary: "swap Second Guest for Late Friend" },
    });
    const result = await approve(OFFICER_ID);
    // The removed guest's portion is 2 x 4,321; the same-day tier refunds half,
    // so the fee is the half it keeps — exactly what removing them alone keeps.
    const swapFee = STORED_NIGHT_CENTS;
    const priceDiff = 2 * NIGHT_CENTS - 2 * STORED_NIGHT_CENTS;
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 1,
      removedGuestCount: 1,
      priceDiffCents: priceDiff,
      changeFeeCents: swapFee,
      additionalAmountCents: priceDiff + swapFee,
    });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification).toMatchObject({ changeFeeCents: swapFee });
    expect(modification.newData).toMatchObject({
      finishedStayCorrection: { changeFeeRule: "SWAP_SAME_DAY_NOTICE" },
    });
    // The supplementary invoice bills the price difference AND the fee.
    const invoices = await supplementaryInvoices(1);
    expect(invoices.map((row) => row.idempotencyKey)).toEqual([
      `booking-mod:${modification.id}:supplementary-invoice:${priceDiff}:${swapFee}:v1`,
    ]);
  }, 60_000);

  it("#3954 round 6 (F4): a credit-paid finished stay's swap that ends as an increase records the same-day fee ONCE, and asks the card for it with the difference", async () => {
    await seed({
      secondGuest: true,
      creditPaid: true,
      requested: { removeGuests: [{ id: GUEST_2_ID }], summary: "swap Second Guest for Late Friend" },
    });
    await prisma.memberCredit.create({
      data: {
        memberId: OWNER_ID,
        amountCents: -4 * STORED_NIGHT_CENTS,
        type: "BOOKING_APPLIED",
        appliedToBookingId: BOOKING_ID,
        description: "Applied at booking",
      },
    });
    const result = await approve(OFFICER_ID);
    // The removed guest's 2 x 4,321 at the same-day tier - its credit share
    // (80%) for a booking paid with credit, so the fee keeps 20% - and the
    // added guest's 2 x 5,000 is dearer: the edit is an increase of both.
    const swapFee = Math.round((2 * STORED_NIGHT_CENTS * 20) / 100);
    const priceDiff = 2 * NIGHT_CENTS - 2 * STORED_NIGHT_CENTS;
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      priceDiffCents: priceDiff,
      changeFeeCents: swapFee,
      additionalAmountCents: priceDiff + swapFee,
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
    // Once, by `recordFinishedStayFeeOwed` - not again by the increase's own arm.
    expect(payment.changeFeeCents).toBe(swapFee);
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({ finishedStayCorrection: { feeAddedToAmountOwed: true } });
  }, 60_000);

  it("a swap that lowers the price keeps the tier once, on the removed portion, and refunds the rest in full", async () => {
    await seed({
      secondGuest: true,
      requested: {
        addGuests: [
          {
            firstName: "Late",
            lastName: "Friend",
            ageTier: "ADULT",
            isMember: false,
            stayStart: "2026-06-10",
            stayEnd: "2026-06-11",
          },
        ],
        removeGuests: [{ id: GUEST_ID }, { id: GUEST_2_ID }],
        summary: "swap both guests for one night of Late Friend",
      },
    });
    const result = await approve(OFFICER_ID);
    const removedPortion = 4 * STORED_NIGHT_CENTS;
    const swapFee = removedPortion / 2; // what the same-day tier keeps of it
    const priceDiff = NIGHT_CENTS - removedPortion;
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      changeFeeCents: swapFee,
      priceDiffCents: priceDiff,
      // Not tiered a second time: the remaining reduction comes back whole.
      refundAmountCents: -(priceDiff + swapFee),
    });
  }, 60_000);

  it("executes every part of a mixed request: a shorter stay, a removal and an add (decision 4)", async () => {
    await seed({
      secondGuest: true,
      requested: {
        checkOut: "2026-06-11",
        removeGuests: [{ id: GUEST_2_ID }],
        summary: "check-out to 2026-06-11; add Late Friend; remove Second Guest",
      },
    });
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "executed" });

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: { guests: { include: { nights: true } } },
    });
    expect(booking.checkOut.toISOString()).toBe(NIGHT_2.toISOString());
    expect(booking.guests.map((guest) => guest.firstName).sort()).toEqual(["Late", "Original"]);
    const original = booking.guests.find((guest) => guest.id === GUEST_ID)!;
    expect(original.nights.map((night) => [night.stayDate.toISOString(), night.priceCents])).toEqual([
      [CHECK_IN.toISOString(), STORED_NIGHT_CENTS],
    ]);
    const added = booking.guests.find((guest) => guest.firstName === "Late")!;
    expect(added.nights.map((night) => night.priceCents)).toEqual([NIGHT_CENTS]);
    expect(booking.finalPriceCents).toBe(STORED_NIGHT_CENTS + NIGHT_CENTS);
  }, 60_000);

  it("#4030 re-review of 72c933ffc: a shorter stay plus a removal keeps each remaining guest on the nights they stayed", async () => {
    // A three-night stay (10-13 June). Original stays all three nights, Second
    // the first two, Third only the middle night. The request removes Original
    // and moves check-out to the 12th, repeating Second's and Third's stored
    // ranges unchanged, as the request card's range grid always sends them.
    const NIGHT_3 = new Date("2026-06-12T00:00:00.000Z");
    const LONG_CHECK_OUT = new Date("2026-06-13T00:00:00.000Z");
    const nightsOf = (dates: Date[]) =>
      dates.map((stayDate) => ({ stayDate, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" as const }));
    const guests = [
      { id: GUEST_ID, firstName: "Original", nights: [CHECK_IN, NIGHT_2, NIGHT_3] },
      { id: GUEST_2_ID, firstName: "Second", nights: [CHECK_IN, NIGHT_2] },
      { id: GUEST_3_ID, firstName: "Third", nights: [NIGHT_2] },
    ];
    const totalCents = 6 * STORED_NIGHT_CENTS;
    await prisma.booking.create({
      data: {
        id: BOOKING_ID,
        memberId: OWNER_ID,
        lodgeId: LODGE_ID,
        checkIn: CHECK_IN,
        checkOut: LONG_CHECK_OUT,
        status: "COMPLETED",
        totalPriceCents: totalCents,
        finalPriceCents: totalCents,
      },
    });
    for (const guest of guests) {
      const last = guest.nights[guest.nights.length - 1];
      await prisma.bookingGuest.create({
        data: {
          id: guest.id,
          bookingId: BOOKING_ID,
          firstName: guest.firstName,
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          stayStart: guest.nights[0],
          stayEnd: new Date(last.getTime() + 24 * 60 * 60 * 1000),
          priceCents: guest.nights.length * STORED_NIGHT_CENTS,
          nights: { create: nightsOf(guest.nights) },
        },
      });
    }
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: totalCents,
        source: "INTERNET_BANKING",
        reference: "RACE3750",
        status: "SUCCEEDED",
        xeroInvoiceId: "race-3750-xero-invoice",
        xeroInvoiceNumber: "INV-3750",
      },
    });
    await prisma.bookingChangeRequest.create({
      data: {
        id: REQUEST_ID,
        bookingId: BOOKING_ID,
        requestedByMemberId: OWNER_ID,
        kind: "LOCKED_PERIOD",
        status: "REQUESTED",
        reason: "Original went home early; the others left on the 12th.",
        requestedChanges: {
          original: {
            checkIn: "2026-06-10",
            checkOut: "2026-06-13",
            guests: [
              { id: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-13" },
              { id: GUEST_2_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
              { id: GUEST_3_ID, stayStart: "2026-06-11", stayEnd: "2026-06-12" },
            ],
          },
          requested: {
            ...ADD_LATE_FRIEND,
            addGuests: [],
            checkOut: "2026-06-12",
            removeGuests: [{ id: GUEST_ID }],
            guestStayRanges: [
              { guestId: GUEST_2_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
              { guestId: GUEST_3_ID, stayStart: "2026-06-11", stayEnd: "2026-06-12" },
            ],
            summary: "check-out to 2026-06-12; remove Original Guest",
          },
        },
      },
    });

    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "executed" });

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: { guests: { include: { nights: { orderBy: { stayDate: "asc" } } } } },
    });
    expect(booking.checkOut.toISOString()).toBe(NIGHT_3.toISOString());
    const nightsBy = Object.fromEntries(
      booking.guests.map((guest) => [
        guest.firstName,
        guest.nights.map((night) => [night.stayDate.toISOString(), night.priceCents]),
      ]),
    );
    // Nobody gains a night: Third is charged for the middle night only, never
    // stretched back to the 10th.
    expect(nightsBy).toEqual({
      Second: [
        [CHECK_IN.toISOString(), STORED_NIGHT_CENTS],
        [NIGHT_2.toISOString(), STORED_NIGHT_CENTS],
      ],
      Third: [[NIGHT_2.toISOString(), STORED_NIGHT_CENTS]],
    });
    expect(booking.finalPriceCents).toBe(3 * STORED_NIGHT_CENTS);
    // #4030 round 7 (F3): how the money goes back. Only Original's three nights
    // are removed; the same-day tier keeps half of them as the change fee, and
    // the other half comes back the way the stay was paid (internet banking),
    // never as account credit. No extra is asked of anyone.
    const removedCents = 3 * STORED_NIGHT_CENTS;
    const refundCents = Math.round(removedCents / 2);
    expect(result).toMatchObject({
      addedGuestCount: 0,
      removedGuestCount: 1,
      priceDiffCents: -removedCents,
      changeFeeCents: removedCents - refundCents,
      refundAmountCents: refundCents,
      accountCreditAmountCents: 0,
      additionalAmountCents: 0,
    });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({
      finishedStayCorrection: { changeFeeRule: "SAME_DAY_NOTICE", removedPortionCents: removedCents },
    });
  }, 60_000);

  it("#4030 round 7 (F1): a guest's nights changed after the request was sent is drift, and nothing is applied", async () => {
    // The request card sends every guest's range, unchanged ones included, and
    // the request stores each guest's range as it stood.
    await seed({
      secondGuest: true,
      requested: {
        guestStayRanges: [
          { guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
          { guestId: GUEST_2_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
        ],
      },
    });
    const stored = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    const changes = stored.requestedChanges as { original: Record<string, unknown>; requested: unknown };
    await prisma.bookingChangeRequest.update({
      where: { id: REQUEST_ID },
      data: {
        requestedChanges: {
          ...changes,
          original: {
            ...changes.original,
            guests: [GUEST_ID, GUEST_2_ID].map((id) => ({ id, stayStart: "2026-06-10", stayEnd: "2026-06-12" })),
          },
        } as never,
      },
    });
    // Then an officer trims Second to the first night (and refunds it): the
    // guest row and its nights as that edit leaves them.
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuestId: GUEST_2_ID, stayDate: NIGHT_2 } });
    await prisma.bookingGuest.update({
      where: { id: GUEST_2_ID },
      data: { stayEnd: NIGHT_2, priceCents: STORED_NIGHT_CENTS },
    });

    // Re-applying the request's stale 10-12 range would charge that night again.
    const result = await approve(OFFICER_ID);
    expect(result).toEqual({ outcome: "keptPending", message: executor.LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    const second = await prisma.bookingGuest.findUniqueOrThrow({
      where: { id: GUEST_2_ID },
      include: { nights: true },
    });
    expect(second.nights.map((night) => night.stayDate.toISOString())).toEqual([CHECK_IN.toISOString()]);
    expect(await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } })).toMatchObject({
      status: "REQUESTED",
      version: 1,
    });
  }, 60_000);

  it("#4030 round 7 (F1): a request whose stored ranges still match the guests is not drift", async () => {
    await seed({
      secondGuest: true,
      requested: {
        guestStayRanges: [
          { guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
          { guestId: GUEST_2_ID, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
        ],
      },
    });
    const stored = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    const changes = stored.requestedChanges as { original: Record<string, unknown>; requested: unknown };
    await prisma.bookingChangeRequest.update({
      where: { id: REQUEST_ID },
      data: {
        requestedChanges: {
          ...changes,
          original: {
            ...changes.original,
            guests: [GUEST_ID, GUEST_2_ID].map((id) => ({ id, stayStart: "2026-06-10", stayEnd: "2026-06-12" })),
          },
        } as never,
      },
    });
    expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", addedGuestCount: 1 });
  }, 60_000);

  it("refuses a stay whose season has been switched off, and keeps the request pending", async () => {
    await seed();
    await prisma.season.update({ where: { id: SEASON_ID }, data: { active: false } });
    await expect(approve(OFFICER_ID)).rejects.toThrow("No season rate found for the requested dates");
    // The claim rolled back with the refused edit.
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request).toMatchObject({ status: "REQUESTED", version: 1, linkedModificationId: null });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  }, 60_000);

  it("warns on an over-capacity past night, and applies once the officer confirms (decision 3)", async () => {
    await seed();
    await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 2 } });
    // Somebody else filled the other bed on those nights.
    await prisma.booking.create({
      data: {
        id: OTHER_BOOKING_ID,
        memberId: OFFICER_2_ID,
        lodgeId: LODGE_ID,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        status: "COMPLETED",
        totalPriceCents: 0,
        finalPriceCents: 0,
        guests: {
          create: {
            firstName: "Other",
            lastName: "Stayer",
            ageTier: "ADULT",
            isMember: false,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            priceCents: 0,
          },
        },
      },
    });

    const { OverCapacityConfirmationRequiredError } = await import("@/lib/over-capacity-confirmation");
    await expect(approve(OFFICER_ID)).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
    expect(
      await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } }),
    ).toMatchObject({ status: "REQUESTED", version: 1 });

    const confirmed = await approve(OFFICER_ID, { confirmOverCapacity: true });
    expect(confirmed).toMatchObject({ outcome: "executed", capacityOverridden: true });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } });
    expect(booking.capacityOverriddenByMemberId).toBe(OFFICER_ID);
  }, 60_000);

  it("an unpaid, invoiced stay keeps the same retained share as a paid one (owner D3)", async () => {
    await seed({
      secondGuest: true,
      unpaid: { invoiced: true },
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      priceDiffCents: -2 * STORED_NIGHT_CENTS,
      changeFeeCents: STORED_NIGHT_CENTS,
      refundAmountCents: 0,
    });
    // The invoice is corrected by the reduction LESS the retained share, so the
    // member still owes exactly what a paid member keeps losing: the same
    // figure the paid case refunds.
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    const started = process.hrtime.bigint();
    let notes: Array<{ idempotencyKey: string | null }> = [];
    while (notes.length === 0 && realElapsedMs(started) < 5_000) {
      notes = await prisma.xeroSyncOperation.findMany({
        where: {
          localModel: "BookingModification",
          localId: modification.id,
          idempotencyKey: { contains: "credit-note" },
        },
        select: { idempotencyKey: true },
      });
      if (notes.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(notes).toHaveLength(1);
    expect(notes[0].idempotencyKey).toContain(String(STORED_NIGHT_CENTS));
  }, 60_000);

  it.each([
    ["the card pay step", "card"],
    ["an officer recording the payment (cash or internet banking)", "officer"],
  ] as const)(
    "an unpaid stay with no invoice owes the fee on top, and %s collects and reconciles it (owner, 7 Oct)",
    async (_name, collector) => {
      await seed({
        secondGuest: true,
        unpaid: { invoiced: false },
        requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
      });
      const fee = STORED_NIGHT_CENTS; // the same-day tier keeps half of the removed guest
      expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", changeFeeCents: fee });

      const paymentState = await import("@/lib/booking-payment-state");
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: BOOKING_ID },
        include: { payment: true },
      });
      // Recorded where every pay step reads it, and owed on top of the price.
      expect(booking.payment?.changeFeeCents).toBe(fee);
      const owed = paymentState.bookingAmountOwedCents({
        finalPriceCents: booking.finalPriceCents,
        changeFeeCents: booking.payment?.changeFeeCents ?? null,
        appliedCreditCents: 0,
      });
      expect(owed).toBe(2 * STORED_NIGHT_CENTS + fee);
      // A paid member in the same position would have been refunded half the
      // removed guest and kept paying the rest: the same total.
      expect(owed).toBe(4 * STORED_NIGHT_CENTS - STORED_NIGHT_CENTS);
      const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
      expect(modification.newData).toMatchObject({
        finishedStayCorrection: { feeAddedToAmountOwed: true, feeOnPrimaryInvoice: true },
      });

      const reconciliation = await import("@/lib/payment-reconciliation");
      if (collector === "card") {
        const settled = await reconciliation.markBookingPaymentSucceeded({
          bookingId: BOOKING_ID,
          paymentIntentId: "pi_race_3750_owed",
          amountCents: owed,
          paymentMethodId: null,
          format: CLUB_FORMAT_TEST,
        });
        expect(settled.outcome).toBe("paid");
      } else {
        const manualState = await import("@/lib/manual-booking-payment-state");
        const state = await manualState.getBookingManualPaymentState(BOOKING_ID);
        expect(state?.amountOwingCents).toBe(owed);
        await reconciliation.markBookingPaymentManuallySettled({
          bookingId: BOOKING_ID,
          actingAdminMemberId: OFFICER_ID,
          note: null,
          expectedAmountCents: owed,
          notifyMember: false,
          format: CLUB_FORMAT_TEST,
        });
      }

      const paid = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
      expect(paid.status).toBe("PAID");
      // The ledger's identity: price + recorded fee = cash captured + credit.
      expect(paid.payment!.amountCents + paid.payment!.creditAppliedCents).toBe(
        paid.finalPriceCents + paid.payment!.changeFeeCents,
      );
      const feeLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, kind: "CHANGE_FEE" },
        select: { amountCents: true, anchorId: true },
      });
      expect(feeLines).toEqual([{ amountCents: fee, anchorId: modification.id }]);
    },
    60_000,
  );

  it.each([
    // Credit equal to the worth after the correction: settled at $0 with the
    // fee PAID BY THAT CREDIT — nothing given back, nothing lost.
    ["covers the price and the fee", 3 * STORED_NIGHT_CENTS, "PAID", 0],
    // Less credit: the remainder of price plus fee is still owed.
    ["covers part of it", 10_000, "PAYMENT_PENDING", 3 * STORED_NIGHT_CENTS - 10_000],
  ] as const)(
    "#3955 F1: on an unpaid stay whose applied credit %s, the clamp and the zero-dollar decision read the worth, so the fee is kept",
    async (_name, creditCents, status, owedAfterCents) => {
      await seed({
        secondGuest: true,
        unpaid: { invoiced: false },
        requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
      });
      await prisma.memberCredit.create({
        data: {
          memberId: OWNER_ID,
          amountCents: -creditCents,
          type: "BOOKING_APPLIED",
          appliedToBookingId: BOOKING_ID,
          description: "Applied at booking",
        },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: creditCents } });
      const fee = STORED_NIGHT_CENTS;

      expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", changeFeeCents: fee });

      const memberCredit = await import("@/lib/member-credit");
      const paymentState = await import("@/lib/booking-payment-state");
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
      // Price after the removal: one guest, two stored nights.
      expect(booking.finalPriceCents).toBe(2 * STORED_NIGHT_CENTS);
      expect(booking.payment?.changeFeeCents).toBe(fee);
      // Not one cent of credit was given back: the bare price is below the
      // credit, but the worth (price plus fee) is not.
      expect(await memberCredit.deriveBookingAppliedCreditCents(BOOKING_ID, prisma)).toBe(creditCents);
      expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID, amountCents: { gt: 0 } } })).toBe(0);
      expect(booking.status).toBe(status);
      expect(
        paymentState.bookingAmountOwedCents({
          finalPriceCents: booking.finalPriceCents,
          changeFeeCents: booking.payment?.changeFeeCents ?? null,
          appliedCreditCents: creditCents,
        }),
      ).toBe(owedAfterCents);
      if (status === "PAID") {
        // The $0 settle's identity: price + recorded fee = cash (none) + credit.
        expect(booking.payment!.amountCents + booking.payment!.creditAppliedCents).toBe(
          booking.finalPriceCents + booking.payment!.changeFeeCents,
        );
      }
    },
    60_000,
  );

  it("#3955 X4: a primary invoice persisted while the correction runs refuses the fee write, and nothing is applied", async () => {
    await seed({
      secondGuest: true,
      unpaid: { invoiced: false },
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const { FINISHED_STAY_INVOICE_RAISED_MESSAGE } = await import("@/lib/booking-finished-stay-correction");
    // The officer checked the figures before the invoice started persisting.
    const expectedFigures = await checkFigures(OFFICER_ID);
    // An invoice create persisting its link: it holds the payment row, not yet
    // committed, while the approval reads "no invoice" and routes its fee to
    // the primary invoice.
    const holding = deferred();
    const release = deferred();
    const persist = prisma.$transaction(
      async (tx) => {
        await tx.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: "race-3750-late-invoice" } });
        holding.resolve();
        await release.promise;
      },
      { timeout: 30_000 },
    );
    await holding.promise;
    const approval = approve(OFFICER_ID, { expectedFigures });
    const approvalSettled = approval.then(
      () => "executed",
      (error: unknown) => error,
    );
    // Long enough for the approval to reach its claimed fee write and queue
    // on the row the persist holds (real clock; the suite's Date is frozen).
    await new Promise((resolve) => setTimeout(resolve, 750));
    release.resolve();
    await persist;

    const outcome = await approvalSettled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(FINISHED_STAY_INVOICE_RAISED_MESSAGE);
    // Nothing applied: the request is still pending, both guests are on the
    // stay, and no fee was recorded beside the invoice that does not bill it.
    expect(await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } })).toMatchObject({
      status: "REQUESTED",
      version: 1,
    });
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(2);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      changeFeeCents: 0,
      xeroInvoiceId: "race-3750-late-invoice",
    });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  }, 60_000);

  it("#3955 round 3: an invoice built before the fee bills the gap once, unpaid, on the correction — re-checked by the retry", async () => {
    await seed({
      secondGuest: true,
      unpaid: { invoiced: false },
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const fee = STORED_NIGHT_CENTS;
    expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", changeFeeCents: fee });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });

    const gap = await import("@/lib/xero-primary-invoice-fee-gap");
    const { startXeroSyncOperation } = await import("@/lib/xero-sync");
    const { buildXeroBookingInvoiceCorrelationKey } = await import("@/lib/xero-booking-invoice-key");
    const invoices = await import("@/lib/xero-booking-invoices");
    const invoiceId = "race-3750-gap-invoice";
    try {
      // The create whose invoice was built before the fee was recorded (it
      // bills the remaining guest and no fee): it saves its link with what it
      // billed and the fee recorded then, and dies before its gap check.
      const key = buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      const operation = await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: PAYMENT_ID,
        idempotencyKey: key,
        correlationKey: key,
        requestPayload: { invoices: [] },
      });
      // #3980: the lines it sent, and the booking it read: the correction's
      // price without its fee, which is the one thing it missed.
      const { finalPriceCents } = await prisma.booking.findUniqueOrThrow({
        where: { id: BOOKING_ID },
        select: { finalPriceCents: true },
      });
      await gap.persistPrimaryInvoiceLink({
        operationId: operation.id,
        paymentId: PAYMENT_ID,
        xeroInvoiceNumber: null,
        billed: gap.primaryInvoiceBilledFee(invoiceId, [
          { description: "Original Guest", quantity: 1, unitAmount: (2 * STORED_NIGHT_CENTS) / 100 },
        ]),
        built: { worthCents: finalPriceCents, lineTotalCents: 2 * STORED_NIGHT_CENTS },
        // Unpaid: no Stripe cash on the invoice.
        primaryInvoiceCashCents: 0,
        primaryInvoiceAttemptedCashCents: 0,
      });

      // The retry takes the create's "invoice already exists" exit — twice.
      await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID, { syncOperation: operation })).resolves.toBe(
        invoiceId,
      );
      await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(invoiceId);

      const queued = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: modification.id },
        select: { status: true, requestPayload: true },
      });
      // Once, for the fee alone, raised unpaid like any edit's supplementary invoice.
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("PENDING");
      expect(queued[0].requestPayload).toMatchObject({
        bookingId: BOOKING_ID,
        bookingModificationId: modification.id,
        priceDiffCents: 0,
        changeFeeCents: fee,
        recordPayment: false,
      });
    } finally {
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
    }
  }, 60_000);

  it("#3955 round 4: a fee recorded AFTER the link is never billed by the retry's re-check", async () => {
    await seed({
      secondGuest: true,
      unpaid: { invoiced: false },
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const fee = STORED_NIGHT_CENTS;
    expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", changeFeeCents: fee });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });

    const gap = await import("@/lib/xero-primary-invoice-fee-gap");
    const { startXeroSyncOperation } = await import("@/lib/xero-sync");
    const { buildXeroBookingInvoiceCorrelationKey } = await import("@/lib/xero-booking-invoice-key");
    const { CHANGE_FEE_LINE_DESCRIPTION } = await import("@/lib/xero-modification-line-items");
    const invoices = await import("@/lib/xero-booking-invoices");
    const invoiceId = "race-3750-after-link-invoice";
    try {
      // The create bills the correction's fee in full and saves its link; the
      // fee the save reads back is that fee.
      const key = buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      const operation = await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: PAYMENT_ID,
        idempotencyKey: key,
        correlationKey: key,
        requestPayload: { invoices: [] },
      });
      // #3980: it read the corrected booking, fee and all, and billed it.
      const { finalPriceCents } = await prisma.booking.findUniqueOrThrow({
        where: { id: BOOKING_ID },
        select: { finalPriceCents: true },
      });
      const atLink = await gap.persistPrimaryInvoiceLink({
        operationId: operation.id,
        paymentId: PAYMENT_ID,
        xeroInvoiceNumber: null,
        billed: gap.primaryInvoiceBilledFee(invoiceId, [
          { description: "Original Guest", quantity: 1, unitAmount: (2 * STORED_NIGHT_CENTS) / 100 },
          { description: CHANGE_FEE_LINE_DESCRIPTION, quantity: 1, unitAmount: fee / 100 },
        ]),
        built: { worthCents: finalPriceCents + fee, lineTotalCents: 2 * STORED_NIGHT_CENTS + fee },
        primaryInvoiceCashCents: 0,
        primaryInvoiceAttemptedCashCents: 0,
      });
      if (!atLink) throw new Error("expected the first save of this link");
      expect(atLink).toMatchObject({ billedChangeFeeCents: fee, recordedChangeFeeCentsAtLink: fee, primaryInvoiceCashCents: 0 });
      // #3955 round 5, finding 4: stored with the link, in the same transaction.
      expect(
        (await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operation.id }, select: { requestPayload: true } }))
          .requestPayload,
      ).toMatchObject({
        primaryInvoiceBilledFee: { primaryInvoiceCashCents: 0, primaryInvoiceAttemptedCashCents: 0, recordedChangeFeeCentsAtLink: fee },
      });

      // A later edit records its own fee, billed on its own document.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: { increment: 3_000 } } });

      // The retry's "invoice already exists" exit re-checks from the stored
      // figures: no gap, nothing queued on the correction.
      await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID, { syncOperation: operation })).resolves.toBe(
        invoiceId,
      );
      expect(
        await prisma.xeroSyncOperation.count({ where: { localModel: "BookingModification", localId: modification.id } }),
      ).toBe(0);
    } finally {
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
    }
  }, 60_000);

  it("#3980: a correction landing mid-create is measured on its whole worth, so its removal is not billed again", async () => {
    await seed({
      secondGuest: true,
      unpaid: { invoiced: false },
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    // The create read the booking before the correction: both guests, no fee.
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } });
    const builtLines = [
      { description: "Original Guest", quantity: 1, unitAmount: (2 * STORED_NIGHT_CENTS) / 100 },
      { description: "Second Guest", quantity: 1, unitAmount: (2 * STORED_NIGHT_CENTS) / 100 },
    ];
    const fee = STORED_NIGHT_CENTS;
    expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed", changeFeeCents: fee });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    // It read no invoice link, so it claimed the payment row and is marked.
    expect(modification.newData).toMatchObject({
      primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true },
      finishedStayCorrection: { feeOnPrimaryInvoice: true },
    });

    const gap = await import("@/lib/xero-primary-invoice-fee-gap");
    const { startXeroSyncOperation } = await import("@/lib/xero-sync");
    const { buildXeroBookingInvoiceCorrelationKey } = await import("@/lib/xero-booking-invoice-key");
    const invoiceId = "race-3750-mid-create-invoice";
    try {
      const key = buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      const operation = await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: PAYMENT_ID,
        idempotencyKey: key,
        correlationKey: key,
        requestPayload: { invoices: [] },
      });
      // Its link is saved after the correction committed: the worth read back
      // holds the removal and the fee; the invoice bills the pre-correction lines.
      const atLink = await gap.persistPrimaryInvoiceLink({
        operationId: operation.id,
        paymentId: PAYMENT_ID,
        xeroInvoiceNumber: null,
        billed: gap.primaryInvoiceBilledFee(invoiceId, builtLines),
        built: { worthCents: before.finalPriceCents, lineTotalCents: 4 * STORED_NIGHT_CENTS },
        primaryInvoiceCashCents: 0,
        primaryInvoiceAttemptedCashCents: 0,
      });
      if (!atLink) throw new Error("expected the first save of this link");
      const after = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } });
      expect(atLink.worth).toEqual({
        atBuildCents: before.finalPriceCents,
        builtTotalCents: 4 * STORED_NIGHT_CENTS,
        atLinkCents: after.finalPriceCents + fee,
      });

      // The fee-only check (#3955) billed the fee on top of an invoice still
      // billing the removed guest. Measured on worth, the invoice bills more
      // than the booking is worth: the treasurer's task, and nothing billed.
      const result = await gap.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink });
      expect(result.gapCents).toBe(after.finalPriceCents + fee - before.finalPriceCents);
      expect(result.gapCents).toBeLessThan(0);
      expect(result.reviewOperationId).not.toBeNull();
      expect(
        await prisma.xeroSyncOperation.count({ where: { localModel: "BookingModification", localId: modification.id } }),
      ).toBe(0);
      expect(
        await prisma.xeroSyncOperation.findUniqueOrThrow({
          where: { id: result.reviewOperationId! },
          select: { status: true, replayable: true, lastErrorCode: true },
        }),
      ).toEqual({ status: "FAILED", replayable: false, lastErrorCode: "PRIMARY_INVOICE_OVERBILLED" });
    } finally {
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
    }
  }, 60_000);

  it("a nights-only change is charged the same-day share of the nights it removes, never the ordinary late fee (owner, 7 Oct)", async () => {
    // A tier that would make moving check-in one day later a "more lenient"
    // move, so the ordinary late-change fee would charge a share of the WHOLE
    // booking. The owner's rule charges only the night actually removed.
    await prisma.cancellationPolicy.create({
      data: { id: "race-3750-tier-1", lodgeId: LODGE_ID, daysBeforeStay: 1, refundPercentage: 90, creditRefundPercentage: 90 },
    });
    try {
      await seed({
        requested: { addGuests: [], checkIn: "2026-06-11", summary: "check-in to 2026-06-11" },
      });
      const result = await approve(OFFICER_ID);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "executed",
        priceDiffCents: -STORED_NIGHT_CENTS,
        changeFeeCents: STORED_NIGHT_CENTS - Math.round(STORED_NIGHT_CENTS / 2),
      });
      const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
      expect(modification.newData).toMatchObject({
        finishedStayCorrection: { removedPortionCents: STORED_NIGHT_CENTS },
      });
    } finally {
      await prisma.cancellationPolicy.deleteMany({ where: { id: "race-3750-tier-1" } });
    }
  }, 60_000);

  it("a nights-only extension is charged the added night normally and no fee", async () => {
    await seed({
      requested: { addGuests: [], checkOut: "2026-06-13", summary: "check-out to 2026-06-13" },
    });
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      priceDiffCents: NIGHT_CENTS,
      changeFeeCents: 0,
    });
  }, 60_000);

  it("#4088: a grid request's night sets are applied and charged exactly, gap and all", async () => {
    // From the editor's per-night grid: the stay runs a night longer, the
    // existing guest swaps their second night for the new third one, and the
    // added friend stays the first and third nights only — gaps no two-bound
    // range can express.
    await seed({
      requested: {
        checkOut: "2026-06-13",
        addGuests: [
          { ...ADD_LATE_FRIEND.addGuests[0], nights: ["2026-06-10", "2026-06-12"] },
        ],
        guestStayRanges: [{ guestId: GUEST_ID, nights: ["2026-06-10", "2026-06-12"] }],
        summary: "check-out to 2026-06-13; add Late Friend; update 1 guest stay range",
      },
      originalNights: true,
    });
    const result = await approve(OFFICER_ID);
    // Three nights added at the season rate (the friend's two, the guest's
    // 12 June) and one removed (the guest's 11 June, sold at 4,321), which is
    // charged the same-day tier's retention as the change fee.
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 1,
      priceDiffCents: 3 * NIGHT_CENTS - STORED_NIGHT_CENTS,
      changeFeeCents: STORED_NIGHT_CENTS - Math.round(STORED_NIGHT_CENTS / 2),
    });
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: BOOKING_ID },
      include: { guests: { include: { nights: { orderBy: { stayDate: "asc" } } } } },
    });
    expect(booking.checkOut.toISOString()).toBe("2026-06-13T00:00:00.000Z");
    const original = booking.guests.find((guest) => guest.id === GUEST_ID)!;
    expect(original.nights.map((night) => [night.stayDate.toISOString(), night.priceCents])).toEqual([
      [CHECK_IN.toISOString(), STORED_NIGHT_CENTS],
      ["2026-06-12T00:00:00.000Z", NIGHT_CENTS],
    ]);
    const added = booking.guests.find((guest) => guest.id !== GUEST_ID)!;
    expect(added.nights.map((night) => [night.stayDate.toISOString(), night.priceCents])).toEqual([
      [CHECK_IN.toISOString(), NIGHT_CENTS],
      ["2026-06-12T00:00:00.000Z", NIGHT_CENTS],
    ]);
    expect(added.priceCents).toBe(2 * NIGHT_CENTS);
  }, 60_000);

  it("#4088: a night row removed since a grid request was sent is drift, and nothing is applied", async () => {
    await seed({
      // Adds the friend, and keeps the guest on both nights as the grid sent them.
      requested: {
        guestStayRanges: [{ guestId: GUEST_ID, nights: ["2026-06-10", "2026-06-11"] }],
        summary: "add Late Friend; update 1 guest stay range",
      },
      originalNights: true,
    });
    // An officer took 11 June off the guest after the request: the guest's
    // range is unmoved, only the night row is gone. Applying the request would
    // put the night back and charge for it.
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuestId: GUEST_ID, stayDate: NIGHT_2 } });
    const result = await approve(OFFICER_ID);
    expect(result, JSON.stringify(result)).toEqual({
      outcome: "keptPending",
      message: executor.LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE,
    });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request).toMatchObject({ status: "REQUESTED", version: 1 });
  }, 60_000);

  it("#4157: a gapped guest whose range is repeated keeps their gap and is not charged for it", async () => {
    // Date-range mode: the member adds a friend for the whole stay and sends
    // the gapped guest's own Date In and Date Out back unchanged.
    await seedGapped({
      addGuests: ADD_LATE_FRIEND.addGuests,
      guestStayRanges: [{ guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-13" }],
      summary: "add Late Friend; update 1 guest stay range",
    });
    const result = await approve(OFFICER_ID);
    // Only the friend's three nights are charged: the 11th is not put on the
    // gapped guest (before #4157 it was, at the season rate).
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 1,
      priceDiffCents: 3 * NIGHT_CENTS,
      changeFeeCents: 0,
    });
    const { booking, nightsOf } = await guestNightRows();
    expect(booking.checkOut.toISOString()).toBe(GAP_CHECK_OUT.toISOString());
    // Byte for byte, both gapped guests: the one the request named, and the
    // one it did not.
    for (const id of [GUEST_ID, GUEST_2_ID]) {
      expect(nightsOf(id)).toEqual([
        ["2026-06-10", STORED_NIGHT_CENTS, "SOLD"],
        ["2026-06-12", STORED_NIGHT_CENTS, "SOLD"],
      ]);
    }
    const added = booking.guests.find((guest) => ![GUEST_ID, GUEST_2_ID].includes(guest.id))!;
    expect(added.nights).toHaveLength(3);
    // The approval recorded what it kept, and the decided card reads it back:
    // the guest's own two nights, "no change".
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request.status).toBe("APPROVED");
    expect((request.requestedChanges as { keptNights?: unknown }).keptNights).toEqual([
      { guestId: GUEST_ID, nights: ["2026-06-10", "2026-06-12"] },
    ]);
    const { describeRequestedGuestNights } = await import("@/lib/booking-change-request-stored");
    expect(
      describeRequestedGuestNights(request.requestedChanges, { status: request.status }).find(
        (guest) => !guest.added,
      ),
      "INV-REQ-012: the decided card reads the recorded kept nights",
    ).toEqual({
      name: "Original Guest",
      runs: [
        { firstNight: "2026-06-10", lastNight: "2026-06-10" },
        { firstNight: "2026-06-12", lastNight: "2026-06-12" },
      ],
      nightCount: 2,
      added: false,
      unchanged: true,
      fillsGaps: false,
    });
  }, 60_000);

  it("#4157: in a mixed party the repeated guest keeps their nights and the moved guest gets the new continuous stay", async () => {
    await seedGapped({
      guestStayRanges: [
        // Repeated: the guest's own dates, gap and all.
        { guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-13" },
        // Really moved: from the 11th, so 10 June comes off and 11 June goes on.
        { guestId: GUEST_2_ID, stayStart: "2026-06-11", stayEnd: "2026-06-13" },
      ],
      summary: "update 2 guest stay ranges",
    });
    const result = await approve(OFFICER_ID);
    // One night added at the season rate (the moved guest's 11th) and one
    // removed (their 10th, sold at 4,321), charged the same-day tier's
    // retention as the change fee. Nothing for the repeated guest.
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      priceDiffCents: NIGHT_CENTS - STORED_NIGHT_CENTS,
      changeFeeCents: STORED_NIGHT_CENTS - Math.round(STORED_NIGHT_CENTS / 2),
    });
    const { nightsOf } = await guestNightRows();
    expect(nightsOf(GUEST_ID)).toEqual([
      ["2026-06-10", STORED_NIGHT_CENTS, "SOLD"],
      ["2026-06-12", STORED_NIGHT_CENTS, "SOLD"],
    ]);
    expect(nightsOf(GUEST_2_ID).map(([night]) => night)).toEqual(["2026-06-11", "2026-06-12"]);
    // Recorded: the repeated guest only; the moved guest's range was applied.
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect((request.requestedChanges as { keptNights?: unknown }).keptNights).toEqual([
      { guestId: GUEST_ID, nights: ["2026-06-10", "2026-06-12"] },
    ]);
  }, 60_000);

  it("trimming a kept guest while adding another is charged on the trimmed night (F3/F4)", async () => {
    await seed({
      requested: {
        guestStayRanges: [{ guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-11" }],
        summary: "add Late Friend; Original Guest leaves a night early",
      },
    });
    const result = await approve(OFFICER_ID);
    // The trimmed night is 4,321; the same-day tier refunds round(4,321 / 2) = 2,161.
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      changeFeeCents: STORED_NIGHT_CENTS - Math.round(STORED_NIGHT_CENTS / 2),
    });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({
      finishedStayCorrection: { changeFeeRule: "SAME_DAY_NOTICE", removedPortionCents: STORED_NIGHT_CENTS },
    });
  }, 60_000);

  it("values the removed guest net of the booking's promotion (F5)", async () => {
    const promo = -Math.round((4 * STORED_NIGHT_CENTS) / 10); // a 10% booking-level discount
    await seed({
      secondGuest: true,
      promoAdjustmentCents: promo,
      requested: { addGuests: [], removeGuests: [{ id: GUEST_2_ID }], summary: "remove Second Guest" },
    });
    const result = await approve(OFFICER_ID);
    const removedNet = 2 * STORED_NIGHT_CENTS + Math.round((2 * STORED_NIGHT_CENTS * promo) / (4 * STORED_NIGHT_CENTS));
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      changeFeeCents: removedNet - Math.round(removedNet / 2),
    });
  }, 60_000);

  it("judges the booking's promo code on its check-in day, so an expired code is kept, not billed back (F1)", async () => {
    await seed({ promoAdjustmentCents: -Math.round((2 * STORED_NIGHT_CENTS) / 10) });
    const code = await prisma.promoCode.create({
      data: {
        code: "RACE3750TEN",
        type: "PERCENTAGE",
        percentOff: 10,
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        // Valid on the stay's check-in (10 June), expired before today (1 July).
        validUntil: new Date("2026-06-20T00:00:00.000Z"),
      },
    });
    try {
      await prisma.promoRedemption.create({
        data: {
          promoCodeId: code.id,
          bookingId: BOOKING_ID,
          memberId: OWNER_ID,
          discountCents: Math.round((2 * STORED_NIGHT_CENTS) / 10),
          priceAdjustmentCents: -Math.round((2 * STORED_NIGHT_CENTS) / 10),
        },
      });
      const result = await approve(OFFICER_ID);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "executed" });
      const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
      expect(modification.newData).toMatchObject({ promoRemoved: false });
      expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } });
      expect(booking.promoAdjustmentCents).toBeLessThan(0);
    } finally {
      await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.promoRedemptionAllocation.deleteMany({ where: { promoCodeId: code.id } });
      await prisma.promoRedemption.deleteMany({ where: { promoCodeId: code.id } });
      await prisma.promoCode.delete({ where: { id: code.id } });
    }
  }, 60_000);

  it("never touches past beds: no pruning of a trimmed night, no placement of an added guest (owner D2)", async () => {
    const prior = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { bedAllocation: true } });
    await prisma.clubModuleSettings.upsert({
      where: { id: "default" },
      create: { id: "default", bedAllocation: true },
      update: { bedAllocation: true },
      select: { id: true },
    });
    await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.bedAllocationSettings.create({
      data: {
        id: LODGE_ID,
        lodgeId: LODGE_ID,
        autoAllocationEnabled: true,
        allocationPriorityOrder: ["BOOKING_COHESION", "STAY_CONTINUITY", "REQUESTED_ROOM", "FAMILY_COHESION"],
        updatedByMemberId: OFFICER_ID,
      },
    });
    await prisma.lodgeRoom.create({
      data: {
        id: ROOM_ID,
        lodgeId: LODGE_ID,
        name: "Race 3750 room",
        beds: { create: [{ id: BED_A_ID, name: "A" }, { id: BED_B_ID, name: "B" }] },
      },
    });
    try {
      await seed({
        requested: {
          guestStayRanges: [{ guestId: GUEST_ID, stayStart: "2026-06-10", stayEnd: "2026-06-11" }],
          summary: "add Late Friend; Original Guest leaves a night early",
        },
      });
      await prisma.bedAllocation.create({
        data: { bookingId: BOOKING_ID, bookingGuestId: GUEST_ID, roomId: ROOM_ID, bedId: BED_A_ID, stayDate: NIGHT_2, source: "MANUAL" },
      });
      expect(await approve(OFFICER_ID)).toMatchObject({ outcome: "executed" });
      const allocations = await prisma.bedAllocation.findMany({
        where: { bookingId: BOOKING_ID },
        select: { bookingGuestId: true, stayDate: true },
      });
      // The trimmed night's row is still there, and nobody was placed.
      expect(allocations).toEqual([{ bookingGuestId: GUEST_ID, stayDate: NIGHT_2 }]);
    } finally {
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.clubModuleSettings.update({
        where: { id: "default" },
        data: { bedAllocation: prior?.bedAllocation ?? false },
        select: { id: true },
      });
    }
  }, 60_000);

  it("an approval racing a cancel waits on lock(1), then applies nothing to the cancelled booking", async () => {
    await seed();
    // The officer checked the figures before the cancel began.
    const expectedFigures = await checkFigures(OFFICER_ID);
    const lockHeld = deferred();
    const releaseCancel = deferred();
    const cancel = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        lockHeld.resolve();
        await releaseCancel.promise;
        await tx.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      },
      { timeout: 30_000 },
    );
    await lockHeld.promise;

    let approvalSettled = false;
    const approval = approve(OFFICER_ID, { expectedFigures }).finally(() => {
      approvalSettled = true;
    });
    // The approval is queued behind the cancel's global key, not racing it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(approvalSettled).toBe(false);

    releaseCancel.resolve();
    await cancel;
    const result = await approval;

    expect(result).toMatchObject({ outcome: "keptPending" });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(request).toMatchObject({ status: "REQUESTED", version: 1, linkedModificationId: null });
  }, 60_000);
  // ---------------------------------------------------------------------------
  // #4030 Part B: the officer enters the guests a free-text request described.
  // ---------------------------------------------------------------------------

  /** What the old free-text card stored: an effective date and nothing else. */
  const FREE_TEXT = {
    addGuests: [],
    summary: "effective 2026-06-10",
    requestedEffectiveDate: "2026-06-10",
  };
  const GRANDCHILDREN = [
    { firstName: "Ari", lastName: "Grandchild", ageTier: "ADULT" as const, isMember: false, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
    { firstName: "Bo", lastName: "Grandchild", ageTier: "ADULT" as const, isMember: false, stayStart: "2026-06-11", stayEnd: "2026-06-12" },
  ];

  async function storedRequested() {
    const request = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    return { request, requested: (request.requestedChanges as { requested: Record<string, unknown> }).requested };
  }

  it("#4030: an officer's entry on an internet-banking stay is recorded on the request, applied, and billed with no fee", async () => {
    await seed({ requested: FREE_TEXT });
    const result = await approve(OFFICER_ID, { officerEnteredGuests: GRANDCHILDREN });
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 2,
      // Ari two nights, Bo one: three nights at the season rate, no fee.
      priceDiffCents: 3 * NIGHT_CENTS,
      changeFeeCents: 0,
      additionalAmountCents: 3 * NIGHT_CENTS,
      officerEnteredGuests: GRANDCHILDREN,
    });

    // The entry is on the request, named as the officer's on the member's behalf.
    const { request, requested } = await storedRequested();
    expect(request).toMatchObject({ status: "APPROVED", version: 2, reviewedByMemberId: OFFICER_ID });
    expect(request.linkedModificationId).toBeTruthy();
    expect(requested).toMatchObject({
      addGuests: GRANDCHILDREN,
      requestedEffectiveDate: "2026-06-10",
      officerEntry: {
        onMemberBehalf: true,
        officerMemberId: OFFICER_ID,
        memberSummary: "effective 2026-06-10",
      },
    });
    expect(String(requested.summary)).toMatch(/^add Ari Grandchild, Bo Grandchild \(entered by a booking officer/);

    // Applied: each guest holds exactly the nights entered; the original guest is untouched.
    const guests = await prisma.bookingGuest.findMany({
      where: { bookingId: BOOKING_ID },
      include: { nights: { orderBy: { stayDate: "asc" } } },
    });
    const nightsOf = (firstName: string) =>
      guests.find((guest) => guest.firstName === firstName)!.nights.map((night) => [night.stayDate.toISOString(), night.priceCents]);
    expect(nightsOf("Ari")).toEqual([[CHECK_IN.toISOString(), NIGHT_CENTS], [NIGHT_2.toISOString(), NIGHT_CENTS]]);
    expect(nightsOf("Bo")).toEqual([[NIGHT_2.toISOString(), NIGHT_CENTS]]);
    expect(nightsOf("Original")).toEqual([[CHECK_IN.toISOString(), STORED_NIGHT_CENTS], [NIGHT_2.toISOString(), STORED_NIGHT_CENTS]]);

    // Settled the ordinary way: one supplementary invoice for exactly the extra, no fee.
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification).toMatchObject({ changeFeeCents: 0, priceDiffCents: 3 * NIGHT_CENTS });
    expect(await supplementaryInvoices(1)).toEqual([
      {
        localId: modification.id,
        idempotencyKey: `booking-mod:${modification.id}:supplementary-invoice:${3 * NIGHT_CENTS}:0:v1`,
      },
    ]);
  });

  it("#4030: an officer's entry on a card-paid stay raises the card ask for the extra", async () => {
    await seed({ requested: FREE_TEXT, card: true });
    const result = await approve(OFFICER_ID, { officerEnteredGuests: [GRANDCHILDREN[0]] });
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "executed",
      addedGuestCount: 1,
      priceDiffCents: 2 * NIGHT_CENTS,
      changeFeeCents: 0,
      additionalAmountCents: 2 * NIGHT_CENTS,
      settlementMethod: "card",
    });
    const { request, requested } = await storedRequested();
    expect(request.status).toBe("APPROVED");
    expect(requested.officerEntry).toMatchObject({ officerMemberId: OFFICER_ID });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification).toMatchObject({ changeFeeCents: 0, priceDiffCents: 2 * NIGHT_CENTS });
    // A card booking is asked by card, never billed on a supplementary invoice.
    expect(await supplementaryInvoices(0)).toEqual([]);
  });

  it("#4030: a refused approval rolls the officer's entry back with it — the request is exactly as the member left it", async () => {
    await seed({ requested: FREE_TEXT });
    const before = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    // Three beds, and somebody else holds two on those nights: two more guests
    // overbook the past nights, and nobody has confirmed it.
    await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 3 } });
    await prisma.booking.create({
      data: {
        id: OTHER_BOOKING_ID,
        memberId: OFFICER_2_ID,
        lodgeId: LODGE_ID,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        status: "COMPLETED",
        totalPriceCents: 0,
        finalPriceCents: 0,
        guests: {
          create: [1, 2].map((n) => ({
            firstName: `Other${n}`,
            lastName: "Stayer",
            ageTier: "ADULT" as const,
            isMember: false,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            priceCents: 0,
          })),
        },
      },
    });
    const { OverCapacityConfirmationRequiredError } = await import("@/lib/over-capacity-confirmation");
    await expect(approve(OFFICER_ID, { officerEnteredGuests: GRANDCHILDREN })).rejects.toBeInstanceOf(
      OverCapacityConfirmationRequiredError,
    );
    const after = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(after).toMatchObject({ status: "REQUESTED", version: 1, linkedModificationId: null, reviewedByMemberId: null });
    expect(after.requestedChanges).toEqual(before.requestedChanges);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

    // Confirmed, the same entry applies once.
    const confirmed = await approve(OFFICER_ID, { officerEnteredGuests: GRANDCHILDREN, confirmOverCapacity: true });
    expect(confirmed).toMatchObject({ outcome: "executed", capacityOverridden: true, addedGuestCount: 2 });
  }, 60_000);

  it("#4030: an entry on a request that already names a change is refused before anything is written", async () => {
    await seed();
    const result = await approve(OFFICER_ID, { officerEnteredGuests: GRANDCHILDREN });
    expect(result).toEqual({
      outcome: "keptPending",
      message: executor.OFFICER_ENTRY_ON_STRUCTURED_REQUEST_MESSAGE,
    });
    const { request, requested } = await storedRequested();
    expect(request).toMatchObject({ status: "REQUESTED", version: 1 });
    expect(requested).not.toHaveProperty("officerEntry");
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  });
  it("#4030 review C1: two officers entering different guests at once — one applies, the other loses the claim", async () => {
    await seed({ requested: FREE_TEXT });
    // Each officer checked the figures for their own entry first.
    const first = { officerEnteredGuests: [GRANDCHILDREN[0]] };
    const second = { officerEnteredGuests: [GRANDCHILDREN[1]] };
    const [firstFigures, secondFigures] = [
      await checkFigures(OFFICER_ID, first),
      await checkFigures(OFFICER_2_ID, second),
    ];
    const results = await Promise.all([
      approve(OFFICER_ID, { ...first, expectedFigures: firstFigures }),
      approve(OFFICER_2_ID, { ...second, expectedFigures: secondFigures }),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes, JSON.stringify(results)).toEqual(["claimLost", "executed"]);
    const winnerIndex = results.findIndex((result) => result.outcome === "executed");
    const winnerId = winnerIndex === 0 ? OFFICER_ID : OFFICER_2_ID;
    const winnerGuest = GRANDCHILDREN[winnerIndex];

    const { request, requested } = await storedRequested();
    expect(request).toMatchObject({ status: "APPROVED", version: 2, reviewedByMemberId: winnerId });
    expect(requested.addGuests).toEqual([winnerGuest]);
    expect(requested.officerEntry).toMatchObject({ officerMemberId: winnerId });
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    const guests = await prisma.bookingGuest.findMany({ where: { bookingId: BOOKING_ID } });
    expect(guests.map((guest) => guest.firstName).sort()).toEqual(["Original", winnerGuest!.firstName].sort());
  }, 60_000);

  it("#4030 review C2: a dry run with an officer's entry quotes it and writes nothing", async () => {
    await seed({ requested: FREE_TEXT });
    const before = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    const result = await approve(OFFICER_ID, { officerEnteredGuests: GRANDCHILDREN, dryRun: true });
    expect(result, JSON.stringify(result)).toMatchObject({
      outcome: "quoted",
      additionalAmountCents: 3 * NIGHT_CENTS,
      changeFeeCents: 0,
    });
    const after = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(after).toMatchObject({ status: "REQUESTED", version: 1, reviewedByMemberId: null, linkedModificationId: null });
    expect(after.requestedChanges).toEqual(before.requestedChanges);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
  });

  it("#4030 review C4: an approval whose figures moved since the check is refused and rolled back", async () => {
    await seed({ requested: FREE_TEXT });
    const before = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    await expect(
      approve(OFFICER_ID, {
        officerEnteredGuests: GRANDCHILDREN,
        // The officer was shown one night fewer than the edit now charges.
        expectedFigures: { additionalAmountCents: 2 * NIGHT_CENTS, refundAmountCents: 0, accountCreditAmountCents: 0 },
      }),
    ).rejects.toBeInstanceOf(executor.FinishedStayFiguresChangedError);
    const after = await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID } });
    expect(after).toMatchObject({ status: "REQUESTED", version: 1, linkedModificationId: null });
    expect(after.requestedChanges).toEqual(before.requestedChanges);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

    // With the figures the edit really produces, it applies once.
    const applied = await approve(OFFICER_ID, {
      officerEnteredGuests: GRANDCHILDREN,
      expectedFigures: { additionalAmountCents: 3 * NIGHT_CENTS, refundAmountCents: 0, accountCreditAmountCents: 0 },
    });
    expect(applied).toMatchObject({ outcome: "executed", additionalAmountCents: 3 * NIGHT_CENTS });
  }, 60_000);
});
