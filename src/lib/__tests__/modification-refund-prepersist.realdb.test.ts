/**
 * #4992: every edit door commits its own-card refund debt before its after-commit
 * work can run. The edit services, payment allocator and recovery writer are
 * real; the inline entry throws to model a process stopping just after commit.
 * Runs only against the guarded, disposable realdb database.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { declareEnvironmentRoleForSuite } from "./helpers/environment-role";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

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
let clubTime: typeof import("@/lib/club-time");
let restoreInline: (() => void) | undefined;
let role: ReturnType<typeof declareEnvironmentRoleForSuite> | undefined;

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

/** $200 paid by two captured slices; either guest's two nights cost $100. */
async function seed(source: "STRIPE" | "INTERNET_BANKING" = "STRIPE"): Promise<void> {
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
    ...(source === "STRIPE" ? { stripePaymentIntentId: "pi_race_4992_primary" } : {}),
  } });
  if (source === "STRIPE") {
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
    tx, door: "guestRemoval", bookingId: BOOKING, guestId: LEAVING, actorMemberId: OFFICER, actorRole: "ADMIN",
    today: TODAY, format: CLUB_FORMAT_TEST, journal: JOURNAL, settlementMethod, consentAuthority,
  }), { maxWait: 10_000, timeout: 20_000 });
}

(RUN ? describe : describe.skip)("#4992 edit refund debt survives the post-commit crash window — real PostgreSQL", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "#4992 edit refund proofs");
    process.env.DATABASE_URL = RACE_DB_URL;
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
    clubTime = await import("@/lib/club-time");
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

  beforeEach(clean);

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
    // The accepted guest now qualifies for the booking's existing $100 code.
    await prisma.bookingGuest.update({ where: { id: LEAVING }, data: { memberId: GUEST_MEMBER, isMember: true, consentStatus: "CONFIRMED" } });
    await prisma.promoCode.create({ data: { id: PROMO, code: "RACE4992", type: "FIXED_AMOUNT", valueCents: 10_000 } });
    await prisma.promoRedemption.create({ data: { promoCodeId: PROMO, bookingId: BOOKING, memberId: OWNER, discountCents: 0, guestTargets: { create: { bookingId: BOOKING, bookingGuestId: LEAVING } } } });
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const { acquireLodgeCapacityLock } = await import("@/lib/capacity");
      await acquireLodgeCapacityLock(tx, LODGE);
      return acceptance.repriceBookingAfterGuestAcceptance(tx, {
        bookingId: BOOKING, acceptedGuestId: LEAVING, actorMemberId: GUEST_MEMBER,
        todayAtClub: clubTime.requireCalendarDate("2026-07-01"), format: CLUB_FORMAT_TEST, journal: JOURNAL,
      });
    }, { timeout: 20_000 });
    expect(result).toMatchObject({ repriced: true, pendingRefundAmountCents: 10_000 });
    await debt("guest_accept_refund");
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
