/**
 * Real-PostgreSQL proof for fork triyder/AlpineClubBookingsNZ#119: an officer adds an existing booking to a
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
 *  7. triyder/AlpineClubBookingsNZ#129. Paid by card with the officer's "Refund to card": the whole
 *     reduction, untiered, is the pipeline's own card refund (its after-commit
 *     Stripe leg, doubled to fail here, leaves a REFUND_BOOKING_MODIFICATION
 *     recovery row), with no credit. Paid by Internet Banking (upstream owner
 *     decision, 15 Nov 2026): "Refund to bank account" is the ordinary edit's
 *     own bank-transfer hand-back task; paid wholly with credit: a refund is
 *     not offered and is refused. An organiser-paid joiner: the reduction goes back to the
 *     organiser's card as the organiser-child refund debt. Owner decision 3
 *     (18 Nov 2026, maintainers' comment on #5149): the officer's own or a
 *     family member's booking, paid or not, and an organiser-paid joiner's
 *     booking whose owner or organiser is the officer or their family, are
 *     refused on Add and Remove with nothing written; an officer who is only a
 *     guest on another member's booking is not.
 *  8. #5149 (the maintainers' second comment): a disputed card payment is
 *     refused up front; a Remove after a 100% Add (PAID, nothing taken) is
 *     refused, and (owner decision, 20 Nov 2026) so is one on a booking PAID
 *     with account credit alone, whether a 50% Add brought it to the credit or
 *     credit paid it in full before any work party, while a joiner whose
 *     share the organiser paid is not caught; a card payment Stripe holds no record of is
 *     refunded by bank transfer (`INV-PAY-160`); Add, Remove, Add moves no money and offers no method when the
 *     unpaid ask takes the reduction; two Removes at once apply once; started
 *     stays of every payment shape, a held night sold above the season rate,
 *     a partly refunded booking, and Removes of every payment shape.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL the race harness provisions (#1881) and the `realdb-all`
 * job finds it by its name; it cleans its own `race-119-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { requireCalendarDate } from "@/lib/club-time";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double (pass-through unless hooked). The
// card-refund cases hook it to fail, so no provider is ever reached and the
// pipeline keeps the refund owed as its recovery row.
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

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
const MEMBER_PROMO_ID = "race-127-member-promo";
const MEMBER_PROMO_CODE = "RACE127MEMBER";
/** H1: the member code's 10% over the whole four-night stay, and over the two nights outside the window. */
const MEMBER_CODE_WHOLE_STAY_CENTS = 4 * 5_000 * 0.1;
const MEMBER_CODE_OUTSIDE_WINDOW_CENTS = 2 * 5_000 * 0.1;
const OTHER_BOOKING_ID = "race-127-other-booking";
const XERO_INVOICE_ID = "race-119-xero-invoice";
const ORGANISER_BOOKING_ID = "race-119-organiser-booking";
const STARTED_EVENT_ID = "race-119-started-event";
const STARTED_PROMO_ID = "race-119-started-promo";
const STARTED_PROMO_CODE = "RACE119STARTEDBEE";
/** #5149: a 100% work party over every night of the August stay. */
const FULL_EVENT_ID = "race-5149-full-event";
const FULL_PROMO_ID = "race-5149-full-promo";
const FULL_PROMO_CODE = "RACE5149FULLBEE";
/** #5149 owner decision of 20 Nov 2026: a 50% work party over every night of the August stay. */
const HALF_EVENT_ID = "race-5149-half-event";
const HALF_PROMO_ID = "race-5149-half-promo";
const HALF_PROMO_CODE = "RACE5149HALFBEE";
/** The decision's example: $100 of the member's credit on the $200 booking. */
const DECISION_CREDIT_CENTS = 10_000;
const ALL_PROMO_IDS = [PROMO_ID, OTHER_PROMO_ID, PUBLIC_PROMO_ID, STARTED_PROMO_ID, MEMBER_PROMO_ID, FULL_PROMO_ID, HALF_PROMO_ID];
const GROUP_ID = "race-129-group";
const SETTLEMENT_ID = "race-129-settlement";
const SETTLEMENT_PI = "pi_race_129_group";
/** #5149 review F4: the organiser's combined invoice an Internet Banking group settlement raised. */
const COMBINED_INVOICE_ID = "race-5149-combined-invoice";
const FAMILY_ID = "race-129-family";
/** #5149: a third member, owning a joiner's booking whose organiser is someone else. */
const JOINER_ID = "race-5149-joiner";
/** #5149: part-paid with account credit, the rest by card. */
const CARD_AND_CREDIT_CREDIT_CENTS = 10_000;

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
/** Unpaid with credit applied: more than the new total, so the reprice frees some (F20, #1887). */
const UNPAID_CREDIT_APPLIED_CENTS = 18_000;
const FREED_CREDIT_CENTS = UNPAID_CREDIT_APPLIED_CENTS - (PRICE_CENTS - DISCOUNT_CENTS);
/**
 * fork triyder/AlpineClubBookingsNZ#127: a stay that began two nights before the frozen today (1 July 2026). Its
 * work party covers one night already slept and tonight; the first and last
 * nights are outside it.
 */
const STARTED_STAY = {
  nights: ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"].map((day) => new Date(`${day}T00:00:00.000Z`)),
  checkOut: new Date("2026-07-03T00:00:00.000Z"),
};
const STARTED_WINDOW = { start: new Date("2026-06-30T00:00:00.000Z"), end: new Date("2026-07-01T00:00:00.000Z") };
/** The marker the modification and its audit carry (`OFFICER_WORK_PARTY_MONEY_RULE`). */
const WORK_PARTY_MARKER = {
  workPartyEventId: EVENT_ID,
  promoCodeId: PROMO_ID,
  direction: "add",
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
  const localIds = [BOOKING_ID, PAYMENT_ID, SETTLEMENT_ID, ORGANISER_BOOKING_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({
    where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: { in: [XERO_INVOICE_ID, COMBINED_INVOICE_ID] } }] },
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
  await prisma.stripeDispute.deleteMany({ where: { bookingId: BOOKING_ID } });
  // M3b: the journal's batches name the booking's ledger lines (RESTRICT), so release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: OWNER_ID } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: { in: [OWNER_ID, OFFICER_ID, JOINER_ID] } } });
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
  await prisma.groupBookingSettlement.deleteMany({ where: { id: SETTLEMENT_ID } });
  await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
  await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
  await prisma.familyGroupMember.deleteMany({ where: { familyGroupId: FAMILY_ID } });
  await prisma.familyGroup.deleteMany({ where: { id: FAMILY_ID } });
  if (enqueueErrors.length > 0) {
    throw new AggregateError(enqueueErrors, "fork triyder/AlpineClubBookingsNZ#119: real Xero fixture enqueues failed; owned fixtures cleaned");
  }
}

async function teardownFixtures(): Promise<void> {
  await prisma.workPartyEvent.deleteMany({ where: { id: { in: [EVENT_ID, OTHER_EVENT_ID, STARTED_EVENT_ID, FULL_EVENT_ID, HALF_EVENT_ID] } } });
  await prisma.promoCode.deleteMany({ where: { id: { in: ALL_PROMO_IDS } } });
  await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
  await prisma.season.deleteMany({ where: { id: SEASON_ID } });
  await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
  await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
  await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID, JOINER_ID] } } });
}

type Shape =
  | "unpaid"
  | "unpaid-credit"
  | "unpaid-half-credit"
  | "paid"
  | "part-paid"
  | "credit-paid"
  | "organiser-paid"
  | "organiser-paid-bank"
  | "bank-and-credit"
  | "bank-paid"
  | "card-and-credit"
  | "organiser-unpaid"
  | "organiser-settling";
const ORGANISER_PAYS_SHAPES: readonly Shape[] = ["organiser-paid", "organiser-paid-bank", "organiser-unpaid", "organiser-settling"];

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
 *    (`paidByOrganiserCard`: organiser-settled, a parent, a STRIPE mirror),
 *    with the group's combined card settlement the refund comes back from;
 *  - bank-paid: PAID by Internet Banking, the whole price received;
 *  - card-and-credit (#5149): PAID, `CARD_AND_CREDIT_CREDIT_CENTS` with account
 *    credit and the rest captured by card;
 *  - organiser-paid-bank (#5149 review F4): as organiser-paid, but the group
 *    settled by Internet Banking on the organiser's combined invoice, so an
 *    increase is invoiced to the organiser (`INV-PAY-148`);
 *  - bank-and-credit (#5149 review F3): PAID, `CARD_AND_CREDIT_CREDIT_CENTS`
 *    with account credit and the rest received by Internet Banking;
 *  - unpaid-half-credit (#5149 owner decision, 20 Nov 2026): as unpaid-credit,
 *    with `DECISION_CREDIT_CENTS` applied, half the price;
 *  - organiser-unpaid / organiser-settling (#5149 review A1): a joiner of an
 *    organiser-pays group before its settlement has succeeded — PAYMENT_PENDING
 *    with no settlement, or CONFIRMED with the settlement still PENDING — and
 *    no payment mirror yet.
 * `stay` defaults to the four August nights; `ownerId` to the owner;
 * `nightCents` to the season rate (#5149: a held night sold above it).
 */
async function seed(
  shape: Shape,
  stay: { nights: Date[]; checkOut: Date } = { nights: NIGHTS, checkOut: CHECK_OUT },
  ownerId: string = OWNER_ID,
  /** organiser-paid only: who organised the group (owns the organiser booking). */
  organiserId: string = OWNER_ID,
  nightCents: number = NIGHT_CENTS,
): Promise<void> {
  const checkIn = stay.nights[0]!;
  const price = stay.nights.length * nightCents;
  if (ORGANISER_PAYS_SHAPES.includes(shape)) {
    await prisma.booking.create({
      data: {
        id: ORGANISER_BOOKING_ID,
        memberId: organiserId,
        lodgeId: LODGE_ID,
        checkIn,
        checkOut: stay.checkOut,
        status: "PAID",
        totalPriceCents: 0,
        finalPriceCents: 0,
      },
    });
    await prisma.groupBooking.create({
      data: { id: GROUP_ID, organiserBookingId: ORGANISER_BOOKING_ID, organiserMemberId: organiserId, joinCode: GROUP_ID, paymentMode: "ORGANISER_PAYS" },
    });
    if (shape !== "organiser-unpaid") {
      await prisma.groupBookingSettlement.create({
        data: {
          id: SETTLEMENT_ID,
          groupBookingId: GROUP_ID,
          ...(shape === "organiser-paid-bank"
            ? { xeroInvoiceId: COMBINED_INVOICE_ID }
            : { stripePaymentIntentId: SETTLEMENT_PI }),
          source: shape === "organiser-paid-bank" ? "INTERNET_BANKING" : "STRIPE",
          amountCents: price,
          status: shape === "organiser-settling" ? "PENDING" : "SUCCEEDED",
        },
      });
    }
  }
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: ownerId,
      lodgeId: LODGE_ID,
      checkIn,
      checkOut: stay.checkOut,
      status:
        shape === "unpaid" || shape === "unpaid-credit" || shape === "unpaid-half-credit" || shape === "organiser-unpaid"
          ? "PAYMENT_PENDING"
          : shape === "organiser-settling"
            ? "CONFIRMED"
            : "PAID",
      totalPriceCents: price,
      finalPriceCents: price,
      ...(ORGANISER_PAYS_SHAPES.includes(shape) ? { parentBookingId: ORGANISER_BOOKING_ID, organiserSettled: true } : {}),
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
      // The owner member stays the guest; `ownerId` changes only who owns the booking.
      memberId: OWNER_ID,
      stayStart: checkIn,
      stayEnd: stay.checkOut,
      priceCents: price,
      nights: {
        create: stay.nights.map((stayDate) => ({ stayDate, priceCents: nightCents, priceSource: "SOLD" as const })),
      },
    },
  });

  // Before the group settlement succeeds a joiner has no payment mirror.
  if (shape === "organiser-unpaid" || shape === "organiser-settling") return;

  if (shape === "unpaid-credit" || shape === "unpaid-half-credit") {
    // PAYMENT_PENDING with the owner's account credit applied and the rest
    // still to pay by card: the opening credit, then its BOOKING_APPLIED row.
    const creditCents = shape === "unpaid-half-credit" ? DECISION_CREDIT_CENTS : UNPAID_CREDIT_APPLIED_CENTS;
    const cardCents = price - creditCents;
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: cardCents,
        creditAppliedCents: creditCents,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_race_129_open",
        transactions: {
          create: {
            id: PRIMARY_TXN_ID,
            kind: "PRIMARY",
            source: "STRIPE",
            amountCents: cardCents,
            status: "PENDING",
            stripePaymentIntentId: "pi_race_129_open",
          },
        },
      },
    });
    await prisma.memberCredit.create({
      data: { memberId: ownerId, amountCents: creditCents, type: "ADMIN_ADJUSTMENT", description: "race 129 opening balance" },
    });
    await prisma.$transaction((tx) =>
      memberCredit.applyCreditToBooking(ownerId, creditCents, BOOKING_ID, tx, CLUB_FORMAT_TEST),
    );
    return;
  }

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
  } else if (shape === "bank-paid") {
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: price,
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        // The received transfer, as the bank-payment settle records it.
        transactions: {
          create: { id: PRIMARY_TXN_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: price, status: "SUCCEEDED" },
        },
      },
    });
  } else if (shape === "card-and-credit") {
    await seedCardPayment("paid", price - CARD_AND_CREDIT_CREDIT_CENTS);
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: CARD_AND_CREDIT_CREDIT_CENTS } });
    await prisma.memberCredit.create({
      data: { memberId: OWNER_ID, amountCents: CARD_AND_CREDIT_CREDIT_CENTS, type: "ADMIN_ADJUSTMENT", description: "race 5149 opening balance" },
    });
    await prisma.$transaction((tx) =>
      memberCredit.applyCreditToBooking(OWNER_ID, CARD_AND_CREDIT_CREDIT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST),
    );
  } else if (shape === "bank-and-credit") {
    const receivedCents = price - CARD_AND_CREDIT_CREDIT_CENTS;
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: receivedCents,
        creditAppliedCents: CARD_AND_CREDIT_CREDIT_CENTS,
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        transactions: {
          create: { id: PRIMARY_TXN_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: receivedCents, status: "SUCCEEDED" },
        },
      },
    });
    await prisma.memberCredit.create({
      data: { memberId: OWNER_ID, amountCents: CARD_AND_CREDIT_CREDIT_CENTS, type: "ADMIN_ADJUSTMENT", description: "race 5149 opening balance" },
    });
    await prisma.$transaction((tx) =>
      memberCredit.applyCreditToBooking(OWNER_ID, CARD_AND_CREDIT_CREDIT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST),
    );
  } else if (shape === "organiser-paid" || shape === "organiser-paid-bank") {
    // The child's mirror of the organiser's settlement, its share as group
    // settlement writes it (`amountCents: childPaidCents`): no intent of its own.
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: price,
        source: shape === "organiser-paid-bank" ? "INTERNET_BANKING" : "STRIPE",
        status: "SUCCEEDED",
      },
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

type Method = { settlementMethod?: "credit" | "card" };

async function quoted(method: Method = {}, workPartyEventId = EVENT_ID) {
  const result = await correction.addBookingToWorkParty({ ...(await common(workPartyEventId)), ...method, dryRun: true });
  expect(result.outcome).toBe("quoted");
  return result;
}

async function quote(method: Method = {}, workPartyEventId = EVENT_ID): Promise<Figures> {
  return (await quoted(method, workPartyEventId)).figures;
}

async function apply(expectedFigures: Figures, method: Method = {}, workPartyEventId = EVENT_ID) {
  return correction.addBookingToWorkParty({
    ...(await common(workPartyEventId)),
    ...method,
    dryRun: false,
    expectedFigures,
  });
}

/** fork triyder/AlpineClubBookingsNZ#130: the removal's dry run. */
async function removalQuote(workPartyEventId = EVENT_ID): Promise<Figures> {
  const result = await correction.removeBookingFromWorkParty({ ...(await common(workPartyEventId)), dryRun: true });
  expect(result.outcome).toBe("quoted");
  return result.figures;
}

async function removalApply(expectedFigures: Figures, workPartyEventId = EVENT_ID) {
  return correction.removeBookingFromWorkParty({ ...(await common(workPartyEventId)), dryRun: false, expectedFigures });
}

async function removalRefusal(workPartyEventId = EVENT_ID): Promise<{ status: number; message: string } | null> {
  return correction.removeBookingFromWorkParty({ ...(await common(workPartyEventId)), dryRun: true }).then(
    () => null,
    (error: { status: number; message: string }) => ({ status: error.status, message: error.message }),
  );
}

/** The removal facts the list and the service read (`readWorkPartyBookingFacts`), fresh. */
async function removalFacts() {
  const facts = await import("@/lib/work-party-booking-facts");
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: facts.WORK_PARTY_BOOKING_SELECT });
    return (await facts.readWorkPartyBookingFacts(tx, BOOKING_ID, booking, OFFICER_ID)).remove;
  });
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
async function correctionRefusal(
  workPartyEventId = EVENT_ID,
  method: Method = {},
): Promise<{ status: number; message: string } | null> {
  return correction.addBookingToWorkParty({ ...(await common(workPartyEventId)), ...method, dryRun: true }).then(
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
  officerWorkPartyCorrection?: { workPartyEventId: string; promoCodeId: string; direction: "add" | "remove" };
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

(RUN ? describe : describe.skip)("adding a booking to a work party, on PostgreSQL (fork triyder/AlpineClubBookingsNZ#119)", () => {
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
      // A club member holding the booking-officer access role (below), as a
      // real officer is, so their own booking is an ordinary bookable one.
      [OFFICER_ID, "Officer", Role.USER],
      [JOINER_ID, "Joiner", Role.USER],
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
          startDate: eventId === STARTED_EVENT_ID ? STARTED_WINDOW.start : WINDOW_START,
          endDate: eventId === STARTED_EVENT_ID ? STARTED_WINDOW.end : WINDOW_END,
          discountPercent: DISCOUNT_PERCENT,
          active: true,
          lodgeId: LODGE_ID,
          promoCodeId: promoId,
        },
      });
    }
    // #5149: a 100% work party over all four August nights, so an Add can bring
    // an unpaid booking to nothing.
    await prisma.promoCode.create({
      data: {
        id: FULL_PROMO_ID,
        code: FULL_PROMO_CODE,
        internal: true,
        description: "Working bee: Race 5149 full working bee",
        type: "PERCENTAGE",
        percentOff: 100,
        membersOnly: true,
        active: true,
      },
    });
    await prisma.workPartyEvent.create({
      data: {
        id: FULL_EVENT_ID,
        name: "Race 5149 full working bee",
        startDate: NIGHTS[0]!,
        endDate: NIGHTS[NIGHTS.length - 1]!,
        discountPercent: 100,
        active: true,
        lodgeId: LODGE_ID,
        promoCodeId: FULL_PROMO_ID,
      },
    });
    // #5149 owner decision of 20 Nov 2026: a 50% work party over all four August nights.
    await prisma.promoCode.create({
      data: {
        id: HALF_PROMO_ID,
        code: HALF_PROMO_CODE,
        internal: true,
        description: "Working bee: Race 5149 half working bee",
        type: "PERCENTAGE",
        percentOff: 50,
        membersOnly: true,
        active: true,
      },
    });
    await prisma.workPartyEvent.create({
      data: {
        id: HALF_EVENT_ID,
        name: "Race 5149 half working bee",
        startDate: NIGHTS[0]!,
        endDate: NIGHTS[NIGHTS.length - 1]!,
        discountPercent: 50,
        active: true,
        lodgeId: LODGE_ID,
        promoCodeId: HALF_PROMO_ID,
      },
    });
    // H1: a member's own code (its validity window is set per test).
    await prisma.promoCode.create({
      data: { id: MEMBER_PROMO_ID, code: MEMBER_PROMO_CODE, type: "PERCENTAGE", percentOff: 10, active: true },
    });
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

  it("unpaid: lowers the price and the amount owed by the discount on the in-window nights only, writing no credit", async () => {
    await seed("unpaid");
    const owedBefore = await amountOwed.readBookingAmountOwed(await bookingRow());
    expect(owedBefore.owedCents).toBe(PRICE_CENTS);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      changeFeeCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
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
      changeFeeCents: 0,
      // The whole reduction: the 50% tier the stay sits in does not touch it.
      accountCreditAmountCents: DISCOUNT_CENTS,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
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
      changeFeeCents: 0,
      accountCreditAmountCents: DISCOUNT_CENTS - ASK_CENTS,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
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
        officerWorkPartyCorrection: { workPartyEventId: "other", promoCodeId: OTHER_PROMO_ID, direction: "add" },
        callerTransaction: true,
      }),
    ).toBe("Promo code not found");
    // The argument is refused outright on a member's actor or a self-committing
    // call, before anything is read: it lifts the fee and the tier.
    expect(
      await batchRefusal({
        actor: { id: OWNER_ID, role: Role.USER },
        officerWorkPartyCorrection: { workPartyEventId: EVENT_ID, promoCodeId: PROMO_ID, direction: "add" },
        callerTransaction: true,
      }),
    ).toMatch(/needs an officer and a caller transaction/);
    expect(
      await batchRefusal({
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        officerWorkPartyCorrection: { workPartyEventId: EVENT_ID, promoCodeId: PROMO_ID, direction: "add" },
      }),
    ).toMatch(/needs an officer and a caller transaction/);

    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("credit-paid: the discount goes back to the member's balance as applied credit given back", async () => {
    await seed("credit-paid");
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
    // No money was paid, so the ordinary edit offers no refund, and neither does this.
    const before = await snapshot();
    expect((await quoted()).settlementOptions).toEqual({ methods: ["credit"], paidByOrganiser: false, refundTo: null });
    expect(await correctionRefusal(EVENT_ID, { settlementMethod: "card" })).toEqual({
      status: 409,
      message: (await import("@/lib/work-party-settlement-options")).WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
    });
    expect(await snapshot()).toEqual(before);

    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      changeFeeCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: DISCOUNT_CENTS,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
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

  /** Stripe is never reached: every refund attempt fails, as a provider outage would. */
  function stripeRefundsFail(): void {
    stripeRaceHooks.refund = async () => {
      throw new Error("race 129: Stripe is not called in this proof");
    };
    stripeRaceHooks.listRefunds = async () => {
      throw new Error("race 129: Stripe is not called in this proof");
    };
  }

  /** The recovery rows the refund leg wrote, polled: the own-card one is written after commit. */
  async function recoveryRows(kind: "own-card" | "organiser", expected: number) {
    const started = process.hrtime.bigint();
    for (;;) {
      const rows = await prisma.paymentRecoveryOperation.findMany({
        where:
          kind === "own-card"
            ? { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" }
            : { paymentIntentId: SETTLEMENT_PI },
        select: { type: true, amountCents: true, paymentId: true, paymentIntentId: true, idempotencyKey: true, status: true },
      });
      if (rows.length >= expected || realElapsedMs(started) > 5_000) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The figures an unrelated officer would have been shown on the paid booking. */
  const paidCreditFigures = (): Figures => ({
    previousFinalPriceCents: PRICE_CENTS,
    newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
    priceDiffCents: -DISCOUNT_CENTS,
    changeFeeCents: 0,
    accountCreditAmountCents: DISCOUNT_CENTS,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    billedToOrganiserCents: 0,
    refundAmountCents: 0,
    settlementMethod: "credit",
  });

  it("triyder/AlpineClubBookingsNZ#129 card-paid, Refund to card: the whole reduction is the pipeline's own card refund, untiered, with no credit", async () => {
    await seed("paid");
    stripeRefundsFail();

    const offered = await quoted();
    // Credit is still the default; the card is offered beside it.
    expect(offered.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "card" });
    expect(offered.figures).toEqual(paidCreditFigures());

    const figures = await quote({ settlementMethod: "card" });
    expect(figures).toEqual({
      ...paidCreditFigures(),
      accountCreditAmountCents: 0,
      // The whole reduction: the 50% tier the stay sits in does not touch it.
      refundAmountCents: DISCOUNT_CENTS,
      settlementMethod: "card",
    });
    // The credit figures do not save a card refund (they differ in the money
    // keys too; the method-only case is in work-party-booking-correction-guards.test.ts).
    await expect(apply(offered.figures, { settlementMethod: "card" })).rejects.toBeInstanceOf(
      correction.WorkPartyCorrectionFiguresChangedError,
    );
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);

    const result = await apply(figures, { settlementMethod: "card" });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    if (result.outcome !== "applied") throw new Error("not applied");

    const modification = await prisma.bookingModification.findUniqueOrThrow({
      where: { id: result.bookingModificationId! },
    });
    expect(modification).toMatchObject({ changeFeeCents: 0, priceDiffCents: -DISCOUNT_CENTS });
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });
    expect(await workPartyRedemptions()).toHaveLength(1);

    // No credit at all: none minted, none on the balance.
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
    // The refund is the pipeline's: its after-commit Stripe leg failed here, so
    // it is kept owed as the edit's own recovery row, for the whole reduction.
    const rows = await recoveryRows("own-card", 1);
    expect(rows).toEqual([
      expect.objectContaining({ type: "REFUND_BOOKING_MODIFICATION", amountCents: DISCOUNT_CENTS, paymentId: PAYMENT_ID }),
    ]);
    // No hand-back: the card is the route.
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    // The edit's ledger lines, under its own anchor.
    expect(
      await prisma.bookingLedgerLine.count({
        where: { bookingId: BOOKING_ID, anchorKind: "MODIFICATION", anchorId: modification.id },
      }),
    ).toBeGreaterThan(0);
  }, 60_000);

  it("triyder/AlpineClubBookingsNZ#129 card-paid, Club credit chosen: as the default, the whole reduction as credit and no refund", async () => {
    await seed("paid");
    stripeRefundsFail();
    const figures = await quote({ settlementMethod: "credit" });
    expect(figures).toEqual(paidCreditFigures());
    const result = await apply(figures, { settlementMethod: "credit" });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await refundOperations()).toEqual([]);
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
  }, 60_000);

  it("triyder/AlpineClubBookingsNZ#129 paid by Internet Banking, Refund to bank account: the ordinary edit's bank-transfer hand-back, in full, with no credit", async () => {
    // Upstream owner decision (15 Nov 2026): the officer chooses a refund (card
    // or bank, as on an ordinary edit) or account credit. The ordinary edit's
    // "card" method on a bank-paid booking is a refund the treasurer sends back
    // by bank transfer: one hand-back task, never a Stripe call.
    await seed("bank-paid");
    stripeRefundsFail();

    const offered = await quoted();
    expect(offered.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "bank" });
    // Credit is still the default.
    expect(offered.figures).toEqual(paidCreditFigures());

    const figures = await quote({ settlementMethod: "card" });
    expect(figures).toEqual({
      ...paidCreditFigures(),
      accountCreditAmountCents: 0,
      // The whole reduction: the 50% tier the stay sits in does not touch it.
      refundAmountCents: DISCOUNT_CENTS,
      settlementMethod: "card",
    });
    const result = await apply(figures, { settlementMethod: "card" });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    if (result.outcome !== "applied") throw new Error("not applied");
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });

    // The edit's own hand-back (`raiseEditRefundHandBackIfOwed`): one task for the whole reduction.
    expect(
      await prisma.manualRefundTask.findMany({
        where: { bookingId: BOOKING_ID },
        select: { paymentId: true, amountCents: true, kind: true },
      }),
    ).toEqual([{ paymentId: PAYMENT_ID, amountCents: DISCOUNT_CENTS, kind: "CANCELLED_BOOKING_HAND_BACK" }]);
    // No card refund, and no credit.
    expect(await refundOperations()).toEqual([]);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
  }, 60_000);

  it("triyder/AlpineClubBookingsNZ#129 paid by Internet Banking, Club credit: as the default, the whole reduction as credit, no hand-back", async () => {
    await seed("bank-paid");
    const figures = await quote({ settlementMethod: "credit" });
    expect(figures).toEqual(paidCreditFigures());
    const result = await apply(figures, { settlementMethod: "credit" });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await refundOperations()).toEqual([]);
  }, 60_000);

  it("triyder/AlpineClubBookingsNZ#129 organiser-paid joiner: allowed, and the reduction goes back to the organiser's card", async () => {
    await seed("organiser-paid");
    stripeRefundsFail();

    const offered = await quoted();
    expect(offered.settlementOptions).toEqual({ methods: ["card"], paidByOrganiser: true, refundTo: null });
    const figures = offered.figures;
    expect(figures).toEqual({
      ...paidCreditFigures(),
      accountCreditAmountCents: 0,
      refundAmountCents: DISCOUNT_CENTS,
      settlementMethod: "card",
    });
    // The joiner's credit is not an option for the organiser's money.
    expect(await correctionRefusal(EVENT_ID, { settlementMethod: "credit" })).toEqual({
      status: 409,
      message: expect.stringContaining("group organiser"),
    });

    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    if (result.outcome !== "applied") throw new Error("not applied");
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });

    // The organiser disposition: the organiser-child refund debt against the
    // group's combined card payment, written by the edit; never the joiner's credit.
    const rows = await recoveryRows("organiser", 1);
    expect(rows).toEqual([
      expect.objectContaining({ amountCents: DISCOUNT_CENTS, paymentIntentId: SETTLEMENT_PI }),
    ]);
    expect(rows[0]!.idempotencyKey).toBe(`organiser_child_refund_mod_${result.bookingModificationId!}`);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
    // And it is the booking's only refund row: no refund of a card of the joiner's own.
    expect(await recoveryRows("own-card", 1)).toEqual(rows);
  }, 60_000);

  /** The service's refusal of an apply, or null if it applied. */
  async function applyRefusal(run: Promise<unknown>): Promise<{ status: number; message: string } | null> {
    return run.then(
      () => null,
      (error: { status: number; message: string }) => ({ status: error.status, message: error.message }),
    );
  }

  const ownBooking = () => ({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });

  it("owner decision 3: the officer's own UNPAID booking is refused, though nothing would come back, with nothing written", async () => {
    await seed("unpaid", undefined, OFFICER_ID);
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual(ownBooking());
    // The figures an officer would have been shown: the price just drops.
    const shown: Figures = {
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      changeFeeCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    };
    expect(await applyRefusal(apply(shown))).toEqual(ownBooking());
    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("F1: an unpaid booking's applied credit freed by the lower price is a figure, and moves the balance by exactly it", async () => {
    await seed("unpaid-credit");
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
    const figures = await quote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      priceDiffCents: -DISCOUNT_CENTS,
      changeFeeCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: FREED_CREDIT_CENTS,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    });
    // A save shown without it is refused, and writes nothing.
    const before = await snapshot();
    await expect(apply({ ...figures, refundedExcessCreditCents: 0 })).rejects.toBeInstanceOf(
      correction.WorkPartyCorrectionFiguresChangedError,
    );
    expect(await snapshot()).toEqual(before);

    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(FREED_CREDIT_CENTS);
    expect(await refundOperations()).toEqual([]);
  }, 60_000);

  it("owner decision 3: the officer's own unpaid booking with applied credit is refused, with nothing written", async () => {
    await seed("unpaid-credit", undefined, OFFICER_ID);
    const before = await snapshot();
    const officerBalance = await memberCredit.getMemberCreditBalance(OFFICER_ID);
    expect(await correctionRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await memberCredit.getMemberCreditBalance(OFFICER_ID)).toBe(officerBalance);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("owner decision 3: the officer's own card-paid booking is refused, by either method, with nothing written", async () => {
    await seed("paid", undefined, OFFICER_ID);
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });
    expect(await correctionRefusal(EVENT_ID, { settlementMethod: "card" })).toEqual({
      status: 409,
      message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE,
    });
    expect(await snapshot()).toEqual(before);
    expect(await prisma.memberCredit.count({ where: { memberId: OFFICER_ID } })).toBe(0);
  }, 60_000);

  it("owner decision 3: a paid booking owned by a member of the officer's family group is refused, preview and apply", async () => {
    await seed("paid");
    await prisma.familyGroup.create({
      data: {
        id: FAMILY_ID,
        memberships: { create: [{ memberId: OWNER_ID }, { memberId: OFFICER_ID }] },
      },
    });
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });
    const applied = await apply(paidCreditFigures()).then(
      () => null,
      (error: { status: number; message: string }) => ({ status: error.status, message: error.message }),
    );
    expect(applied).toEqual({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toEqual([]);
  }, 60_000);

  it("owner decision 3: a joiner's booking whose group organiser (who paid) is the officer is refused", async () => {
    await seed("organiser-paid", undefined, OWNER_ID, OFFICER_ID);
    stripeRefundsFail();
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await recoveryRows("organiser", 0)).toEqual([]);
  }, 60_000);

  it("owner decision 3: the officer as an organiser-paid joiner is refused, though the money would go to the organiser", async () => {
    await seed("organiser-paid", undefined, OFFICER_ID, OWNER_ID);
    stripeRefundsFail();
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual(ownBooking());
    expect(await snapshot()).toEqual(before);
    expect(await recoveryRows("organiser", 0)).toEqual([]);
  }, 60_000);

  it("owner decision 3: a joiner's booking whose paying organiser is in the officer's family is refused", async () => {
    await seed("organiser-paid", undefined, JOINER_ID, OWNER_ID);
    await prisma.familyGroup.create({
      data: { id: FAMILY_ID, memberships: { create: [{ memberId: OWNER_ID }, { memberId: OFFICER_ID }] } },
    });
    stripeRefundsFail();
    const before = await snapshot();
    expect(await correctionRefusal()).toEqual(ownBooking());
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("owner decision 3: an officer who is only a guest on another member's booking may add it", async () => {
    await seed("paid");
    await prisma.bookingGuest.update({ where: { id: GUEST_ID }, data: { memberId: OFFICER_ID } });
    const figures = await quote();
    expect(figures).toEqual(paidCreditFigures());
    const result = await apply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    // The money is the owner's, not the guest officer's.
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await prisma.memberCredit.count({ where: { memberId: OFFICER_ID } })).toBe(0);
  }, 60_000);

  /** An OPEN Stripe dispute on the booking's own card capture (#5151, `INV-PAY-154`). */
  async function seedOpenDispute(): Promise<void> {
    await prisma.stripeDispute.create({
      data: {
        stripeDisputeId: "dp_race_5149",
        stripeChargeId: "ch_race_5149",
        stripePaymentIntentId: "pi_race_119_primary",
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: PRICE_CENTS,
        currency: "nzd",
        reason: "fraudulent",
        status: "OPEN",
        stripeStatus: "needs_response",
        stripeCreatedAt: new Date("2026-06-25T00:00:00.000Z"),
        lastEventCreatedAt: new Date("2026-06-25T00:00:00.000Z"),
        stripeEventId: "evt_race_5149",
      },
    });
  }

  it("#5149: a disputed card payment is refused with the plain reason where the edit would hold the money, future or started", async () => {
    for (const [stay, eventId] of [[undefined, EVENT_ID], [STARTED_STAY, STARTED_EVENT_ID]] as const) {
      await clean();
      await seed("paid", stay);
      await seedOpenDispute();
      const before = await snapshot();
      for (const method of [{}, { settlementMethod: "card" as const }]) {
        expect(await correctionRefusal(eventId, method)).toEqual({
          status: 409,
          message: correction.WORK_PARTY_DISPUTED_PAYMENT_MESSAGE,
        });
      }
      expect(await snapshot()).toEqual(before);
      expect(await workPartyRedemptions()).toEqual([]);
    }
  }, 90_000);

  it("#5149 review A2: a disputed booking whose discount only cancels an unpaid ask holds nothing, so it goes ahead", async () => {
    await seed("paid");
    stripeAsksFail();
    await apply(await quote());
    await removalApply(await removalQuote());
    await seedOpenDispute();
    const again = await quoted();
    expect(again.figures).toMatchObject({ accountCreditAmountCents: 0, refundAmountCents: 0, settlementMethod: null });
    const result = await apply(again.figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  }, 120_000);

  it("#5149: a partly refunded booking gets back only the cash still on its payment, by either method", async () => {
    await seed("paid");
    // $180 of the $200 capture already refunded, on the mirror and its ledger row.
    const refunded = PRICE_CENTS - 2_000;
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: refunded, status: "PARTIALLY_REFUNDED" } });
    await prisma.paymentTransaction.update({
      where: { id: PRIMARY_TXN_ID },
      data: { refundedAmountCents: refunded, status: "PARTIALLY_REFUNDED" },
    });
    stripeRefundsFail();
    const byCredit = await quote();
    expect(byCredit).toMatchObject({ priceDiffCents: -DISCOUNT_CENTS, accountCreditAmountCents: 2_000, refundAmountCents: 0 });
    const byCard = await quote({ settlementMethod: "card" });
    expect(byCard).toMatchObject({ priceDiffCents: -DISCOUNT_CENTS, accountCreditAmountCents: 0, refundAmountCents: 2_000 });
    const result = await apply(byCredit);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(2_000);

    // The same booking again, settled by card: the refund is the cash left, no more.
    await clean();
    await seed("paid");
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: refunded, status: "PARTIALLY_REFUNDED" } });
    await prisma.paymentTransaction.update({
      where: { id: PRIMARY_TXN_ID },
      data: { refundedAmountCents: refunded, status: "PARTIALLY_REFUNDED" },
    });
    stripeRefundsFail();
    const byCardAgain = await quote({ settlementMethod: "card" });
    expect(byCardAgain).toEqual(byCard);
    const byCardResult = await apply(byCardAgain, { settlementMethod: "card" });
    expect(byCardResult, JSON.stringify(byCardResult)).toMatchObject({ outcome: "applied" });
    expect(await recoveryRows("own-card", 1)).toEqual([
      expect.objectContaining({ type: "REFUND_BOOKING_MODIFICATION", amountCents: 2_000, paymentId: PAYMENT_ID }),
    ]);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
  }, 90_000);

  /** The nights the work party's promo adjusted, as dates. */
  async function discountedNights(promoCodeId: string): Promise<string[]> {
    const rows = await prisma.bookingGuestNightAdjustment.findMany({
      where: { bookingId: BOOKING_ID, promoCodeId, bookingGuestNightId: { not: null } },
      select: { bookingGuestNight: { select: { stayDate: true } } },
    });
    return rows.map((row) => row.bookingGuestNight!.stayDate.toISOString().slice(0, 10)).sort();
  }

  /** The stored night prices and guest total: a correction never re-rates a night. */
  async function storedNights() {
    return prisma.bookingGuest.findUniqueOrThrow({
      where: { id: GUEST_ID },
      select: { priceCents: true, nights: { select: { priceCents: true }, orderBy: { stayDate: "asc" } } },
    });
  }

  const STORED_NIGHTS = { priceCents: PRICE_CENTS, nights: STARTED_STAY.nights.map(() => ({ priceCents: NIGHT_CENTS })) };

  it("fork triyder/AlpineClubBookingsNZ#127 started stay, card-paid, Refund to card: every in-window night, slept or not, is discounted; refund untiered", async () => {
    await seed("paid", STARTED_STAY);
    stripeRefundsFail();

    const offered = await quoted({}, STARTED_EVENT_ID);
    expect(offered.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "card" });
    const figures = await quote({ settlementMethod: "card" }, STARTED_EVENT_ID);
    expect(figures).toEqual({
      ...paidCreditFigures(),
      accountCreditAmountCents: 0,
      // In full: the stay is past every tier, and the tier does not apply.
      refundAmountCents: DISCOUNT_CENTS,
      settlementMethod: "card",
    });
    const result = await apply(figures, { settlementMethod: "card" }, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });

    // 30 June (slept) and 1 July (tonight); not 29 June or 2 July, outside the window.
    expect(await discountedNights(STARTED_PROMO_ID)).toEqual(["2026-06-30", "2026-07-01"]);
    expect(await storedNights()).toEqual(STORED_NIGHTS);
    expect(await bookingRow()).toMatchObject({
      finalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      promoAdjustmentCents: -DISCOUNT_CENTS,
    });
    expect(await recoveryRows("own-card", 1)).toEqual([
      expect.objectContaining({ type: "REFUND_BOOKING_MODIFICATION", amountCents: DISCOUNT_CENTS, paymentId: PAYMENT_ID }),
    ]);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
    expect(await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING_ID } })).toMatchObject({
      changeFeeCents: 0,
      priceDiffCents: -DISCOUNT_CENTS,
    });
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#127 started stay, Club credit: the whole in-window discount as credit, no refund", async () => {
    await seed("paid", STARTED_STAY);
    stripeRefundsFail();
    const figures = await quote({}, STARTED_EVENT_ID);
    expect(figures).toEqual(paidCreditFigures());
    const result = await apply(figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await discountedNights(STARTED_PROMO_ID)).toEqual(["2026-06-30", "2026-07-01"]);
    expect(await storedNights()).toEqual(STORED_NIGHTS);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await refundOperations()).toEqual([]);
  }, 60_000);

  it("#5149 started stay, unpaid: the price and the amount owed drop by the in-window discount; nothing comes back", async () => {
    await seed("unpaid", STARTED_STAY);
    const figures = await quote({}, STARTED_EVENT_ID);
    expect(figures).toMatchObject({
      newFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      accountCreditAmountCents: 0,
      refundAmountCents: 0,
      refundedExcessCreditCents: 0,
    });
    const result = await apply(figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect((await amountOwed.readBookingAmountOwed(await bookingRow())).owedCents).toBe(PRICE_CENTS - DISCOUNT_CENTS);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PAYMENT_PENDING");
    expect(await storedNights()).toEqual(STORED_NIGHTS);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
  }, 60_000);

  it("#5149 started stay, paid by Internet Banking, Refund to bank account: the edit's hand-back, in full", async () => {
    await seed("bank-paid", STARTED_STAY);
    const figures = await quote({ settlementMethod: "card" }, STARTED_EVENT_ID);
    expect(figures).toEqual({ ...paidCreditFigures(), accountCreditAmountCents: 0, refundAmountCents: DISCOUNT_CENTS, settlementMethod: "card" });
    const result = await apply(figures, { settlementMethod: "card" }, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(
      await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID }, select: { amountCents: true, kind: true } }),
    ).toEqual([{ amountCents: DISCOUNT_CENTS, kind: "CANCELLED_BOOKING_HAND_BACK" }]);
    expect(await refundOperations()).toEqual([]);
    expect(await storedNights()).toEqual(STORED_NIGHTS);
  }, 60_000);

  it("#5149 started stay, paid partly with account credit: every cent of the discount comes back, as the balance shows", async () => {
    await seed("card-and-credit", STARTED_STAY);
    const balanceBefore = await memberCredit.getMemberCreditBalance(OWNER_ID);
    const figures = await quote({}, STARTED_EVENT_ID);
    expect(figures.priceDiffCents).toBe(-DISCOUNT_CENTS);
    expect(figures.refundAmountCents).toBe(0);
    expect(figures.accountCreditAmountCents + figures.appliedCreditGivenBackCents).toBe(DISCOUNT_CENTS);
    const result = await apply(figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(balanceBefore + DISCOUNT_CENTS);
    expect(await refundOperations()).toEqual([]);
  }, 60_000);

  it("#5149 started stay, organiser-paid joiner: the reduction goes back to the organiser's card", async () => {
    await seed("organiser-paid", STARTED_STAY);
    stripeRefundsFail();
    const offered = await quoted({}, STARTED_EVENT_ID);
    expect(offered.settlementOptions).toEqual({ methods: ["card"], paidByOrganiser: true, refundTo: null });
    expect(offered.figures).toMatchObject({ refundAmountCents: DISCOUNT_CENTS, accountCreditAmountCents: 0 });
    const result = await apply(offered.figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    expect(await recoveryRows("organiser", 1)).toEqual([
      expect.objectContaining({ amountCents: DISCOUNT_CENTS, paymentIntentId: SETTLEMENT_PI }),
    ]);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
  }, 60_000);

  it("#5149 started stay whose held nights were sold above the season rate: the discount is on the price sold, never re-rated", async () => {
    const soldCents = 7_000;
    await seed("paid", STARTED_STAY, OWNER_ID, OWNER_ID, soldCents);
    const figures = await quote({}, STARTED_EVENT_ID);
    // 50% of the two in-window nights at the price they were sold for, not the 5,000c rate.
    const discount = 2 * soldCents * (DISCOUNT_PERCENT / 100);
    expect(figures).toMatchObject({ priceDiffCents: -discount, accountCreditAmountCents: discount, refundAmountCents: 0 });
    const result = await apply(figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await storedNights()).toEqual({
      priceCents: STARTED_STAY.nights.length * soldCents,
      nights: STARTED_STAY.nights.map(() => ({ priceCents: soldCents })),
    });
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#127 every other in-progress edit still refuses a promo change", async () => {
    await seed("paid", STARTED_STAY);
    const before = await snapshot();
    const ordinary = await batchService
      .modifyBookingBatch({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { promoCodes: [{ code: PUBLIC_PROMO_CODE }], settlementMethod: "credit", notifyMember: false },
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTimeServer.clubTime()).today(),
        format: CLUB_FORMAT_TEST,
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(ordinary).toBe("Promo code changes are not available for in-progress bookings");
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#130 future card-paid booking: removal owes the discount back, and leaves the credit already given alone", async () => {
    await seed("paid");
    const added = await apply(await quote());
    expect(added.outcome).toBe("applied");
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    const creditRows = await prisma.memberCredit.findMany({ where: { memberId: OWNER_ID }, orderBy: { id: "asc" } });
    // The additional ask's mint is after commit; Stripe is not reached here.
    stripeRaceHooks.create = async () => {
      throw new Error("race 130: Stripe is not called in this proof");
    };

    const figures = await removalQuote();
    expect(figures).toEqual({
      previousFinalPriceCents: PRICE_CENTS - DISCOUNT_CENTS,
      newFinalPriceCents: PRICE_CENTS,
      priceDiffCents: DISCOUNT_CENTS,
      changeFeeCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      // Asked of the member's card, as any edit that raises a paid booking's price.
      additionalAmountCents: DISCOUNT_CENTS,
      billedToOrganiserCents: 0,
      refundAmountCents: 0,
      settlementMethod: null,
    });
    const result = await removalApply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    if (result.outcome !== "applied") throw new Error("not applied");

    expect(await workPartyRedemptions()).toEqual([]);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS, promoAdjustmentCents: 0 });
    expect(
      await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId! } }),
    ).toMatchObject({ changeFeeCents: 0, priceDiffCents: DISCOUNT_CENTS });
    // No clawback: the credit rows and the balance are exactly as the Add left them.
    expect(await prisma.memberCredit.findMany({ where: { memberId: OWNER_ID }, orderBy: { id: "asc" } })).toEqual(creditRows);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#130 unpaid booking: removal puts the price and the amount owed back up", async () => {
    await seed("unpaid");
    await apply(await quote());
    expect((await amountOwed.readBookingAmountOwed(await bookingRow())).owedCents).toBe(PRICE_CENTS - DISCOUNT_CENTS);

    const figures = await removalQuote();
    expect(figures).toMatchObject({ newFinalPriceCents: PRICE_CENTS, priceDiffCents: DISCOUNT_CENTS, refundAmountCents: 0 });
    const result = await removalApply(figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect((await amountOwed.readBookingAmountOwed(await bookingRow())).owedCents).toBe(PRICE_CENTS);
    expect(await workPartyRedemptions()).toEqual([]);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#130 started stay: removal takes the discount off the same in-window nights", async () => {
    await seed("paid", STARTED_STAY);
    await apply(await quote({}, STARTED_EVENT_ID), {}, STARTED_EVENT_ID);
    expect(await discountedNights(STARTED_PROMO_ID)).toEqual(["2026-06-30", "2026-07-01"]);
    stripeRaceHooks.create = async () => {
      throw new Error("race 130: Stripe is not called in this proof");
    };

    const figures = await removalQuote(STARTED_EVENT_ID);
    expect(figures).toMatchObject({ newFinalPriceCents: PRICE_CENTS, priceDiffCents: DISCOUNT_CENTS });
    const result = await removalApply(figures, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await discountedNights(STARTED_PROMO_ID)).toEqual([]);
    expect(await storedNights()).toEqual(STORED_NIGHTS);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#130 with several codes switched on, the work party is dropped, not carried", async () => {
    await withSeveralCodes(async () => {
      await seed("unpaid");
      await apply(await quote());
      const figures = await removalQuote();
      expect(figures).toMatchObject({ newFinalPriceCents: PRICE_CENTS, priceDiffCents: DISCOUNT_CENTS });
      await removalApply(figures);
      expect(await workPartyRedemptions()).toEqual([]);
    });
  }, 60_000);

  it("fork triyder/AlpineClubBookingsNZ#130 refuses a booking that is not on that work party, writing nothing", async () => {
    await seed("paid");
    const before = await snapshot();
    expect(await removalRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_NOT_ON_BOOKING_MESSAGE });
    await apply(await quote());
    // The Add's Xero note is queued after commit; wait for it before comparing.
    expect(await modificationXeroOps(1)).toHaveLength(1);
    const added = await snapshot();
    expect(await removalRefusal(OTHER_EVENT_ID)).toEqual({ status: 409, message: correction.WORK_PARTY_NOT_ON_BOOKING_MESSAGE });
    expect(await snapshot()).toEqual(added);
    expect(before.redemptions).toBe(0);
  }, 60_000);

  it("owner decision 3: Remove refuses the officer's own booking, a family member's, and an organiser-paid joiner's whose owner or organiser is the officer", async () => {
    const own = { status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE };
    await seed("paid");
    await apply(await quote());
    await modificationXeroOps(1);
    const added = await snapshot();
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { memberId: OFFICER_ID } });
    expect(await removalRefusal()).toEqual(own);
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { memberId: OWNER_ID } });
    await prisma.familyGroup.create({
      data: { id: FAMILY_ID, memberships: { create: [{ memberId: OWNER_ID }, { memberId: OFFICER_ID }] } },
    });
    expect(await removalRefusal()).toEqual(own);
    expect(await snapshot()).toEqual(added);

    await clean();
    await seed("organiser-paid", undefined, JOINER_ID, OWNER_ID);
    stripeRefundsFail();
    expect(await apply(await quote())).toMatchObject({ outcome: "applied" });
    await modificationXeroOps(1);
    const joinerAdded = await snapshot();
    // The officer organised and paid for the group.
    await prisma.booking.update({ where: { id: ORGANISER_BOOKING_ID }, data: { memberId: OFFICER_ID } });
    expect(await removalRefusal()).toEqual(own);
    // The officer is the joiner who owns the booking.
    await prisma.booking.update({ where: { id: ORGANISER_BOOKING_ID }, data: { memberId: OWNER_ID } });
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { memberId: OFFICER_ID } });
    expect(await removalRefusal()).toEqual(own);
    expect(await snapshot()).toEqual(joinerAdded);
  }, 120_000);

  /** No card ask is minted here: the after-commit Stripe leg fails, as an outage would. */
  function stripeAsksFail(): void {
    stripeRaceHooks.create = async () => {
      throw new Error("race 5149: Stripe is not called in this proof");
    };
  }

  it("#5149 owner decision: Remove after a 100% Add (PAID, nothing taken) is refused with nothing written", async () => {
    await seed("unpaid");
    const figures = await quote({}, FULL_EVENT_ID);
    expect(figures).toMatchObject({ newFinalPriceCents: 0, priceDiffCents: -PRICE_CENTS });
    const result = await apply(figures, {}, FULL_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    // The ordinary $0 auto-pay: PAID, nothing taken.
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).toEqual({ status: "PAID" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({ amountCents: 0, creditAppliedCents: 0 });
    await modificationXeroOps(0);
    const before = await snapshot();
    stripeAsksFail();
    expect(await removalRefusal(FULL_EVENT_ID)).toEqual({ status: 409, message: correction.WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING_ID, promoCodeId: FULL_PROMO_ID } })).toBe(1);
  }, 90_000);

  it("#5149 owner decision 20 Nov: an unpaid $200 booking with $100 credit, after a 50% Add, is PAID by credit alone and Remove is refused", async () => {
    // The decision's example (https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-7035299228).
    await seed("unpaid-half-credit");
    const figures = await quote({}, HALF_EVENT_ID);
    expect(figures).toMatchObject({
      previousFinalPriceCents: PRICE_CENTS,
      newFinalPriceCents: PRICE_CENTS - DECISION_CREDIT_CENTS,
      priceDiffCents: -DECISION_CREDIT_CENTS,
      refundAmountCents: 0,
      refundedExcessCreditCents: 0,
    });
    const result = await apply(figures, {}, HALF_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    // The ordinary $0 auto-pay: the credit covers the new price, so PAID with no money taken.
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).toEqual({ status: "PAID" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({
      status: "SUCCEEDED",
      amountCents: 0,
      creditAppliedCents: DECISION_CREDIT_CENTS,
    });
    await modificationXeroOps(0);
    const before = await snapshot();
    stripeAsksFail();
    expect(await removalRefusal(HALF_EVENT_ID)).toEqual({ status: 409, message: correction.WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await prisma.promoRedemption.count({ where: { bookingId: BOOKING_ID, promoCodeId: HALF_PROMO_ID } })).toBe(1);
    // The list reads the same fact.
    expect(await removalFacts()).toMatchObject({ paidWithNoMoneyTaken: true, workPartyEventId: HALF_EVENT_ID });
  }, 90_000);

  it("#5149 owner decision 20 Nov: a booking paid in full by credit before any work party may be added, and Remove is refused", async () => {
    // The trade-off the owner accepted: credit alone is refused, whenever the credit was applied.
    await seed("credit-paid");
    stripeAsksFail();
    const added = await apply(await quote());
    expect(added, JSON.stringify(added)).toMatchObject({ outcome: "applied" });
    await modificationXeroOps(1);
    const before = await snapshot();
    expect(await removalRefusal()).toEqual({ status: 409, message: correction.WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(await workPartyRedemptions()).toHaveLength(1);
  }, 90_000);

  it("#5149 owner decision 20 Nov: a joiner whose share the organiser paid is not paid by credit alone, as the group settlement records that share", async () => {
    await seed("organiser-paid");
    stripeRefundsFail();
    const added = await apply(await quote());
    expect(added, JSON.stringify(added)).toMatchObject({ outcome: "applied" });
    // The joiner's payment holds the share the organiser paid, so the fact is false.
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { amountCents: true } })).toEqual({ amountCents: PRICE_CENTS });
    expect(await removalFacts()).toMatchObject({ paidWithNoMoneyTaken: false });
    // Remove is answered by the edit's own rule for a card-paid joiner, not this refusal.
    expect(await removalRefusal()).toEqual({ status: 409, message: expect.stringContaining("group organiser") });
  }, 90_000);

  it("#5149 review F4: an Internet Banking organiser-paid joiner gets past the fact, and Remove invoices the increase to the organiser", async () => {
    await seed("organiser-paid-bank");
    stripeRefundsFail();
    stripeAsksFail();
    const added = await apply(await quote());
    expect(added, JSON.stringify(added)).toMatchObject({ outcome: "applied" });
    expect(await removalFacts()).toMatchObject({ paidWithNoMoneyTaken: false, workPartyEventId: EVENT_ID });
    const figures = await removalQuote();
    expect(figures).toMatchObject({
      newFinalPriceCents: PRICE_CENTS,
      priceDiffCents: DISCOUNT_CENTS,
      billedToOrganiserCents: DISCOUNT_CENTS,
      additionalAmountCents: 0,
      refundAmountCents: 0,
    });
    const removed = await removalApply(figures);
    expect(removed, JSON.stringify(removed)).toMatchObject({ outcome: "applied", figures });
    expect(await workPartyRedemptions()).toEqual([]);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS });
  }, 90_000);

  it("#5212 (INV-PAY-160): a card payment Stripe holds no record of is offered Refund to bank account, the edit's hand-back", async () => {
    await seed("paid");
    stripeRefundsFail();
    await prisma.paymentTransaction.update({ where: { id: PRIMARY_TXN_ID }, data: { stripePaymentIntentId: null } });
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripePaymentIntentId: null } });
    const offered = await quoted();
    expect(offered.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "bank" });
    const figures = await quote({ settlementMethod: "card" });
    expect(figures).toMatchObject({ accountCreditAmountCents: 0, refundAmountCents: DISCOUNT_CENTS, settlementMethod: "card" });
    const result = await apply(figures, { settlementMethod: "card" });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(
      await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID }, select: { paymentId: true, amountCents: true } }),
    ).toEqual([{ paymentId: PAYMENT_ID, amountCents: DISCOUNT_CENTS }]);
    expect(await refundOperations()).toEqual([]);
    expect(await prisma.memberCredit.count({ where: { memberId: OWNER_ID } })).toBe(0);
  }, 90_000);

  it("#5149 Add, Remove, Add by credit: no money moves twice, and the second Add offers no method", async () => {
    await seed("paid");
    stripeAsksFail();
    await apply(await quote());
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    await removalApply(await removalQuote());
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);

    const again = await quoted();
    // The reduction cancels the ask the Remove raised: nothing comes back.
    expect(again.settlementOptions).toEqual({
      methods: [],
      paidByOrganiser: false,
      refundTo: null,
      unpaidAskOffsetCents: DISCOUNT_CENTS,
    });
    expect(again.figures).toMatchObject({ accountCreditAmountCents: 0, refundAmountCents: 0, settlementMethod: null });
    const result = await apply(again.figures);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures: again.figures });
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);

    await removalApply(await removalQuote());
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
    expect(await workPartyRedemptions()).toEqual([]);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS });
  }, 120_000);

  it("#5149 B-L1 Add, Remove, Add by card: the second card choice is told nothing comes back, and no second refund is made", async () => {
    await seed("paid");
    stripeRefundsFail();
    stripeAsksFail();
    await apply(await quote({ settlementMethod: "card" }), { settlementMethod: "card" });
    expect(await recoveryRows("own-card", 1)).toHaveLength(1);
    await removalApply(await removalQuote());

    expect(await correctionRefusal(EVENT_ID, { settlementMethod: "card" })).toEqual({
      status: 409,
      message: "The discount cancels $50.00 of what is still owed on this booking, so nothing comes back.",
    });
    const result = await apply(await quote());
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
    expect(await recoveryRows("own-card", 1)).toHaveLength(1);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(0);
  }, 120_000);

  it("#5149 two concurrent Removes with the same figures apply once; the other is refused", async () => {
    await seed("paid");
    stripeAsksFail();
    await apply(await quote());
    const figures = await removalQuote();
    const outcomes = await Promise.allSettled([removalApply(figures), removalApply(figures)]);
    const applied = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(applied, JSON.stringify(outcomes)).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ status: 409, message: correction.WORK_PARTY_NOT_ON_BOOKING_MESSAGE });
    expect(await workPartyRedemptions()).toEqual([]);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(2);
    expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS });
  }, 90_000);

  // A credit-paid booking is refused Remove (owner decision, 20 Nov 2026), proved above;
  // part credit and part card or bank is money taken, so Remove goes ahead (review F3).
  it.each(["bank-paid", "part-paid", "card-and-credit", "bank-and-credit"] as const)(
    "#5149 Remove on a %s booking: the price goes back up, nothing comes back, and credit already given stays",
    async (shape) => {
      await seed(shape);
      stripeAsksFail();
      const added = await apply(await quote());
      expect(added, JSON.stringify(added)).toMatchObject({ outcome: "applied" });
      const balance = await memberCredit.getMemberCreditBalance(OWNER_ID);
      const figures = await removalQuote();
      expect(figures).toMatchObject({
        newFinalPriceCents: PRICE_CENTS,
        priceDiffCents: DISCOUNT_CENTS,
        changeFeeCents: 0,
        accountCreditAmountCents: 0,
        appliedCreditGivenBackCents: 0,
        refundedExcessCreditCents: 0,
        refundAmountCents: 0,
      });
      const result = await removalApply(figures);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
      expect(await workPartyRedemptions()).toEqual([]);
      expect(await bookingRow()).toMatchObject({ finalPriceCents: PRICE_CENTS });
      expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(balance);
    },
    90_000,
  );

  /** Run with several codes per booking switched on, putting the club's switch back afterwards. */
  async function withSeveralCodes(run: () => Promise<void>): Promise<void> {
    const settings = await prisma.clubModuleSettings.findUnique({
      where: { id: "default" },
      select: { multiPromoCodes: true },
    });
    await prisma.clubModuleSettings.upsert({
      where: { id: "default" },
      create: { id: "default", multiPromoCodes: true },
      update: { multiPromoCodes: true },
      select: { id: true },
    });
    try {
      await run();
    } finally {
      if (settings) {
        await prisma.clubModuleSettings.update({
          where: { id: "default" },
          data: { multiPromoCodes: settings.multiPromoCodes },
          select: { id: true },
        });
      } else {
        await prisma.clubModuleSettings.delete({ where: { id: "default" }, select: { id: true } });
      }
    }
  }

  /**
   * H1: the started stay also carries a member's own code, applied before the
   * stay began (an edit on 20 June) and expired on 30 June, the day before the
   * frozen today. Applied through the ordinary edit on that earlier club day.
   */
  async function seedStartedStayWithExpiredMemberCode(): Promise<void> {
    await seed("unpaid", STARTED_STAY);
    await prisma.promoCode.update({
      where: { id: MEMBER_PROMO_ID },
      data: { validUntil: new Date("2026-06-30T00:00:00.000Z") },
    });
    await batchService.modifyBookingBatch({
      bookingId: BOOKING_ID,
      actor: { id: OFFICER_ID, role: Role.ADMIN },
      input: { promoCodes: [{ code: MEMBER_PROMO_CODE }], notifyMember: false },
      ipAddress: "127.0.0.1",
      todayAtClub: requireCalendarDate("2026-06-20"),
      format: CLUB_FORMAT_TEST,
    });
    const applied = await prisma.promoRedemption.findMany({ where: { bookingId: BOOKING_ID, promoCodeId: MEMBER_PROMO_ID } });
    expect(applied).toHaveLength(1);
  }

  async function memberCodeRedemptions() {
    return prisma.promoRedemption.findMany({ where: { bookingId: BOOKING_ID, promoCodeId: MEMBER_PROMO_ID } });
  }

  it("H1: a started stay's Add keeps a member code that expired after check-in, and moves the price by the work party alone", async () => {
    await withSeveralCodes(async () => {
      await seedStartedStayWithExpiredMemberCode();
      const before = await bookingRow();
      const figures = await quote({}, STARTED_EVENT_ID);
      const result = await apply(figures, {}, STARTED_EVENT_ID);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
      // The code is judged on the check-in day, when it was live: kept, not
      // dropped and billed back. It yields the two nights the work party now
      // claims (INV-MONEY-039) and keeps its 10% on the other two.
      const [member] = await memberCodeRedemptions();
      expect(member?.discountCents).toBe(MEMBER_CODE_OUTSIDE_WINDOW_CENTS);
      const workParty = await prisma.promoRedemption.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, promoCodeId: STARTED_PROMO_ID },
      });
      expect(workParty.discountCents).toBe(DISCOUNT_CENTS);
      // The price moves by the work party's discount less what the member code
      // yields to it, and by nothing billed back for the code itself.
      const expectedDiff = -(DISCOUNT_CENTS - (MEMBER_CODE_WHOLE_STAY_CENTS - MEMBER_CODE_OUTSIDE_WINDOW_CENTS));
      expect(figures.priceDiffCents).toBe(expectedDiff);
      expect((await bookingRow()).finalPriceCents).toBe(before.finalPriceCents + expectedDiff);
    });
  }, 90_000);

  it("H1: a started stay's Remove keeps that member code too, and moves the price by the work party alone", async () => {
    await withSeveralCodes(async () => {
      await seedStartedStayWithExpiredMemberCode();
      await apply(await quote({}, STARTED_EVENT_ID), {}, STARTED_EVENT_ID);
      const workParty = await prisma.promoRedemption.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, promoCodeId: STARTED_PROMO_ID },
      });
      expect(workParty.discountCents).toBe(DISCOUNT_CENTS);
      const figures = await removalQuote(STARTED_EVENT_ID);
      // The exact reverse of the Add: the member code takes its two nights back.
      expect(figures.priceDiffCents).toBe(DISCOUNT_CENTS - (MEMBER_CODE_WHOLE_STAY_CENTS - MEMBER_CODE_OUTSIDE_WINDOW_CENTS));
      const result = await removalApply(figures, STARTED_EVENT_ID);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
      const [member] = await memberCodeRedemptions();
      expect(member?.discountCents).toBe(MEMBER_CODE_WHOLE_STAY_CENTS);
      expect(await discountedNights(STARTED_PROMO_ID)).toEqual([]);
    });
  }, 90_000);

  it("M1: a booking an officer overbooked can still be corrected, future or started: the correction claims no bed", async () => {
    // One bed, taken by another booking across both stays, so this booking is
    // over capacity on every night: an officer overbooked it.
    await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 1 } });
    await prisma.booking.create({
      data: {
        id: OTHER_BOOKING_ID,
        memberId: OFFICER_ID,
        lodgeId: LODGE_ID,
        checkIn: STARTED_STAY.nights[0]!,
        checkOut: CHECK_OUT,
        status: "PAID",
        totalPriceCents: 0,
        finalPriceCents: 0,
        guests: {
          create: {
            firstName: "Other",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: STARTED_STAY.nights[0]!,
            stayEnd: CHECK_OUT,
            priceCents: 0,
          },
        },
      },
    });
    try {
      for (const [stay, eventId] of [[undefined, EVENT_ID], [STARTED_STAY, STARTED_EVENT_ID]] as const) {
        await clean();
        await seed("paid", stay);
        await prisma.booking.update({ where: { id: BOOKING_ID }, data: { capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z") } });
        // The control: an ordinary edit of the same booking is refused for beds.
        const ordinary = await batchService
          .modifyBookingBatch({
            bookingId: BOOKING_ID,
            actor: { id: OFFICER_ID, role: Role.ADMIN },
            input: { addGuests: [{ firstName: "Extra", lastName: "Guest", ageTier: "ADULT", isMember: false }], notifyMember: false },
            ipAddress: "127.0.0.1",
            todayAtClub: (await clubTimeServer.clubTime()).today(),
            format: CLUB_FORMAT_TEST,
          })
          .then(() => null, (error: Error) => error.message);
        expect(ordinary).not.toBeNull();
        const figures = await quote({}, eventId);
        const result = await apply(figures, {}, eventId);
        expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied" });
        const removal = await removalQuote(eventId);
        expect(removal.priceDiffCents).toBe(-figures.priceDiffCents);
      }
    } finally {
      await prisma.bookingGuest.deleteMany({ where: { bookingId: OTHER_BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: OTHER_BOOKING_ID } });
      await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 10 } });
    }
  }, 120_000);

  it("security review: a booking that holds no beds yet takes the bed check, so the $0 auto-pay cannot overbook", async () => {
    // One bed, taken by a paid booking. This booking is PAYMENT_PENDING with
    // credit applied, so the work party's discount would settle it at $0 and
    // the edit would move it to PAID: a bed it does not hold yet.
    await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 1 } });
    await prisma.booking.create({
      data: {
        id: OTHER_BOOKING_ID,
        memberId: OFFICER_ID,
        lodgeId: LODGE_ID,
        checkIn: STARTED_STAY.nights[0]!,
        checkOut: CHECK_OUT,
        status: "PAID",
        totalPriceCents: 0,
        finalPriceCents: 0,
        guests: {
          create: {
            firstName: "Other",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: STARTED_STAY.nights[0]!,
            stayEnd: CHECK_OUT,
            priceCents: 0,
          },
        },
      },
    });
    try {
      await seed("unpaid-credit");
      const before = await snapshot();
      expect(await correctionRefusal()).not.toBeNull();
      expect(await snapshot()).toEqual(before);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("PAYMENT_PENDING");
    } finally {
      await prisma.bookingGuest.deleteMany({ where: { bookingId: OTHER_BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: OTHER_BOOKING_ID } });
      await prisma.lodgeSettings.update({ where: { id: LODGE_ID }, data: { capacity: 10 } });
    }
  }, 90_000);

  it("fork triyder/AlpineClubBookingsNZ#130 organiser-paid joiner: Remove is refused like any rise on a card-paid joiner, with nothing written", async () => {
    await seed("organiser-paid");
    stripeRefundsFail();
    const added = await apply(await quote());
    expect(added, JSON.stringify(added)).toMatchObject({ outcome: "applied" });
    const before = await snapshot();
    expect(await removalRefusal()).toEqual({ status: 409, message: expect.stringContaining("group organiser") });
    expect(await snapshot()).toEqual(before);
  }, 90_000);

  it.each(["organiser-unpaid", "organiser-settling"] as const)(
    "#5149 review A1: a %s joiner whose organiser is the officer, or in the officer's family, is refused on Add and Remove",
    async (shape) => {
      const own = { status: 409, message: correction.WORK_PARTY_OWN_BOOKING_MESSAGE };
      for (const relation of ["organiser", "organiser's family"] as const) {
        await clean();
        await seed(shape, undefined, JOINER_ID, relation === "organiser" ? OFFICER_ID : OWNER_ID);
        if (relation === "organiser's family") {
          await prisma.familyGroup.create({
            data: { id: FAMILY_ID, memberships: { create: [{ memberId: OWNER_ID }, { memberId: OFFICER_ID }] } },
          });
        }
        const before = await snapshot();
        expect(await correctionRefusal(), `${shape}, ${relation}, Add`).toEqual(own);
        expect(await snapshot()).toEqual(before);
        // On the work party already (an earlier officer's Add): Remove is refused too.
        await prisma.promoRedemption.create({
          data: { bookingId: BOOKING_ID, promoCodeId: PROMO_ID, memberId: JOINER_ID, discountCents: DISCOUNT_CENTS },
        });
        const onIt = await snapshot();
        expect(await removalRefusal(), `${shape}, ${relation}, Remove`).toEqual(own);
        expect(await snapshot()).toEqual(onIt);
      }
    },
    120_000,
  );

  /** A Stripe that mints asks and cancels them, recording both (no network). */
  function stripeMintsAsks(): { created: string[]; cancelled: string[] } {
    const stripe = { created: [] as string[], cancelled: [] as string[], intents: new Map<string, Record<string, unknown>>() };
    stripeRaceHooks.customer = async () => ({ id: "cus_race_119", object: "customer", metadata: {} });
    stripeRaceHooks.create = async (args) => {
      const id = `pi_race_5149_ask_${stripe.created.length + 1}`;
      stripe.intents.set(id, {
        id,
        object: "payment_intent",
        amount: args.amountCents,
        currency: "nzd",
        status: "requires_payment_method",
        client_secret: `${id}_secret`,
        payment_method: null,
        metadata: args.metadata ?? {},
        latest_charge: null,
        last_payment_error: null,
      });
      stripe.created.push(id);
      return { ...stripe.intents.get(id)! };
    };
    stripeRaceHooks.get = async (id) => {
      const intent = stripe.intents.get(id);
      if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
      return { ...intent };
    };
    stripeRaceHooks.cancel = async (id) => {
      const intent = stripe.intents.get(id);
      if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
      stripe.cancelled.push(id);
      intent.status = "canceled";
      return { paymentIntent: { ...intent }, canceled: true };
    };
    return stripe;
  }

  /** The booking's additional asks, oldest first. */
  async function additionalAsks() {
    return prisma.paymentTransaction.findMany({
      where: { paymentId: PAYMENT_ID, kind: "ADDITIONAL" },
      orderBy: { createdAt: "asc" },
      select: { stripePaymentIntentId: true, amountCents: true, status: true, withdrawnAt: true },
    });
  }

  it("#5149 review M5: Add, Remove, Add with a live minted ask: the second Add retires it and its Stripe cancel is made or queued", async () => {
    await seed("paid");
    const stripe = stripeMintsAsks();
    await apply(await quote());
    await removalApply(await removalQuote());
    await modificationXeroOps(0);
    const [minted] = await additionalAsks();
    expect(stripe.created).toHaveLength(1);
    expect(minted).toMatchObject({ stripePaymentIntentId: stripe.created[0], amountCents: DISCOUNT_CENTS, status: "PENDING", withdrawnAt: null });

    const again = await quoted();
    expect(again.settlementOptions).toMatchObject({ methods: [], unpaidAskOffsetCents: DISCOUNT_CENTS });
    expect(await apply(again.figures)).toMatchObject({ outcome: "applied" });
    await modificationXeroOps(0);
    // Retired: no longer the live ask, nothing asked of the card, and no money moved.
    const [retired] = await additionalAsks();
    expect(retired!.withdrawnAt !== null || retired!.status !== "PENDING", JSON.stringify(retired)).toBe(true);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({ additionalAmountCents: 0 });
    const queued = await prisma.paymentRecoveryOperation.count({
      where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", paymentIntentId: stripe.created[0] },
    });
    expect(stripe.cancelled.includes(stripe.created[0]!) || queued > 0, JSON.stringify({ stripe, queued })).toBe(true);
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
  }, 120_000);

  it("#5149 review M5: a concurrent Add and Remove serialise: the Add applies, and the Remove applies after it or is refused", async () => {
    await seed("paid");
    stripeAsksFail();
    // A Remove's figures, from a first Add and Remove; then the booking is off the work party again.
    await apply(await quote());
    const removeFigures = await removalQuote();
    await removalApply(removeFigures);
    const addFigures = await quote();
    const [added, removed] = await Promise.allSettled([apply(addFigures), removalApply(removeFigures)]);
    expect(added.status, JSON.stringify(added)).toBe("fulfilled");
    if (removed.status === "rejected") {
      // It ran first and found no work party, or after the Add with figures that had moved.
      expect(removed.reason).toMatchObject({ status: expect.any(Number) });
      expect(await workPartyRedemptions()).toHaveLength(1);
    } else {
      expect(await workPartyRedemptions()).toEqual([]);
    }
    // Either way the credit the first Add gave is all the money that came back.
    expect(await memberCredit.getMemberCreditBalance(OWNER_ID)).toBe(DISCOUNT_CENTS);
  }, 120_000);

  it("#5149 review M5: a guest added mid-stay keeps the nights it was sold, and the discount stays the member's in-window nights", async () => {
    await seed("paid", STARTED_STAY);
    stripeAsksFail();
    // The officer's ordinary edit adds a guest from tonight, as at the lodge.
    const addedGuest = await batchService
      .modifyBookingBatch({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: {
          addGuests: [{ firstName: "Mid", lastName: "Stay", ageTier: "ADULT", isMember: false, stayStart: "2026-07-01", stayEnd: "2026-07-03" }],
          notifyMember: false,
        },
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTimeServer.clubTime()).today(),
        format: CLUB_FORMAT_TEST,
      })
      .then(() => null, (error: Error) => error.message);
    expect(addedGuest, "an officer can add a guest to a started stay").toBeNull();
    const guestNights = async () =>
      prisma.bookingGuestNight.findMany({
        where: { bookingGuest: { bookingId: BOOKING_ID, id: { not: GUEST_ID } } },
        orderBy: { stayDate: "asc" },
        select: { stayDate: true, priceCents: true },
      });
    const soldBefore = await guestNights();
    // An in-progress edit sells future nights only, so the guest's first night is tomorrow's.
    expect(soldBefore.map((night) => night.stayDate.toISOString().slice(0, 10))).toEqual(["2026-07-02"]);

    const figures = await quote({}, STARTED_EVENT_ID);
    // Only the member's two in-window nights: the added guest's night is neither in the window nor a member's.
    expect(figures.priceDiffCents).toBe(-DISCOUNT_CENTS);
    const result = await apply(figures, {}, STARTED_EVENT_ID);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", figures });
    expect(await guestNights()).toEqual(soldBefore);
    expect(await storedNights()).toEqual(STORED_NIGHTS);
  }, 120_000);

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
