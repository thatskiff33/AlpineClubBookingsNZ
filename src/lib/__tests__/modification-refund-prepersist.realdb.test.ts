/**
 * #4992: every edit door commits its own-card refund debt before its after-commit
 * work can run. The edit services, payment allocator and recovery writer are
 * real; the inline entry throws to model a process stopping just after commit.
 * #5212: a card payment with no Stripe record owes no card debt and no card
 * refund payable; every door hands its reduction to the treasurer instead.
 * Runs only against the guarded, disposable realdb database.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
// Type only: the helper loads `@/lib/prisma`, which must be built after DATABASE_URL
// points at the race database (see beforeAll).
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { memberMoneyTestContext, MEMBER_MONEY_TEST_TAX_ANCHOR } from "./support/member-money-fixtures";
import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OWNER = "race-4992-owner";
const OFFICER = "race-4992-officer";
const GUEST_MEMBER = "race-4992-guest-member";
const LODGE = "race-4992-lodge";
const SEASON = "race-4992-season";
const BOOKING = "race-4992-booking";
const PAYMENT = "race-4992-payment";
const PRIMARY = "race-4992-primary";
const ADDITIONAL = "race-4992-additional";
const STAYING = "race-4992-staying";
const LEAVING = "race-4992-leaving";
const PROMO = "race-4992-promo";
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const N1 = new Date("2026-09-01T00:00:00.000Z");
const N2 = new Date("2026-09-02T00:00:00.000Z");
const END = new Date("2026-09-03T00:00:00.000Z");
const CRASH = new Error("#4992 simulated stop before inline refund");
const JOURNAL = memberMoneyTestContext();

let prisma: PrismaClient;
let dates: typeof import("@/lib/booking-date-modification-service");
let batches: typeof import("@/lib/booking-batch-modification-service");
let removal: typeof import("@/lib/booking-guest-removal-service");
let acceptance: typeof import("@/lib/booking-guest-acceptance-reprice");
let keys: typeof import("@/lib/payment-recovery-keys");
let handBackKeys: typeof import("@/lib/manual-refund-task-settlement-rules");
let confirmation: typeof import("@/lib/booking-ledger-confirmation-sync");
let clubTime: typeof import("@/lib/club-time");
let money: typeof import("@/lib/member-money");
let restoreInline: (() => void) | undefined;
let role: SuiteEnvironmentRoleDeclaration | undefined;

async function clean(): Promise<void> {
  const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING }, select: { id: true } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING, PAYMENT, ...modifications.map((row) => row.id)] } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING, PAYMENT, ...modifications.map((row) => row.id)] } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING }, { memberId: { in: [OWNER, OFFICER, GUEST_MEMBER] } }, { actorMemberId: { in: [OWNER, OFFICER, GUEST_MEMBER] } }] } });
  await releaseBookingFinancialHistoryForTeardown(prisma, [BOOKING]);
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: { in: [OWNER, GUEST_MEMBER] } } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.promoRedemptionGuestTarget.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.promoRedemptionAllocation.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.promoRedemption.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.booking.deleteMany({ where: { id: BOOKING } });
  await prisma.promoCode.deleteMany({ where: { id: PROMO } });
}

/**
 * $200 paid by two captured slices; either guest's two nights cost $100.
 * `NO_STRIPE_RECORD` (#5212) is a succeeded card payment with no intent and no
 * captured transaction: nothing Stripe could refund. `intentlessCapture` gives
 * it one captured ledger row that names no intent either. `journaled` posts the
 * booking's charge to the member-money journal as its settle would, so an edit's
 * card refund payable (R05) posts too.
 */
async function seed(shape: "STRIPE" | "INTERNET_BANKING" | "NO_STRIPE_RECORD" = "STRIPE", { journaled = false, intentlessCapture = false } = {}): Promise<void> {
  const source = shape === "NO_STRIPE_RECORD" ? "STRIPE" : shape;
  await prisma.booking.create({ data: {
    id: BOOKING, memberId: OWNER, lodgeId: LODGE, checkIn: N1, checkOut: END,
    status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000, hasNonMembers: true,
  } });
  for (const id of [STAYING, LEAVING]) {
    await prisma.bookingGuest.create({ data: {
      id, bookingId: BOOKING, firstName: id === STAYING ? "Staying" : "Leaving", lastName: "Proof",
      ageTier: "ADULT", isMember: false, stayStart: N1, stayEnd: END, priceCents: 10_000,
      nights: { create: [N1, N2].map((stayDate) => ({ stayDate, priceCents: 5_000, priceSource: "SOLD" })) },
    } });
  }
  await prisma.payment.create({ data: {
    id: PAYMENT, bookingId: BOOKING, amountCents: 20_000, source, status: "SUCCEEDED",
    ...(shape === "STRIPE" ? { stripePaymentIntentId: "pi_race_4992_primary" } : {}),
  } });
  if (shape === "STRIPE") {
    for (const [id, kind, cents, intent, capturedAt] of [
      [PRIMARY, "PRIMARY", 14_000, "pi_race_4992_primary", "2026-06-01T00:00:00.000Z"],
      [ADDITIONAL, "ADDITIONAL", 6_000, "pi_race_4992_additional", "2026-06-02T00:00:00.000Z"],
    ] as const) {
      await prisma.paymentTransaction.create({ data: {
        id, paymentId: PAYMENT, kind, source: "STRIPE", amountCents: cents, status: "SUCCEEDED",
        stripePaymentIntentId: intent, createdAt: new Date(capturedAt),
      } });
    }
  }
  if (intentlessCapture) {
    await prisma.paymentTransaction.create({ data: {
      id: PRIMARY, paymentId: PAYMENT, kind: "PRIMARY", source: "STRIPE", amountCents: 20_000, status: "SUCCEEDED",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    } });
  }
  if (journaled) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await confirmation.postStoredBookingConfirmationLedgerLines(tx, BOOKING, JOURNAL);
    }, { timeout: 20_000 });
  }
}

/**
 * #5212: THE JOURNAL AND THE DEBTS AGREE. What the journal holds as refund
 * payable on the booking is never more than the debts that will pay it (card
 * refund debts not yet made, and open treasurer hand-backs), and each edit's
 * card refund payable has that edit's card refund debt behind it, for the same
 * amount. Returns the edits' card refund payables.
 */
async function expectJournalAndDebtsAgree(): Promise<Array<{ modificationId: string; faceCents: number }>> {
  const payableLines = await prisma.memberMoneyLine.findMany({
    where: { bookingId: BOOKING, account: "REFUND_PAYABLE" }, select: { side: true, amountCents: true },
  });
  const payableCents = payableLines.reduce((sum, line) => sum + (line.side === "CREDIT" ? line.amountCents : -line.amountCents), 0);
  const cardDebts = await prisma.paymentRecoveryOperation.findMany({
    where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION", status: { not: "SUCCEEDED" } }, select: { idempotencyKey: true, amountCents: true },
  });
  const handBacks = await prisma.manualRefundTask.aggregate({ where: { bookingId: BOOKING, status: "OPEN" }, _sum: { amountCents: true } });
  const owedCents = cardDebts.reduce((sum, row) => sum + (row.amountCents ?? 0), 0) + (handBacks._sum.amountCents ?? 0);
  expect(payableCents).toBeLessThanOrEqual(owedCents);

  const cardPayables: Array<{ modificationId: string; faceCents: number }> = [];
  for (const modification of await prisma.bookingModification.findMany({ where: { bookingId: BOOKING }, select: { id: true } })) {
    const obligation = await prisma.memberMoneyObligation.findUnique({
      where: { obligationKey: memberMoneyEventKeys.refundObligation("modification", modification.id) }, select: { faceCents: true },
    });
    if (!obligation) continue;
    cardPayables.push({ modificationId: modification.id, faceCents: obligation.faceCents });
    expect(cardDebts).toContainEqual({
      idempotencyKey: keys.buildBookingModificationRefundRecoveryIdempotencyKey(modification.id), amountCents: obligation.faceCents,
    });
  }
  return cardPayables;
}

/** #5212: the reduction went to the treasurer's queue as one bank-transfer task, with no card debt and no card refund payable. */
async function handedBackWithNoCardDebt(cents = 10_000): Promise<void> {
  const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING } });
  expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(0);
  const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING } });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    status: "OPEN", paymentId: PAYMENT, amountCents: cents, raisedAmountCents: cents,
    occurrenceKey: handBackKeys.editRefundHandBackOccurrenceKey(modification.id),
  });
  expect(tasks[0]!.reason).toContain("card payment with no Stripe record");
  expect(await expectJournalAndDebtsAgree()).toEqual([]);
}

/** The accepted guest is now a member on the booking's existing code, so the re-price lowers the settled $200 price to nothing. */
async function acceptLeavingGuest() {
  await prisma.bookingGuest.update({ where: { id: LEAVING }, data: { memberId: GUEST_MEMBER, isMember: true, consentStatus: "CONFIRMED" } });
  await prisma.promoCode.create({ data: { id: PROMO, code: "RACE4992", type: "FIXED_AMOUNT", valueCents: 10_000 } });
  await prisma.promoRedemption.create({ data: { promoCodeId: PROMO, bookingId: BOOKING, memberId: OWNER, discountCents: 0, guestTargets: { create: { bookingId: BOOKING, bookingGuestId: LEAVING } } } });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const { acquireLodgeCapacityLock } = await import("@/lib/capacity");
    await acquireLodgeCapacityLock(tx, LODGE);
    return acceptance.repriceBookingAfterGuestAcceptance(tx, {
      bookingId: BOOKING, acceptedGuestId: LEAVING, actorMemberId: GUEST_MEMBER,
      todayAtClub: clubTime.requireCalendarDate("2026-07-01"), format: CLUB_FORMAT_TEST, journal: JOURNAL,
    });
  }, { timeout: 20_000 });
}

async function debt(prefix: string, cents = 10_000) {
  const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING } });
  const rows = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "PENDING", paymentId: PAYMENT, amountCents: cents,
    idempotencyKey: keys.buildBookingModificationRefundRecoveryIdempotencyKey(modification.id),
    stripeKeyPrefix: `${prefix}_${BOOKING}_${modification.id}`,
    allocationPlan: [
      { paymentTransactionId: ADDITIONAL, amountCents: 6_000 },
      { paymentTransactionId: PRIMARY, amountCents: cents - 6_000 },
    ],
  });
  expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT } })).toBe(0);
  return rows[0]!;
}

/** #4516: the booking's R01 in the journal, so an edit on it posts its refund debt there too. */
async function postR01(): Promise<void> {
  const charge = money.memberMoneyEventKeys.bookingCharge(BOOKING);
  const booking = { bookingId: BOOKING, lodgeId: LODGE };
  await prisma.$transaction((tx) => money.postMemberMoneyEvent(tx, JOURNAL, {
    kind: "CHARGE", eventKey: charge, origin: "APP", source: { kind: "BOOKING", id: BOOKING, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: charge, kind: "CHARGE", debtor: { kind: "MEMBER", memberId: OWNER }, faceCents: 20_000, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 20_000, booking, debtor: { kind: "MEMBER", memberId: OWNER }, obligationKey: charge, evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 20_000, booking, chargeIdentity: `booking:${BOOKING}:test`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
    ] }));
}

/** The refund debts (R05) the journal holds for one scope and id: each batch's face. */
function refundDebts(scope: "hand-back" | "modification", id: string) {
  return prisma.memberMoneyObligation.findMany({
    where: { obligationKey: { startsWith: money.memberMoneyEventKeys.refundObligation(scope, id) } },
    select: { obligationKey: true, faceCents: true },
  });
}

function batchArgs() {
  return {
    bookingId: BOOKING, actor: { id: OFFICER, role: Role.ADMIN },
    input: { removeGuestIds: [LEAVING], settlementMethod: "card" as const },
    ipAddress: "127.0.0.1", todayAtClub: clubTime.requireCalendarDate("2026-07-01"), format: CLUB_FORMAT_TEST,
  };
}

function remove(settlementMethod?: "card" | "credit", consentAuthority?: {
  kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY"; guestId: string; targetMemberId: string;
}) {
  return prisma.$transaction((tx) => removal.removeBookingGuestInTransaction({
    tx, bookingId: BOOKING, guestId: LEAVING, actorMemberId: OFFICER, actorRole: "ADMIN",
    today: TODAY, format: CLUB_FORMAT_TEST, journal: JOURNAL, settlementMethod, consentAuthority,
  }), { maxWait: 10_000, timeout: 20_000 });
}

(RUN ? describe : describe.skip)("#4992 edit refund debt survives the post-commit crash window — real PostgreSQL", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "#4992 edit refund proofs");
    process.env.DATABASE_URL = RACE_DB_URL;
    const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
    role = declareEnvironmentRoleForSuite("non-production");
    ({ prisma } = await import("@/lib/prisma"));
    const settlement = await import("@/lib/booking-modification-settlement");
    const original = settlement.executeBookingModificationRefund;
    const spy = vi.spyOn(settlement, "executeBookingModificationRefund").mockImplementation((input) => {
      if (input.bookingId === BOOKING) throw CRASH;
      return original(input);
    });
    restoreInline = () => spy.mockRestore();
    dates = await import("@/lib/booking-date-modification-service");
    batches = await import("@/lib/booking-batch-modification-service");
    removal = await import("@/lib/booking-guest-removal-service");
    acceptance = await import("@/lib/booking-guest-acceptance-reprice");
    keys = await import("@/lib/payment-recovery-keys");
    handBackKeys = await import("@/lib/manual-refund-task-settlement-rules");
    confirmation = await import("@/lib/booking-ledger-confirmation-sync");
    clubTime = await import("@/lib/club-time");
    money = await import("@/lib/member-money");
    await clean();
    for (const [id, memberRole] of [[OWNER, Role.USER], [OFFICER, Role.ADMIN], [GUEST_MEMBER, Role.USER]] as const) {
      await prisma.member.upsert({ where: { id }, create: {
        id, email: `${id}@example.invalid`, passwordHash: "not-a-password", firstName: "Refund", lastName: "Proof",
        ageTier: "ADULT", role: memberRole, canLogin: true,
      }, update: {} });
    }
    await prisma.memberAccessRole.upsert({ where: { memberId_role: { memberId: OFFICER, role: "ADMIN" } }, create: { memberId: OFFICER, role: "ADMIN" }, update: {} });
    await prisma.lodge.upsert({ where: { id: LODGE }, create: { id: LODGE, name: "Refund crash proof", slug: "race-4992" }, update: {} });
    await prisma.lodgeSettings.upsert({ where: { id: LODGE }, create: { id: LODGE, lodgeId: LODGE, capacity: 20 }, update: {} });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE, daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100 } });
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
    await prisma.season.deleteMany({ where: { id: SEASON } });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({ data: {
      id: SEASON, lodgeId: LODGE, name: "Refund crash proof", type: "WINTER", startDate: N1, endDate: END, active: true,
      membershipTypeRates: { create: [{ membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: 5_000 }, { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: 5_000 }] },
    } });
  }, 120_000);

  beforeEach(async () => {
    resetStripeRaceHooks();
    await clean();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
      await prisma.season.deleteMany({ where: { id: SEASON } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE } });
      await prisma.lodge.deleteMany({ where: { id: LODGE } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER, OFFICER, GUEST_MEMBER] } } });
    } finally {
      resetStripeRaceHooks();
      restoreInline?.();
      role?.restore();
    }
  });

  it("date change commits its frozen debt before the inline refund entry", async () => {
    await seed();
    await expect(dates.modifyBookingDates({
      bookingId: BOOKING, actor: { id: OFFICER, role: Role.ADMIN },
      input: { checkIn: "2026-09-01", checkOut: "2026-09-02", settlementMethod: "card" }, ipAddress: "127.0.0.1",
    })).rejects.toBe(CRASH);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING } })).finalPriceCents).toBe(10_000);
    await debt("mod_dates_refund");
  });

  it("the runner replays the crashed edit's frozen plan once, under the inline attempt's keys and reason", async () => {
    await seed();
    await expect(dates.modifyBookingDates({
      bookingId: BOOKING, actor: { id: OFFICER, role: Role.ADMIN },
      input: { checkIn: "2026-09-01", checkOut: "2026-09-02", settlementMethod: "card" }, ipAddress: "127.0.0.1",
    })).rejects.toBe(CRASH);
    const row = await debt("mod_dates_refund");
    const sent: Array<{ key: string | undefined; intent: string; cents: number; reason: string | undefined }> = [];
    stripeRaceHooks.refund = async (args) => {
      sent.push({ key: args.idempotencyKey, intent: args.paymentIntentId, cents: args.amountCents, reason: args.metadata?.reason });
      return {
        id: `re_race_4992_${sent.length}`, object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
        created: Math.floor(TODAY.getTime() / 1000), charge: `ch_race_4992_${sent.length}`, payment_intent: args.paymentIntentId,
        metadata: args.metadata ?? {},
      };
    };
    const { processPaymentRecoveryOperations } = await import("@/lib/payment-recovery");
    await processPaymentRecoveryOperations({ limit: 50 });
    const reason = keys.bookingModificationRefundReasonForKeyPrefix(row.stripeKeyPrefix);
    expect(reason).toBe("date_change_price_decrease");
    expect(sent).toEqual([
      { key: keys.refundSliceStripeIdempotencyKey(row.stripeKeyPrefix!, { paymentTransactionId: ADDITIONAL, amountCents: 6_000 }), intent: "pi_race_4992_additional", cents: 6_000, reason },
      { key: keys.refundSliceStripeIdempotencyKey(row.stripeKeyPrefix!, { paymentTransactionId: PRIMARY, amountCents: 4_000 }), intent: "pi_race_4992_primary", cents: 4_000, reason },
    ]);
    expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SUCCEEDED" });

    await processPaymentRecoveryOperations({ limit: 50 });
    expect(sent).toHaveLength(2);
  });

  it("standalone batch commits its frozen debt before the inline refund entry", async () => {
    await seed();
    await expect(batches.modifyBookingBatch(batchArgs())).rejects.toBe(CRASH);
    expect(await prisma.bookingGuest.count({ where: { id: LEAVING } })).toBe(0);
    await debt("mod_batch_refund");
  });

  it("caller-transaction batch commits the debt without running deferred post-commit work", async () => {
    await seed();
    const preTransaction = await batches.prepareBatchModificationForCallerTransaction({ audience: "admin" });
    const result = await prisma.$transaction((tx) => batches.modifyBookingBatch({ ...batchArgs(), tx, preTransaction }), { timeout: 20_000 });
    expect(result.deferredPostCommit).toBeTypeOf("function");
    await debt("mod_batch_refund");
  });

  it("guest removal through the route's service commits its frozen debt before any after-commit work", async () => {
    await seed();
    const result = await remove("card");
    expect(result.pendingRefundAmountCents).toBe(10_000);
    expect(await prisma.bookingGuest.count({ where: { id: LEAVING } })).toBe(0);
    await debt("guest_remove_refund");
  });

  it("guest acceptance re-price commits its frozen debt in the consent transaction", async () => {
    await seed();
    const result = await acceptLeavingGuest();
    expect(result).toMatchObject({ repriced: true, pendingRefundAmountCents: 20_000 });
    await debt("guest_accept_refund", 20_000);
  });

  it("a card refund payable in the journal has the edit's card debt behind it, for the same amount (#5212)", async () => {
    await seed("STRIPE", { journaled: true });
    await expect(dates.modifyBookingDates({
      bookingId: BOOKING, actor: { id: OFFICER, role: Role.ADMIN },
      input: { checkIn: "2026-09-01", checkOut: "2026-09-02", settlementMethod: "card" }, ipAddress: "127.0.0.1",
    })).rejects.toBe(CRASH);
    const row = await debt("mod_dates_refund");
    expect(await expectJournalAndDebtsAgree()).toEqual([{ modificationId: row.idempotencyKey.replace(keys.BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX, ""), faceCents: 10_000 }]);
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING } })).toBe(0);
  });

  describe("a card payment with no Stripe record is paid back by hand, with no card refund payable (#5212)", () => {
    beforeEach(() => seed("NO_STRIPE_RECORD", { journaled: true }));

    it("date change", async () => {
      await expect(dates.modifyBookingDates({
        bookingId: BOOKING, actor: { id: OFFICER, role: Role.ADMIN },
        input: { checkIn: "2026-09-01", checkOut: "2026-09-02", settlementMethod: "card" }, ipAddress: "127.0.0.1",
      })).rejects.toBe(CRASH);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING } })).finalPriceCents).toBe(10_000);
      await handedBackWithNoCardDebt();
    });

    it("batch edit", async () => {
      await expect(batches.modifyBookingBatch(batchArgs())).rejects.toBe(CRASH);
      expect(await prisma.bookingGuest.count({ where: { id: LEAVING } })).toBe(0);
      await handedBackWithNoCardDebt();
    });

    it("guest removal", async () => {
      const result = await remove("card");
      expect(result).toMatchObject({ pendingRefundAmountCents: 0, refundAmountCents: 10_000, hasSucceededPayment: false });
      await handedBackWithNoCardDebt();
    });

    it("guest acceptance re-price", async () => {
      const result = await acceptLeavingGuest();
      expect(result).toMatchObject({ repriced: true, pendingRefundAmountCents: 0, refundAmountCents: 20_000, bankTransferRefundPayee: "member" });
      await handedBackWithNoCardDebt(20_000);
    });

    it("a captured ledger row that names no intent is still no card to refund", async () => {
      await clean();
      await seed("NO_STRIPE_RECORD", { journaled: true, intentlessCapture: true });
      const result = await remove("card");
      expect(result).toMatchObject({ pendingRefundAmountCents: 0, refundAmountCents: 10_000, hasSucceededPayment: false });
      await handedBackWithNoCardDebt();
    });

    it("account credit is still the member's to choose, and owes nothing by hand or by card", async () => {
      await clean();
      await seed("NO_STRIPE_RECORD", { journaled: true, intentlessCapture: true });
      const result = await remove("credit");
      expect(result).toMatchObject({ pendingRefundAmountCents: 0, accountCreditAmountCents: 10_000 });
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING } })).toBe(0);
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(0);
      expect(await expectJournalAndDebtsAgree()).toEqual([]);
    });
  });

  it("caller rollback after the batch reserve rolls the debt and edit back together", async () => {
    await seed();
    const preTransaction = await batches.prepareBatchModificationForCallerTransaction({ audience: "admin" });
    const rolledBack = new Error("caller rejects after reserve");
    await expect(prisma.$transaction(async (tx) => {
      await batches.modifyBookingBatch({ ...batchArgs(), tx, preTransaction });
      expect(await tx.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(1);
      throw rolledBack;
    }, { timeout: 20_000 })).rejects.toBe(rolledBack);
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING } })).toBe(0);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING } })).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { id: LEAVING } })).toBe(1);
  });

  it.each(["credit", "bank", "zero"] as const)("%s reduction writes no own-card debt", async (shape) => {
    await seed(shape === "bank" ? "INTERNET_BANKING" : "STRIPE");
    if (shape === "zero") await prisma.cancellationPolicy.updateMany({ where: { lodgeId: LODGE }, data: { refundPercentage: 0, creditRefundPercentage: 0 } });
    const result = await remove(shape === "credit" ? "credit" : "card");
    expect(result.pendingRefundAmountCents).toBe(0);
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(0);
    if (shape === "zero") await prisma.cancellationPolicy.updateMany({ where: { lodgeId: LODGE }, data: { refundPercentage: 100, creditRefundPercentage: 100 } });
  });

  // #4516 x #4992 (focused review of the merge with #5126): an edit on a booking whose journal is active posts the
  // debt its own door owes, and only that one.
  it("bank guest removal on a journal-era booking posts one hand-back R05 for the task's cents and no card debt", async () => {
    await seed("INTERNET_BANKING");
    await postR01();
    const result = await remove("card");
    expect(result.pendingRefundAmountCents).toBe(0);
    const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING } });
    const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING }, select: { id: true, amountCents: true } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.amountCents).toBe(10_000);
    expect(await refundDebts("hand-back", tasks[0]!.id)).toEqual([
      { obligationKey: money.memberMoneyEventKeys.refundObligation("hand-back", tasks[0]!.id), faceCents: tasks[0]!.amountCents },
    ]);
    expect(await refundDebts("modification", modification.id)).toEqual([]);
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(0);
  });

  it("card guest removal on a journal-era booking posts one modification R05 for the frozen debt and no hand-back", async () => {
    await seed();
    await postR01();
    const result = await remove("card");
    expect(result.pendingRefundAmountCents).toBe(10_000);
    const modification = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: BOOKING } });
    const row = await debt("guest_remove_refund");
    expect(await refundDebts("modification", modification.id)).toEqual([
      { obligationKey: money.memberMoneyEventKeys.refundObligation("modification", modification.id), faceCents: row.amountCents },
    ]);
    expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING } })).toBe(0);
    expect(await prisma.memberMoneyObligation.count({ where: { obligationKey: { contains: "|hand-back|" }, lines: { some: { bookingId: BOOKING } } } })).toBe(0);
  });

  it.each(["CONSENT_DECLINE", "CONSENT_EXPIRY"] as const)("%s cannot silently commit an own-card refund debt", async (kind) => {
    await seed();
    await prisma.bookingGuest.update({ where: { id: LEAVING }, data: { memberId: GUEST_MEMBER, isMember: true, consentStatus: kind === "CONSENT_DECLINE" ? "DECLINED" : "EXPIRED" } });
    const authority = { kind, guestId: LEAVING, targetMemberId: GUEST_MEMBER };
    if (kind === "CONSENT_DECLINE") {
      await expect(remove(undefined, authority)).rejects.toThrow("refund or account credit must be chosen");
    } else {
      const result = await remove("credit", authority);
      expect(result.pendingRefundAmountCents).toBe(0);
    }
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING, type: "REFUND_BOOKING_MODIFICATION" } })).toBe(0);
  });
});

describe("#4992 realdb suite environment cleanup", () => {
  it("restores the environment role after its fixture work", () => {
    if (role) expect(process.env.APP_ENVIRONMENT_ROLE).toBe(role.before);
  });
});
