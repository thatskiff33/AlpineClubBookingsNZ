/**
 * Real-PostgreSQL proof for fork #119: an officer adds an existing booking to a
 * work party the member forgot to tick ("Add booking to work party").
 *
 * Every step is the REAL code — `addBookingToWorkParty`, which runs the
 * canonical `modifyBookingBatch` on its own transaction under the global
 * `lock(1)`, the lodge capacity key and the booking row lock, with the
 * `officerWorkPartyCorrection` service argument — against the real promo
 * engine, the real credit ledger, the real booking ledger and the real Xero
 * outbox. The claims:
 *
 *  1. Unpaid (PAYMENT_PENDING, nothing captured): the price drops by exactly
 *     the discount on the nights inside the window (a stay only partly in it),
 *     a redemption of the internal promo is written, no credit, and the amount
 *     owed drops by the same figure.
 *  2. Fully paid by card, inside a cancellation tier that keeps half: the
 *     reduction comes back IN FULL as account credit, with no change fee, no
 *     refund or hand-back, ledger lines under the edit, and one Xero
 *     account-credit note queued. A control shows the ordinary edit of the same
 *     booking in the same tier WOULD cut it.
 *  3. Part-paid (an earlier increase's card ask still unpaid): the unpaid ask
 *     takes the reduction first, and only the excess becomes credit.
 *  4. The dry run writes nothing; an apply with figures other than the ones
 *     quoted is refused and writes nothing.
 *  5. Two concurrent applies with the same figures: one applies, the other is
 *     refused, and the discount lands once.
 *  6. Members still cannot enter the internal code: not as the owner, not as an
 *     officer without the argument, and not with the argument naming another
 *     work party's promo.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL the race harness provisions (#1881) and the `realdb-all`
 * job finds it by its name; it cleans its own `race-119-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-119-owner";
const OFFICER_ID = "race-119-officer";
const LODGE_ID = "race-119-lodge";
const SEASON_ID = "race-119-season";
const BOOKING_ID = "race-119-booking";
const GUEST_ID = "race-119-guest";
const PAYMENT_ID = "race-119-payment";
const PRIMARY_TXN_ID = "race-119-primary";
const ASK_TXN_ID = "race-119-ask";
const INCREASE_MOD_ID = "race-119-increase";
const EVENT_ID = "race-119-event";
const PROMO_ID = "race-119-promo";
const PROMO_CODE = "RACE119WORKBEE";
const OTHER_EVENT_ID = "race-119-other-event";
const OTHER_PROMO_ID = "race-119-other-promo";
const OTHER_PROMO_CODE = "RACE119OTHERBEE";
const PUBLIC_PROMO_ID = "race-119-public-promo";
const PUBLIC_PROMO_CODE = "RACE119PUBLIC";
const XERO_INVOICE_ID = "race-119-xero-invoice";
const ORGANISER_BOOKING_ID = "race-119-organiser-booking";
const STARTED_EVENT_ID = "race-119-started-event";
const STARTED_PROMO_ID = "race-119-started-promo";
const STARTED_PROMO_CODE = "RACE119STARTEDBEE";
const ALL_PROMO_IDS = [PROMO_ID, OTHER_PROMO_ID, PUBLIC_PROMO_ID, STARTED_PROMO_ID];

// FUTURE against the frozen suite clock (1 July 2026): 31 days out.
const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"].map(
  (day) => new Date(`${day}T00:00:00.000Z`),
);
const CHECK_OUT = new Date("2026-08-05T00:00:00.000Z");
// The working bee covers the last two nights only (end date inclusive).
const WINDOW_START = new Date("2026-08-03T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-04T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = NIGHTS.length * NIGHT_CENTS;
const DISCOUNT_PERCENT = 50;
/** 50% off the two in-window nights; the two before the window pay in full. */
const DISCOUNT_CENTS = 2 * NIGHT_CENTS * (DISCOUNT_PERCENT / 100);
/** Part-paid: an earlier increase's card ask still unpaid. */
const ASK_CENTS = 3_000;
/** A stay that began on the frozen today (1 July 2026); a work party covers it. */
const STARTED_STAY = {
  nights: [new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-02T00:00:00.000Z")],
  checkOut: new Date("2026-07-03T00:00:00.000Z"),
};
/** The marker the modification and its audit carry (`OFFICER_WORK_PARTY_MONEY_RULE`). */
const WORK_PARTY_MARKER = {
  workPartyEventId: EVENT_ID,
  promoCodeId: PROMO_ID,
  changeFee: "none",
  reduction: "returned in full",
};

let prisma: PrismaClient;
let correction: typeof import("@/lib/work-party-booking-correction");
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let memberCredit: typeof import("@/lib/member-credit");
let amountOwed: typeof import("@/lib/booking-amount-owed");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** The booking's queued Xero work for its modifications, once the post-commit leg has queued it. */
async function modificationXeroOps(expected: number) {
  const started = process.hrtime.bigint();
  for (;;) {
    await Promise.allSettled(pendingXeroWork);
    const ids = (await modificationIds()).filter((id) => id !== INCREASE_MOD_ID);
    const rows = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: { in: ids } },
      select: { localId: true, idempotencyKey: true, queueType: true },
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
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({
    where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: XERO_INVOICE_ID }] },
  });
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
  // M3b: the journal's batches name the booking's ledger lines (RESTRICT), so release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: OWNER_ID } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoRedemptionAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoRedemption.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.promoCode.updateMany({
    where: { id: { in: ALL_PROMO_IDS } },
    data: { currentRedemptions: 0 },
  });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRefund.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  // The organiser's booking after its joiner's, which points at it.
  await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
  if (enqueueErrors.length > 0) {
    throw new AggregateError(enqueueErrors, "fork #119: real Xero fixture enqueues failed; owned fixtures cleaned");
  }
}

async function teardownFixtures(): Promise<void> {
  await prisma.workPartyEvent.deleteMany({ where: { id: { in: [EVENT_ID, OTHER_EVENT_ID, STARTED_EVENT_ID] } } });
  await prisma.promoCode.deleteMany({ where: { id: { in: ALL_PROMO_IDS } } });
  await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
  await prisma.season.deleteMany({ where: { id: SEASON_ID } });
  await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
  await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
  await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
}

type Shape = "unpaid" | "paid" | "part-paid" | "credit-paid" | "organiser-paid";

/**
 * The owner as their own guest, four nights at the season rate, as the booking
 * flow writes it, in one of three money shapes:
 *  - unpaid: PAYMENT_PENDING, the card intent open at the price, nothing captured;
 *  - paid: PAID, the price captured by card against an issued Xero invoice, the
 *    confirmation's ledger lines posted;
 *  - part-paid: as paid, but an earlier increase of `ASK_CENTS` is an unpaid
 *    card ask (the primary invoice raised after it, so it bills the whole price);
 *  - credit-paid: PAID wholly with the member's account credit, no card money;
 *  - organiser-paid: a joiner's booking its group organiser settled by card
 *    (`paidByOrganiserCard`: organiser-settled, a parent, a STRIPE mirror).
 * `stay` defaults to the four August nights.
 */
async function seed(
  shape: Shape,
  stay: { nights: Date[]; checkOut: Date } = { nights: NIGHTS, checkOut: CHECK_OUT },
): Promise<void> {
  const checkIn = stay.nights[0]!;
  const price = stay.nights.length * NIGHT_CENTS;
  if (shape === "organiser-paid") {
    await prisma.booking.create({
      data: {
        id: ORGANISER_BOOKING_ID,
        memberId: OWNER_ID,
        lodgeId: LODGE_ID,
        checkIn,
        checkOut: stay.checkOut,
        status: "PAID",
        totalPriceCents: 0,
        finalPriceCents: 0,
      },
    });
  }
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn,
      checkOut: stay.checkOut,
      status: shape === "unpaid" ? "PAYMENT_PENDING" : "PAID",
      totalPriceCents: price,
      finalPriceCents: price,
      ...(shape === "organiser-paid" ? { parentBookingId: ORGANISER_BOOKING_ID, organiserSettled: true } : {}),
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Owner",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      memberId: OWNER_ID,
      stayStart: checkIn,
      stayEnd: stay.checkOut,
      priceCents: price,
      nights: {
        create: stay.nights.map((stayDate) => ({ stayDate, priceCents: NIGHT_CENTS, priceSource: "SOLD" as const })),
      },
    },
  });

  if (shape === "unpaid") {
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: PRICE_CENTS,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_race_119_open",
        transactions: {
          create: {
            id: PRIMARY_TXN_ID,
            kind: "PRIMARY",
            source: "STRIPE",
            amountCents: PRICE_CENTS,
            status: "PENDING",
            stripePaymentIntentId: "pi_race_119_open",
          },
        },
      },
    });
    return;
  }

  if (shape === "credit-paid") {
    // Paid wholly from the member's balance: the opening credit, then the
    // booking's BOOKING_APPLIED row, so the balance stands at 0.
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: 0,
        creditAppliedCents: price,
        source: "STRIPE",
        status: "SUCCEEDED",
      },
    });
    await prisma.memberCredit.create({
      data: { memberId: OWNER_ID, amountCents: price, type: "ADMIN_ADJUSTMENT", description: "race 119 opening balance" },
    });
    await prisma.$transaction((tx) =>
      memberCredit.applyCreditToBooking(OWNER_ID, price, BOOKING_ID, tx, CLUB_FORMAT_TEST),
    );
  } else if (shape === "organiser-paid") {
    // The child's mirror of the organiser's card settlement: no intent of its own.
    await prisma.payment.create({
      data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: price, source: "STRIPE", status: "SUCCEEDED" },
    });
  } else {
    await seedCardPayment(shape, price);
  }
  // The stay's confirmation lines, as its settle posted them: an edit posts
  // its own ledger lines only onto a booking the ledger already holds.
  const ledger = await import("@/lib/booking-ledger-confirmation-sync");
  await prisma.$transaction((tx) =>
    ledger.postStoredBookingConfirmationLedgerLines(tx, BOOKING_ID, memberMoneyTestContext()),
  );
}

/** Paid or part-paid: the capture by card against an issued Xero invoice, and any unpaid ask. */
async function seedCardPayment(shape: "paid" | "part-paid", price: number): Promise<void> {
  const capturedCents = shape === "part-paid" ? price - ASK_CENTS : price;
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: capturedCents,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripeCustomerId: "cus_race_119",
      stripePaymentIntentId: "pi_race_119_primary",
      xeroInvoiceId: XERO_INVOICE_ID,
      xeroInvoiceNumber: "INV-119",
      transactions: {
        create: {
          id: PRIMARY_TXN_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          amountCents: capturedCents,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_race_119_primary",
        },
      },
    },
  });
  if (shape === "part-paid") {
    // The increase that raised the ask, and the ask itself, as the minter wrote it.
    await prisma.bookingModification.create({
      data: {
        id: INCREASE_MOD_ID,
        bookingId: BOOKING_ID,
        memberId: OWNER_ID,
        modificationType: "GUEST_ADD",
        previousData: {},
        newData: {},
        priceDiffCents: ASK_CENTS,
      },
    });
    await prisma.paymentTransaction.create({
      data: {
        id: ASK_TXN_ID,
        paymentId: PAYMENT_ID,
        kind: "ADDITIONAL",
        source: "STRIPE",
        status: "PENDING",
        amountCents: ASK_CENTS,
        stripePaymentIntentId: "pi_race_119_ask",
        reason: "guest_add_price_increase",
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        // The primary invoice was raised after the increase and bills it.
        hadIssuedXeroInvoice: false,
      },
    });
    const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
    await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      amountCents: price - ASK_CENTS,
      status: "SUCCEEDED",
      additionalAmountCents: ASK_CENTS,
      additionalPaymentStatus: "PENDING",
    });
  }
}

type Figures = import("@/lib/work-party-booking-correction").WorkPartyCorrectionFigures;

async function common(workPartyEventId = EVENT_ID) {
  return {
    bookingId: BOOKING_ID,
    workPartyEventId,
    actorMemberId: OFFICER_ID,
    notifyMember: false,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
    preTransaction: await batchService.prepareBatchModificationForCallerTransaction({ audience: "admin" }),
  };
}

async function quote(): Promise<Figures> {
  const result = await correction.addBookingToWorkParty({ ...(await common()), dryRun: true });
  expect(result.outcome).toBe("quoted");
  return result.figures;
}

async function apply(expectedFigures: Figures) {
  return correction.addBookingToWorkParty({ ...(await common()), dryRun: false, expectedFigures });
}

/** Everything the correction could write, for the "writes nothing" claims. */
async function snapshot() {
  const [booking, payment, redemptions, modifications, credits, ledgerLines, xeroOps, refunds, recoveries, tasks] =
    await Promise.all([
      prisma.booking.findUniqueOrThrow({
        where: { id: BOOKING_ID },
        select: {
          status: true,
          finalPriceCents: true,
          totalPriceCents: true,
          promoAdjustmentCents: true,
          guests: { select: { priceCents: true, nights: { select: { priceCents: true }, orderBy: { stayDate: "asc" } } } },
        },
      }),
      prisma.payment.findUnique({ where: { id: PAYMENT_ID } }),
      prisma.promoRedemption.count({ where: { bookingId: BOOKING_ID } }),
      prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } }),
      memberCredit.getMemberCreditBalance(OWNER_ID),
      prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID } }),
      prisma.xeroSyncOperation.count({
        where: { OR: [{ localId: { in: [BOOKING_ID, PAYMENT_ID] } }, { localModel: "BookingModification", localId: { in: await modificationIds() } }] },
      }),
      prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } }),
      prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } }),
      prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } }),
    ]);
  return { booking, payment, redemptions, modifications, credits, ledgerLines, xeroOps, refunds, recoveries, tasks };
}

async function bookingRow() {
  return prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { id: true, finalPriceCents: true, promoAdjustmentCents: true, payment: { select: { changeFeeCents: true } } },
  });
}

/** The service's refusal as status and message, or null if it quoted. */
async function correctionRefusal(workPartyEventId = EVENT_ID): Promise<{ status: number; message: string } | null> {
  return correction.addBookingToWorkParty({ ...(await common(workPartyEventId)), dryRun: true }).then(
    () => null,
    (error: { status: number; message: string }) => ({ status: error.status, message: error.message }),
  );
}

/** The batch edit's audit row for a modification: written after commit, so polled. */
async function batchAuditRow(modificationId: string) {
  const started = process.hrtime.bigint();
  for (;;) {
    const row = await prisma.auditLog.findFirst({
      where: { action: "booking.modify.batch", targetId: BOOKING_ID, entityId: modificationId },
    });
    if (row || realElapsedMs(started) > 5_000) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Any refund hand-back the edit queued: there must be none. */
async function refundOperations() {
  return prisma.paymentRecoveryOperation.findMany({
    where: { bookingId: BOOKING_ID, type: { in: ["REFUND_SUPERSEDED_PAYMENT", "REFUND_BOOKING_MODIFICATION"] } },
    select: { type: true, amountCents: true },
  });
}

async function workPartyRedemptions() {
  return prisma.promoRedemption.findMany({ where: { bookingId: BOOKING_ID, promoCodeId: PROMO_ID } });
}

/** What the ordinary batch edit says when handed the internal code, or null if it took it. */
async function batchRefusal(params: {
  actor: { id: string; role: Role };
  officerWorkPartyCorrection?: { workPartyEventId: string; promoCodeId: string };
  /** Run as the correction runs it: on a caller transaction (the argument requires one). */
  callerTransaction?: boolean;
}): Promise<string | null> {
  const base = {
    bookingId: BOOKING_ID,
    actor: params.actor,
    input: { promoCodes: [{ code: PROMO_CODE }], notifyMember: false },
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
    ...(params.officerWorkPartyCorrection ? { officerWorkPartyCorrection: params.officerWorkPartyCorrection } : {}),
  };
  const run = params.callerTransaction
    ? batchService
        .prepareBatchModificationForCallerTransaction({ audience: "admin" })
        .then((preTransaction) =>
          prisma.$transaction((tx) => batchService.modifyBookingBatch({ ...base, tx, preTransaction })),
        )
    : batchService.modifyBookingBatch(base);
  return run.then(
    () => null,
    (error: Error) => error.message,
  );
}

(RUN ? describe : describe.skip)("adding a booking to a work party, on PostgreSQL (fork #119)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Work party booking correction");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    correction = await import("@/lib/work-party-booking-correction");
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    memberCredit = await import("@/lib/member-credit");
    amountOwed = await import("@/lib/booking-amount-owed");
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    // Pass-through: the harness imports every suite into one process.
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 119 Lodge", slug: "race-119" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    // The stay is 31 days out, inside a tier that keeps half: an ordinary edit's
    // reduction would come back halved there. The work-party correction's does not.
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 60, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
      ],
    });
    // Every membership type at one rate, so whichever rate the owner's nights
    // resolve to is the stored night price.
    const membershipTypes = await prisma.membershipType.findMany({ select: { id: true } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 119 winter",
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
    // The work party and its internal promo, as `createWorkPartyEventWithPromo`
    // writes them; and a second one, whose id must not admit the first's code.
    for (const [eventId, promoId, code, name] of [
      [EVENT_ID, PROMO_ID, PROMO_CODE, "Race 119 working bee"],
      [OTHER_EVENT_ID, OTHER_PROMO_ID, OTHER_PROMO_CODE, "Race 119 other working bee"],
      [STARTED_EVENT_ID, STARTED_PROMO_ID, STARTED_PROMO_CODE, "Race 119 July working bee"],
    ] as const) {
      await prisma.promoCode.create({
        data: {
          id: promoId,
          code,
          internal: true,
          description: `Working bee: ${name}`,
          type: "PERCENTAGE",
          percentOff: DISCOUNT_PERCENT,
          membersOnly: true,
          active: true,
        },
      });
      await prisma.workPartyEvent.create({
        data: {
          id: eventId,
          name,
          // The July one covers the started stay, so only its start refuses it.
          startDate: eventId === STARTED_EVENT_ID ? STARTED_STAY.nights[0]! : WINDOW_START,
          endDate: eventId === STARTED_EVENT_ID ? STARTED_STAY.nights[1]! : WINDOW_END,
          discountPercent: DISCOUNT_PERCENT,
          active: true,
          lodgeId: LODGE_ID,
          promoCodeId: promoId,
        },
      });
    }
    // The control: an ordinary public code an officer may enter on any edit.
    await prisma.promoCode.create({
      data: {
        id: PUBLIC_PROMO_ID,
        code: PUBLIC_PROMO_CODE,
        type: "PERCENTAGE",
        percentOff: DISCOUNT_PERCENT,
        active: true,
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
      await teardownFixtures();
    } finally {
      restoreXeroQueue?.();
    }
  });

  it("unpaid: lowers the price and the amount owed by the discount on the in-window nights only, writing no credit", async () => {
    await seed("unpaid");
    const owedBefore = await amountOwed.readBookingAmountOwed(await bookingRow());
    expect(owedBefore.owedCents).toBe(PRICE_CENTS);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    });
    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });

    const booking = await bookingRow();
    expect(booking.finalPriceCents).toBe(PRICE_CENTS - DISCOUNT_CENTS);
    expect(booking.promoAdjustmentCents).toBe(-DISCOUNT_CENTS);
    expect(await workPartyRedemptions()).toEqual([
      expect.objectContaining({ promoCodeId: PROMO_ID, memberId: OWNER_ID, discountCents: DISCOUNT_CENTS }),
    ]);
    // Only the two nights inside the window carry the discount.
    const adjustments = await prisma.bookingGuestNightAdjustment.findMany({
      where: { bookingId: BOOKING_ID, promoCodeId: PROMO_ID, bookingGuestNightId: { not: null } },
      select: { amountCents: true, bookingGuestNight: { select: { stayDate: true } } },
    });
    expect(
      adjustments.map((row) => row.bookingGuestNight!.stayDate.toISOString().slice(0, 10)).sort(),
    ).toEqual(["2026-08-03", "2026-08-04"]);
    expect(adjustments.reduce((sum, row) => sum + Math.abs(row.amountCents ?? 0), 0)).toBe(DISCOUNT_CENTS);

    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
    const owedAfter = await amountOwed.readBookingAmountOwed(booking);
    expect(owedAfter.owedCents).toBe(PRICE_CENTS - DISCOUNT_CENTS);
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
    expect(await refundOperations()).toEqual([]);

    const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modifications).toHaveLength(1);
    expect(modifications[0]).toMatchObject({ changeFeeCents: 0, priceDiffCents: -DISCOUNT_CENTS });
  }, 60_000);

  it("fully paid by card: the reduction comes back IN FULL as account credit, untiered, with no fee or refund", async () => {
    await seed("paid");
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      // The whole reduction: the 50% tier the stay sits in does not touch it.
      accountCreditAmountCents: DISCOUNT_CENTS,
      appliedCreditGivenBackCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    });
    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    if (result.outcome !== "applied") throw new Error("not applied");

    expect(await bookingRow()).toMatchObject({
      finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      promoAdjustmentCents: -DISCOUNT_CENTS,
    });
    expect(await workPartyRedemptions()).toHaveLength(1);

    const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modifications).toHaveLength(1);
    const modification = modifications[0]!;
    expect(result.bookingModificationId).toBe(modification.id);
    expect(modification).toMatchObject({ changeFeeCents: 0, priceDiffCents: -DISCOUNT_CENTS });

    // The credit, minted once from this modification, and the balance it raises.
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect((await prisma.memberCredit.findMany({ where: { memberId: OWNER_ID } })).filter((row) => row.amountCents > 0)).toEqual([
      expect.objectContaining({ amountCents: DISCOUNT_CENTS, sourceBookingModificationId: modification.id }),
    ]);

    // No money back to the card: no Stripe refund, no refund hand-back, no
    // refund task. The capture's refundable headroom is consumed by the credit
    // (`createModificationCredit`, #1031: `refundedAmountCents` counts account
    // credit too), so a later cancel cannot refund the same cents again.
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      amountCents: PRICE_CENTS,
      refundedAmountCents: DISCOUNT_CENTS,
    });
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await refundOperations()).toEqual([]);

    // Ledger lines posted for the edit, under its own anchor.
    expect(
      await prisma.bookingLedgerLine.count({
        where: { bookingId: BOOKING_ID, anchorKind: "MODIFICATION", anchorId: modification.id },
      }),
    ).toBeGreaterThan(0);

    // The app's own Xero document: one unapplied account-credit note for the reduction.
    const ops = await modificationXeroOps(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ localId: modification.id });
    expect(ops[0]!.idempotencyKey).toMatch(/account-credit/);
  }, 60_000);

  it("control: the ordinary edit of the same paid booking in the same tier WOULD cut the reduction", async () => {
    await seed("paid");
    const ordinary = await batchService.modifyBookingBatch({
      bookingId: BOOKING_ID,
      actor: { id: OFFICER_ID, role: Role.ADMIN },
      input: { promoCodes: [{ code: PUBLIC_PROMO_CODE }], settlementMethod: "credit", notifyMember: false },
      ipAddress: "127.0.0.1",
      todayAtClub: (await clubTimeServer.clubTime()).today(),
      format: CLUB_FORMAT_TEST,
    });
    expect(ordinary.priceDiffCents).toBeLessThan(0);
    // The tier keeps half: what comes back is less than the reduction.
    expect(ordinary.accountCreditAmountCents + ordinary.refundAmountCents).toBeLessThan(-ordinary.priceDiffCents);
  }, 60_000);

  it("part-paid: the unpaid ask takes the reduction first, and only the excess becomes credit", async () => {
    await seed("part-paid");
    const owedBefore = await amountOwed.readBookingAmountOwed(await bookingRow());
    expect(owedBefore.owedCents).toBe(PRICE_CENTS);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      accountCreditAmountCents: DISCOUNT_CENTS - ASK_CENTS,
      appliedCreditGivenBackCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    });
    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });

    // The unpaid ask is gone: nothing more is asked of the card, and its intent
    // is queued for cancellation (no Stripe here, so the queued row stays).
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      amountCents: PRICE_CENTS - ASK_CENTS,
      additionalAmountCents: 0,
      // Only the excess consumed the capture's refundable headroom, as credit.
      refundedAmountCents: DISCOUNT_CENTS - ASK_CENTS,
    });
    expect(
      await prisma.paymentRecoveryOperation.count({
        where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", paymentIntentId: "pi_race_119_ask" },
      }),
    ).toBe(1);
    // And only the excess over it is credit; nothing is refunded to the card.
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS - ASK_CENTS);
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
    expect(await refundOperations()).toEqual([]);
    expect(await workPartyRedemptions()).toHaveLength(1);
    // What the card keeps is exactly the new price: the capture less the credit.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
    expect(after.amountCents - after.refundedAmountCents).toBe((await bookingRow()).finalPriceCents);
  }, 60_000);

  it("the dry run writes nothing, and an apply with other figures is refused and writes nothing", async () => {
    await seed("paid");
    const before = await snapshot();

    const figures = await quote();
    expect(figures.accountCreditAmountCents).toBe(DISCOUNT_CENTS);
    expect(await snapshot()).toEqual(before);

    const tampered = { ...figures, accountCreditAmountCents: figures.accountCreditAmountCents + 1 };
    const refused = await apply(tampered).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(correction.WorkPartyCorrectionFiguresChangedError);
    expect((refused as InstanceType<typeof correction.WorkPartyCorrectionFiguresChangedError>).actual).toEqual(figures);
    expect(await snapshot()).toEqual(before);

    const otherPrice = { ...figures, newFinalPriceCents: figures.newFinalPriceCents - 1 };
    await expect(apply(otherPrice)).rejects.toBeInstanceOf(correction.WorkPartyCorrectionFiguresChangedError);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("two concurrent applies with the same figures apply the discount once", async () => {
    await seed("paid");
    const figures = await quote();

    const outcomes = await Promise.allSettled([apply(figures), apply(figures)]);
    const applied = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(applied, JSON.stringify(outcomes)).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The loser waited on lock(1), re-read the booking and found the work party on it.
    expect(refused[0]!.reason).toMatchObject({ status: 409, message: "This booking already has a work party." });

    expect(await workPartyRedemptions()).toHaveLength(1);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    expect((await prisma.memberCredit.findMany({ where: { memberId: OWNER_ID } })).filter((row) => row.amountCents > 0)).toHaveLength(1);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });
    expect(await modificationXeroOps(1)).toHaveLength(1);
  }, 60_000);

  it("members still cannot use the internal code; nor an officer without the argument, nor with another work party's", async () => {
    await seed("unpaid");
    const before = await snapshot();

    // The owner, on their own booking.
    expect(await batchRefusal({ actor: { id: OWNER_ID, role: Role.USER } })).toBe("Promo code not found");
    // An officer through the ordinary edit.
    expect(await batchRefusal({ actor: { id: OFFICER_ID, role: Role.ADMIN } })).toBe("Promo code not found");
    // The argument names ANOTHER work party's promo: this one's code is still refused.
    expect(
      await batchRefusal({
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        officerWorkPartyCorrection: { workPartyEventId: "other", promoCodeId: OTHER_PROMO_ID },
        callerTransaction: true,
      }),
    ).toBe("Promo code not found");
    // The argument is refused outright on a member's actor or a self-committing
    // call, before anything is read: it lifts the fee and the tier.
    expect(
      await batchRefusal({
        actor: { id: OWNER_ID, role: Role.USER },
        officerWorkPartyCorrection: { workPartyEventId: EVENT_ID, promoCodeId: PROMO_ID },
        callerTransaction: true,
      }),
    ).toMatch(/needs an officer and a caller transaction/);
    expect(
      await batchRefusal({
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        officerWorkPartyCorrection: { workPartyEventId: EVENT_ID, promoCodeId: PROMO_ID },
      }),
    ).toMatch(/needs an officer and a caller transaction/);

    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("credit-paid: the discount goes back to the member's balance as applied credit given back", async () => {
    await seed("credit-paid");
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: DISCOUNT_CENTS,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    });
    const result = await apply(figures);
    // What was saved is exactly what was quoted.
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });

    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });
    expect(await workPartyRedemptions()).toHaveLength(1);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      amountCents: 0,
      creditAppliedCents: PRICE_CENTS - DISCOUNT_CENTS,
    });
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
    expect(await refundOperations()).toEqual([]);
  }, 60_000);

  it("refuses an organiser-paid joiner's booking, and writes nothing", async () => {
    await seed("organiser-paid");
    const before = await snapshot();

    expect(await correctionRefusal()).toEqual({
      status: 409,
      message: expect.stringContaining("paid by its group organiser"),
    });
    // The apply is refused the same way, before the figures are compared.
    const applied = await apply({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: DISCOUNT_CENTS,
      settlementMethod: "card",
    }).then(
      () => null,
      (error: { status: number; message: string }) => ({ status: error.status, message: error.message }),
    );
    expect(applied).toEqual({ status: 409, message: expect.stringContaining("paid by its group organiser") });

    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("refuses a stay that has already started, and writes nothing", async () => {
    // Check-in on the frozen today, with a work party covering both nights.
    await seed("paid", STARTED_STAY);
    const before = await snapshot();

    expect(await correctionRefusal(STARTED_EVENT_ID)).toEqual({
      status: 409,
      message: expect.stringContaining("already started"),
    });

    expect(await snapshot()).toEqual(before);
    expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  }, 60_000);

  it("records the work party and its money rule on the modification and its audit row", async () => {
    await seed("paid");
    const result = await apply(await quote());
    if (result.outcome !== "applied") throw new Error(`not applied: ${JSON.stringify(result)}`);

    const modification = await prisma.bookingModification.findUniqueOrThrow({
      where: { id: result.bookingModificationId! },
    });
    expect((modification.newData as Record<string, unknown>).officerWorkPartyCorrection).toEqual(WORK_PARTY_MARKER);

    const audit = await batchAuditRow(modification.id);
    expect(audit, "the batch edit's audit row").not.toBeNull();
    expect(audit).toMatchObject({ memberId: OFFICER_ID, subjectMemberId: OWNER_ID, outcome: "success" });
    expect(JSON.parse(audit!.details!).officerWorkPartyCorrection).toEqual(WORK_PARTY_MARKER);
    expect((audit!.metadata as Record<string, unknown>).officerWorkPartyCorrection).toEqual(WORK_PARTY_MARKER);
  }, 60_000);
});
