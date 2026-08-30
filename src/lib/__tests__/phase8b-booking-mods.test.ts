import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockTransaction = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockDeleteMany = vi.fn();
const mockFindMany = vi.fn();
const mockMemberCount = vi.fn();
const mockValidateAndCalculatePromoDiscount = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  })
);
const mockRefundPaymentTransactions = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockCreatePaymentIntent = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockEnqueuePaymentIntentCancellationRecovery = vi.fn();
const mockProcessPaymentRecoveryOperations = vi.fn();
const mockEnqueueXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking_update", message: "queued" });
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);
const mockRecordSkippedXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_skip", message: "skipped" });

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") {
        return (mockTransaction as any)(fn);
      }
      return Promise.resolve();
    },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      // Route-level (outside-transaction) booking read: today only the Xero
      // lock-date guard's advisory pre-read (#1729). Null skips the guard —
      // the in-transaction re-read still owns the 404. mockFindUnique stays
      // the member read these suites program per-test.
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: mockFindMany,
      update: mockUpdate,
    },
    bookingGuest: {
      findMany: mockFindMany,
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    },
    // #3032: the pending-review fence reads this under the booking-edit locks.
    // Empty by default - no financial review is open - so every pre-#3032 test
    // asserts exactly what it asserted before.
    manualRefundTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      // #3032: the modified email asks whether the club is still working
      // out an amount on this booking (`bookingHasOpenFinancialReview`).
      // Empty by default - no review is open - so every pre-#3032
      // assertion in this file means exactly what it meant before.
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingModification: { create: mockCreate },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    promoRedemption: { delete: mockDelete },
    promoCode: { update: mockUpdate },
    choreAssignment: { findMany: mockFindMany, delete: mockDelete, deleteMany: mockDeleteMany },
    season: { findMany: mockFindMany },
    payment: { update: mockUpdate },
    member: { count: mockMemberCount, findUnique: mockFindUnique, findMany: mockFindMany },
    familyGroupMember: { findMany: mockFindMany },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // #1982: default lodge capacity is a self-healed DB override (the route's
    // getDefaultLodgeCapacity guest-count guard reads it off the singleton).
    lodgeSettings: { findUnique: async () => ({ capacity: 29 }) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn(),
  calculatePromoDiscount: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: vi.fn() }));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  getNonMemberHoldDays: vi.fn(),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
  calculateDualRefundAmounts: vi.fn(),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn(),
  validateAndCalculatePromoDiscount: mockValidateAndCalculatePromoDiscount,
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  // #2299: the promo path row-locks each PromoCode it may charge or
  // refund before reading or writing any usage cap; the reprice paths also
  // re-read the usage counter under that lock.
  lockPromoCodeRowsForUpdate: vi.fn(),
  lockAndRefreshPromoCodeUsage: vi.fn(
    async (_tx: unknown, promoCode: unknown) => promoCode
  ),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  createPaymentIntent: (...args: unknown[]) => mockCreatePaymentIntent(...args),
  findOrCreateCustomer: (...args: unknown[]) => mockFindOrCreateCustomer(...args),
}));
vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminMinorsOnlyReviewAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mockEnqueuePaymentIntentCancellationRecovery(...args),
  processPaymentRecoveryOperations: (...args: unknown[]) =>
    mockProcessPaymentRecoveryOperations(...args),
  enqueueBookingModificationRefundRecovery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn().mockResolvedValue({ id: "credit_1" }),
  deriveBookingAppliedCreditCents: vi.fn().mockResolvedValue(0),
  clampAppliedCreditToBookingPrice: vi.fn().mockResolvedValue({
    appliedCreditCents: 0,
    refundedExcessCents: 0,
  }),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceUpdateOperation: mockEnqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation: mockRecordSkippedXeroBookingInvoiceUpdateOperation,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// #2104: the batch modify route delegates to modifyBookingBatch; mocked here so
// the review-justification-required error can be surfaced through the route's
// catch block without standing up the full batch service. The modify-dates /
// guests routes exercised elsewhere in this file never touch this service.
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: vi.fn(),
}));

import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import { calculateBookingPrice } from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
  getNonMemberHoldPolicy,
  calculateDualRefundAmounts,
} from "@/lib/cancellation";
import { validateAndCalculatePromoDiscount, validatePromoCodeRules } from "@/lib/promo";
import { processRefund } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { BookingModifyReviewJustificationRequiredError } from "@/lib/booking-modify-validation";

const mockedModifyBatch = vi.mocked(modifyBookingBatch);

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedCalcChangeFee = vi.mocked(calculateChangeFee);
const mockedDaysUntilDate = vi.mocked(daysUntilDate);
const mockedLoadPolicy = vi.mocked(loadCancellationPolicy);
const mockedCalcDualRefund = vi.mocked(calculateDualRefundAmounts);
const mockedProcessRefund = vi.mocked(processRefund);
const mockedGetHoldDays = vi.mocked(getNonMemberHoldDays);
const mockedGetHoldPolicy = vi.mocked(getNonMemberHoldPolicy);
const mockedValidatePromo = vi.mocked(validatePromoCodeRules);
const mockedValidateAndCalculatePromo = vi.mocked(validateAndCalculatePromoDiscount);

const TEST_NOW = new Date("2026-05-20T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Complete a fixture's guest rows into the shape the hosting review actually
 * loads (#2675).
 *
 * Beyond the name and id these fixtures already carry, `BOOKING_HOSTING_SELECT`
 * (adult-member-hosting-review.ts) hydrates five more facts off every booking
 * guest — `stayStart`, `stayEnd`, `nights`, `consentStatus` and the live `member`
 * relation — and `toHostingParticipants` reads all five the moment the lodge's
 * mode is active. No fixture in this file carried any of them, because with the
 * tx double answering `adultMemberHostingPolicy.findMany -> []` the resolved mode
 * was DISABLED, the reconciler took its early return, and the evaluator never
 * ran. Two of the five do NOT degrade gracefully:
 *
 *  - `nights` is dereferenced as `guest.nights.length`, so `undefined` throws a
 *    TypeError. `[]` is legitimate — it is the pre-#713 row shape — and falls
 *    back to the guest's own `stayStart`..`stayEnd` envelope.
 *  - `member` is tested with `member !== null && member.active === true`
 *    (`memberIsInGoodStanding`), and `undefined !== null` is TRUE, so a MISSING
 *    key reads `undefined.active` and throws rather than treating the guest as a
 *    non-member.
 *
 * `member` is derived from `memberId` and never from the `isMember` snapshot
 * beside it, because that is the only pairing production can emit: the relation
 * IS the foreign key. A guest with a `memberId` therefore gets an adult member
 * row in good standing — the shape that qualifies as a host, so a fixture whose
 * party is member-linked raises no hosting hazard and behaves exactly as it did
 * with the rule off — and a guest without one gets an explicit `null`.
 *
 * The guest's own values always win: a fixture that states its stay window or
 * its per-night rows keeps them, and only the absent facts are filled in.
 *
 * THE GUEST'S OWN `ageTier` IS CARRIED ONTO THE MEMBER ROW (#2675 review).
 * `BookingGuest.ageTier` and `Member.ageTier` are separate columns that a real
 * row always agrees on, and it is the MEMBER's that
 * `participantQualifiesAsHost` reads. Letting `hostingMemberRow` fall back to
 * its ADULT default would score a member-linked CHILD or YOUTH guest as an
 * adult host and quietly suppress a hosting violation production would raise —
 * an ADULT Member row hanging off a CHILD guest row being precisely the
 * "shape production cannot emit" this whole helper exists to stop.
 */
function completeHostingGuestRows<
  T extends { memberId?: string | null; ageTier?: string; priceCents?: number },
>(guests: readonly T[], checkIn: Date, checkOut: Date) {
  return guests.map((guest) => {
    const stayStart = (guest as { stayStart?: Date }).stayStart ?? checkIn;
    const stayEnd = (guest as { stayEnd?: Date }).stayEnd ?? checkOut;
    return {
      // A guest with no stay window of its own stays the whole booking, which is
      // what every route in this file assumes when it reprices the full party.
      stayStart,
      stayEnd,
      // #3031: and a per-night SOLD PRICE that reconciles to the guest's stored
      // total. `[]` used to be the default, and it was the pre-#713 row shape -
      // legitimate then, and the unpriceable case now: an edit that gives a
      // night back reads what it was sold for off these rows and refuses to
      // invent an amount when there is nothing to read. Production has carried
      // rows for every guest since the #2739 backfill, so filling them in makes
      // these fixtures MORE like a live booking, not less. A fixture that states
      // its own `nights` still wins, including one that deliberately states none.
      nights: syntheticSoldNightRows(stayStart, stayEnd, guest.priceCents),
      // `null` = no consent was ever needed, which is operationally present (D-12)
      // and the right default for an ordinary guest row.
      consentStatus: null as string | null,
      ...guest,
      member:
        typeof guest.memberId === "string"
          ? hostingMemberRow(
              guest.memberId,
              guest.ageTier ? { ageTier: guest.ageTier } : {},
            )
          : null,
    };
  });
}

/**
 * `BookingGuestNight` rows for `[stayStart, stayEnd)` that sum EXACTLY to
 * `priceCents` (#3031).
 *
 * AN EVEN SPLIT, DELIBERATELY, and it is not the estimator #3031 removes. It
 * mirrors what migrations `20260704150000` (#1098) and `20260810010000` (#2739)
 * really wrote into this table for guests who had no rows: the stored total
 * divided by the night count with the remainder on the first night. So a fixture
 * built this way is the shape a large share of live bookings genuinely carries,
 * which is exactly why INV-MOD-028 tests RECONCILIATION rather than provenance —
 * these rows reconcile, and the invariant says in as many words that an evenly
 * split backfilled strand prices as exact.
 *
 * What matters here is that the rows reconcile to the stored total, because that
 * is the test an edit applies before it will price anything. A guest with no
 * stored total gets no rows - there is nothing to allocate - and that fixture is
 * then deliberately in the unpriceable case.
 */
function syntheticSoldNightRows(
  stayStart: Date,
  stayEnd: Date,
  priceCents: number | undefined,
): Array<{ stayDate: Date; priceCents: number }> {
  if (typeof priceCents !== "number") return [];
  const nights: Date[] = [];
  for (
    let night = new Date(stayStart);
    night < stayEnd;
    night = new Date(night.getTime() + 86_400_000)
  ) {
    nights.push(new Date(night));
  }
  if (nights.length === 0) return [];
  const base = Math.floor(priceCents / nights.length);
  const remainder = priceCents - base * nights.length;
  return nights.map((stayDate, index) => ({
    stayDate,
    priceCents: base + (index === 0 ? remainder : 0),
  }));
}

// Helper to make a booking object
function makeBooking(overrides: Record<string, unknown> = {}) {
  const booking = {
    id: "bk1",
    memberId: "m1",
    // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
    // one. Omitting it here let the hosting participant fence compare
    // "bk1:m1:undefined" on both sides and pass vacuously (#2619).
    lodgeId: "lodge-1",
    checkIn: new Date("2026-06-01"),
    checkOut: new Date("2026-06-03"),
    status: "CONFIRMED",
    totalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
      { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: null, priceCents: 5000 },
    ],
    payment: { id: "p1", bookingId: "bk1", amountCents: 10000, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_123", xeroInvoiceId: "inv_primary", refundedAmountCents: 0, changeFeeCents: 0 },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
  // #2675: applied AFTER the overrides, so a scenario that supplies its own
  // guest list is completed too — otherwise the fixtures that override `guests`
  // (most of the interesting ones) would still crash the evaluator.
  return {
    ...booking,
    guests: completeHostingGuestRows(
      booking.guests,
      booking.checkIn,
      booking.checkOut,
    ),
  };
}

// Create a mock tx that behaves like prisma inside a transaction
function makeTx(booking: ReturnType<typeof makeBooking>) {
  // #2619: every booking write reconciles the hosting review, and that
  // reconciliation opens by locking the queue participants FOR KEY SHARE NOWAIT
  // and re-reading them under that lock. `recordingBookingDouble` replays what
  // this tx's own `booking.findUnique` served, so the fence's owner/lodge
  // re-read matches the source the reconciler planned from — a real no-drift
  // pass, not a bypass.
  const fenceBooking = recordingBookingDouble(async () => booking);
  return {
    // #1881 — the date/batch service takes the global lock(1) via $executeRaw.
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: async () => ({ capacity: 29 }) },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode, because the gate now standing in front
    // of the participant fence returns early on an inactive one. `[]` resolved
    // to DISABLED, so every booking write in this file took that early return
    // and the #2619 fence doubles beside it exercised nothing.
    //
    // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: under
    // ENFORCED a hosting hazard REFUSES the booking write by throwing, which
    // would change what these scenarios assert; under review-only the hazard is
    // recorded and the write proceeds, and the fence is owed either way (see
    // `hostingModeIsActive` at the gate).
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      update: vi.fn().mockImplementation(({ data }) => {
        const updated = { ...booking, ...data, guests: booking.guests };
        return Promise.resolve(updated);
      }),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // #3032: the pending-review fence reads this under the booking-edit locks.
    // Empty by default - no financial review is open - so every pre-#3032 test
    // asserts exactly what it asserted before.
    manualRefundTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      // #3032: the modified email asks whether the club is still working
      // out an amount on this booking (`bookingHasOpenFinancialReview`).
      // Empty by default - no review is open - so every pre-#3032
      // assertion in this file means exactly what it meant before.
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod1" }),
    },
    bookingRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    payment: {
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({ id: "p1" }),
    },
    paymentTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      // Answers the fence's ids-only existence/order re-read and nothing else;
      // every other member.findMany still resolves to [] as before.
      findMany: fenceMemberFindMany(),
    },
    // #1930, E4 — the rate resolver reads these to key rates by membership type.
    seasonalMembershipAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "type-member",
          key: "FULL",
          name: "Full",
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: "MEMBER_RATE",
          subscriptionBehavior: "REQUIRED",
        },
        {
          id: "type-nonmember",
          key: "NON_MEMBER",
          name: "Non-Member",
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: "NON_MEMBER_RATE",
          subscriptionBehavior: "NOT_REQUIRED",
        },
      ]),
    },
    familyGroupMember: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([{
        id: "s1",
        startDate: new Date("2026-04-01"),
        endDate: new Date("2026-10-31"),
        // Membership-type-keyed rates (#1930, E4). calculateBookingPrice is
        // mocked in this suite, so these only need to satisfy the season loader.
        membershipTypeRates: [
          { membershipTypeId: "type-member", ageTier: "ADULT", pricePerNightCents: 5000 },
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 },
          { membershipTypeId: "type-member", ageTier: "YOUTH", pricePerNightCents: 3000 },
          { membershipTypeId: "type-member", ageTier: "CHILD", pricePerNightCents: 2000 },
        ],
      }]),
    },
    promoRedemption: {
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    promoCode: {
      update: vi.fn().mockResolvedValue({}),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

// --- Tests ---

/**
 * #2675 review — the hosting fixture completion must not invent an ADULT member.
 *
 * `completeHostingGuestRows` synthesises the live `Member` relation from
 * `memberId`, and `hostingMemberRow` defaults to ADULT. Deriving it from the id
 * alone would score any member-linked CHILD or YOUTH guest as an adult host at
 * `participantQualifiesAsHost` — which reads the MEMBER's tier, not the guest
 * row's — and suppress a hosting violation production would raise, with nothing
 * in this file failing.
 */
describe("completeHostingGuestRows (#2675)", () => {
  it("carries the guest's own age tier onto the Member row it synthesises", () => {
    const rows = completeHostingGuestRows(
      [
        { id: "g1", memberId: "m-adult", ageTier: "ADULT" },
        { id: "g2", memberId: "m-child", ageTier: "CHILD" },
        { id: "g3", memberId: null, ageTier: "CHILD" },
      ],
      new Date("2026-06-01"),
      new Date("2026-06-03"),
    );

    expect(rows[0].member).toEqual(
      expect.objectContaining({ id: "m-adult", ageTier: "ADULT" }),
    );
    expect(rows[1].member).toEqual(
      expect.objectContaining({ id: "m-child", ageTier: "CHILD" }),
    );
    // A true non-member gets an EXPLICIT null, never a partial row: the standing
    // predicate tests `member !== null`, so an absent key throws instead.
    expect(rows[2].member).toBeNull();
  });

  it("still defaults to ADULT for a guest row that states no tier", () => {
    const [row] = completeHostingGuestRows(
      [{ id: "g1", memberId: "m1" }],
      new Date("2026-06-01"),
      new Date("2026-06-03"),
    );
    expect(row.member).toEqual(
      expect.objectContaining({ id: "m1", ageTier: "ADULT" }),
    );
  });
});

describe("PUT /api/bookings/[id]/modify-dates", () => {
  let PUT: typeof import("@/app/api/bookings/[id]/modify-dates/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      forcePasswordChange: false,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    const mod = await import("@/app/api/bookings/[id]/modify-dates/route");
    PUT = mod.PUT;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 if neither checkIn nor checkOut provided", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 if booking not found", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("locks kept nights' stored prices across a date change (#1036)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [
        {
          id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith",
          ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 10000,
          nights: [
            { stayDate: new Date("2026-06-01"), priceCents: 5000 },
            { stayDate: new Date("2026-06-02"), priceCents: 5000 },
          ],
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as any);
    mockedCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as any);
    mockedCalcPrice.mockImplementation(((_ci: unknown, _co: unknown, guests: unknown[]) => ({
      totalPriceCents: guests.length * 15000,
      guests: guests.map(() => ({
        priceCents: 15000,
        perNightCents: [5000, 5000, 5000],
        nightDates: [],
      })),
    })) as any);
    mockedCalcChangeFee.mockResolvedValue({ changeFeeCents: 0 } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-04" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    const [, , pricedGuests] = mockedCalcPrice.mock.calls.at(-1) ?? [];
    expect(pricedGuests?.[0]).toEqual(
      expect.objectContaining({
        lockedNightPrices: [
          expect.objectContaining({ priceCents: 5000 }),
          expect.objectContaining({ priceCents: 5000 }),
        ],
      }),
    );
  });

  it("blocks date changes on a quote-priced booking (#1032)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const tx = makeTx(makeBooking());
    // The booking was converted from (or held for) a booking request: its
    // negotiated flat price must not be silently repriced at season rates.
    tx.bookingRequest.findFirst.mockResolvedValue({ id: "req_1" });
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("negotiated booking-request price"),
    });
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it("returns 403 for deactivated members before modifying dates", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockFindUnique.mockResolvedValueOnce({
      id: "m1",
      active: false,
      forcePasswordChange: false,
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 403 if not booking owner or admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 for CANCELLED booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking({ status: "CANCELLED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if checkOut <= checkIn", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-03" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if capacity not available", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: 0, nightDetails: [] });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-07" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Not enough beds");
  });

  it("successfully modifies dates with price recalculation", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }]);
    mockedGetHoldDays.mockResolvedValue(7);

    // Mock member lookup for email
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(20000); // 30000 - 10000
    expect(body.changeFeeCents).toBe(0);
  });

  it("writes the moved range's night rows at the amounts it priced (#3031)", async () => {
    // THE CONTROL for the refusal below, and the reason the refusal cannot pass
    // against a function that simply always throws: given a complete per-night
    // vector, this writer stores exactly those amounts against exactly those
    // nights. `BookingGuestNight` rows ARE the booking's sold-price history from
    // here on, so what lands here is what the NEXT edit reads back as evidence
    // (INV-MOD-028).
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    const movedNights = [
      new Date("2026-06-05T00:00:00.000Z"),
      new Date("2026-06-06T00:00:00.000Z"),
      new Date("2026-06-07T00:00:00.000Z"),
    ];
    // Deliberately UNEQUAL: an even split of 15000 across three nights would be
    // 5000/5000/5000 and would satisfy a weaker assertion just as well.
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [4000, 5000, 6000], nightDates: movedNights },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [4000, 5000, 6000], nightDates: movedNights },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });

    expect(res.status).toBe(200);
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        { bookingGuestId: "g1", stayDate: movedNights[0], priceCents: 4000 },
        { bookingGuestId: "g1", stayDate: movedNights[1], priceCents: 5000 },
        { bookingGuestId: "g1", stayDate: movedNights[2], priceCents: 6000 },
      ],
    });
  });

  it("refuses to write a moved night the reprice put no amount against (#3031)", async () => {
    // The prohibited answer is `?? 0`, which this writer carried until #3031: a
    // per-night vector shorter than the night list would put a REAL night into
    // the sold-price history at zero, and the next edit would credit it back at
    // nothing. Refusing is the only answer that neither invents money nor
    // silently loses it. Nothing must be committed either.
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    const movedNights = [
      new Date("2026-06-05T00:00:00.000Z"),
      new Date("2026-06-06T00:00:00.000Z"),
      new Date("2026-06-07T00:00:00.000Z"),
    ];
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000], nightDates: movedNights },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000], nightDates: movedNights },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "The new dates could not be priced night by night",
    );
    expect(tx.bookingGuestNight.createMany).not.toHaveBeenCalled();
  });

  it("processes Stripe refund on price decrease for confirmed+paid booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    // Shorter stay = cheaper
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 1, priceCents: 2500, perNightCents: [2500], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 1, priceCents: 2500, perNightCents: [2500], nightDates: [] },
      ],
      totalPriceCents: 5000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([
      {
        daysBeforeStay: 0,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ] as any);
    // Date reductions now settle through the shared policy machinery (#1024);
    // a 100% tier keeps the full 5000 refund.
    mockedCalcDualRefund.mockReturnValue({
      cardRefundAmountCents: 5000,
      cardRefundPercentage: 100,
      creditRefundAmountCents: 5000,
      creditRefundPercentage: 100,
    } as any);
    mockedGetHoldDays.mockResolvedValue(7);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [
        {
          paymentIntentId: "pi_123",
          refundId: "re_123",
          amountCents: 5000,
        },
      ],
      totalRefundedAmountCents: 5000,
    });
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-02", settlementMethod: "card" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refundAmountCents).toBe(5000);
    expect(body.stripeRefundId).toBe("re_123");
    expect(mockRefundPaymentTransactions).toHaveBeenCalledOnce();
  });

  it("calculates change fee when check-in moves to lenient tier", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 5000, fromTierRefundPct: 0, toTierRefundPct: 50 });
    mockedDaysUntilDate.mockReturnValue(5);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }, { daysBeforeStay: 7, refundPercentage: 50 }, { daysBeforeStay: 0, refundPercentage: 0 }]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-20", checkOut: "2026-06-22" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changeFeeCents).toBe(5000);
  });

  it("admin can modify other members booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
  });

  it("removes invalid promo and sets promoRemoved flag", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      discountCents: 1000,
      finalPriceCents: 9000,
      promoRedemption: {
        id: "pr1",
        promoCodeId: "pc1",
        promoCode: { id: "pc1", active: false, validFrom: null, validUntil: null, maxRedemptions: null, currentRedemptions: 1, membersOnly: false, singleUse: false, type: "PERCENTAGE", percentOff: 10, assignments: [] },
      },
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockedValidatePromo.mockReturnValue("This promo code is no longer active");
    mockedValidateAndCalculatePromo.mockResolvedValueOnce({
      error: "This promo code is no longer active",
      beneficiaryMemberIds: [],
    });
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promoRemoved).toBe(true);
  });

  it("cleans up out-of-range SUGGESTED chore assignments", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.choreAssignment.findMany.mockResolvedValue([
      { id: "ca1", status: "SUGGESTED", choreTemplate: { name: "Dishes" }, date: new Date("2026-06-01") },
      { id: "ca2", status: "CONFIRMED", choreTemplate: { name: "Sweep" }, date: new Date("2026-06-01") },
    ]);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-02", checkOut: "2026-06-04" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // SUGGESTED deleted, CONFIRMED kept with warning
    expect(tx.choreAssignment.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "ca1",
        bookingId: booking.id,
        OR: [
          { date: { lt: new Date("2026-06-02T00:00:00.000Z") } },
          // #2622: strictly AFTER the new check-out date. The check-out day is
          // a departure morning the booking's guests are still present for, so
          // a chore dated then is legitimate and must survive the date change.
          { date: { gt: new Date("2026-06-04T00:00:00.000Z") } },
        ],
        status: "SUGGESTED",
      },
    });
    expect(body.choreWarnings).toHaveLength(1);
    expect(body.choreWarnings[0]).toContain("CONFIRMED");
  });

  it("sends audit log and email after successful modification", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.dates" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });

  it("returns 400 for PENDING with non-members modified to check-in within 7 days auto-confirms", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      status: "PENDING",
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-05-25"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: false, rateMembershipTypeId: "type-nonmember", nights: 2, priceCents: 7000, perNightCents: [7000, 7000], nightDates: [] },
      ],
      totalPriceCents: 12000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(3);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    // Check-in 3 days from now (within 7 day hold)
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const soonStr = soon.toISOString().split("T")[0];
    const soonEnd = new Date(soon);
    soonEnd.setDate(soonEnd.getDate() + 2);
    const soonEndStr = soonEnd.toISOString().split("T")[0];

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: soonStr, checkOut: soonEndStr }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    // Immediate-payment bookings do not hold capacity until payment succeeds.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAYMENT_PENDING" }),
      })
    );
  });

  it("rejects a date change that lands a member-linked guest on a night they are already booked (#1157)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);

    // Member m1 (guest g1) is already on another live booking covering the
    // first night of the requested new range (Jun 5). The guard must reject.
    tx.bookingGuest.findMany.mockResolvedValue([
      {
        id: "g-other",
        memberId: "m1",
        firstName: "Alice",
        lastName: "Smith",
        stayStart: new Date("2026-06-05"),
        stayEnd: new Date("2026-06-06"),
        nights: [{ stayDate: new Date("2026-06-05") }],
        member: { firstName: "Alice", lastName: "Smith" },
        booking: {
          id: "bk-other",
          memberId: "m1",
          status: "CONFIRMED",
          checkIn: new Date("2026-06-05"),
          checkOut: new Date("2026-06-06"),
          member: { firstName: "Alice", lastName: "Smith" },
          guests: [{ id: "g-other", memberId: "m1" }],
        },
      },
    ]);

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("BOOKING_MEMBER_NIGHT_CONFLICT");
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toMatchObject({
      memberId: "m1",
      bookingId: "bk-other",
      conflictingNights: ["2026-06-05"],
    });

    // The guard runs before any BookingGuest/BookingGuestNight/Booking write,
    // so a rejected date change persists nothing.
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
    expect(tx.bookingGuestNight.deleteMany).not.toHaveBeenCalled();
    expect(tx.bookingGuestNight.createMany).not.toHaveBeenCalled();
  });

  it("allows a date change when a member-linked guest has no overlapping live night (#1157)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000], nightDates: [] },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "alice@test.com", firstName: "Alice" });

    // Member m1 has another live booking whose window overlaps the new range,
    // but as a gap-stay guest present only on Jun 3 — none of the requested
    // nights (Jun 5-7). The guard evaluates the nights and finds no conflict.
    tx.bookingGuest.findMany.mockResolvedValue([
      {
        id: "g-other",
        memberId: "m1",
        firstName: "Alice",
        lastName: "Smith",
        stayStart: new Date("2026-06-03"),
        stayEnd: new Date("2026-06-06"),
        nights: [{ stayDate: new Date("2026-06-03") }],
        member: { firstName: "Alice", lastName: "Smith" },
        booking: {
          id: "bk-other",
          memberId: "m1",
          status: "CONFIRMED",
          checkIn: new Date("2026-06-03"),
          checkOut: new Date("2026-06-06"),
          member: { firstName: "Alice", lastName: "Smith" },
          guests: [{ id: "g-other", memberId: "m1" }],
        },
      },
    ]);

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(20000); // 30000 - 10000
    // The guard actively evaluated the member's other booking and let the
    // write proceed.
    expect(tx.bookingGuest.findMany).toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalled();
  });
});

describe("POST /api/bookings/[id]/guests", () => {
  let POST: typeof import("@/app/api/bookings/[id]/guests/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    const mod = await import("@/app/api/bookings/[id]/guests/route");
    POST = mod.POST;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty guests array", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("locks existing guests' stored night prices when adding a guest (#1036)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [
        {
          id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith",
          ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000,
          nights: [
            { stayDate: new Date("2026-06-01"), priceCents: 2500 },
            { stayDate: new Date("2026-06-02"), priceCents: 2500 },
          ],
        },
        {
          id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith",
          ageTier: "ADULT", isMember: true, memberId: null, priceCents: 5000,
          nights: [
            { stayDate: new Date("2026-06-01"), priceCents: 2500 },
            { stayDate: new Date("2026-06-02"), priceCents: 2500 },
          ],
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as any);
    mockedCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as any);
    mockedCalcPrice.mockImplementation(((_ci: unknown, _co: unknown, guests: unknown[]) => ({
      totalPriceCents: guests.length * 5000,
      guests: guests.map(() => ({
        priceCents: 5000,
        perNightCents: [2500, 2500],
        nightDates: [],
      })),
    })) as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // The full-party reprice carries the existing guests' locks; the new
    // guest has none, so only they price at current rates.
    const pricedGuestLists = mockedCalcPrice.mock.calls.map((call) => call[2]);
    const fullPartyCall = pricedGuestLists.find((guests) => guests?.length === 3);
    expect(fullPartyCall?.[0]).toEqual(
      expect.objectContaining({
        bookingGuestId: "g1",
        lockedNightPrices: [
          expect.objectContaining({ priceCents: 2500 }),
          expect.objectContaining({ priceCents: 2500 }),
        ],
      }),
    );
    expect(fullPartyCall?.[2]?.lockedNightPrices ?? []).toEqual([]);
  });

  it("moves a pending booking to PAYMENT_PENDING and clears the hold when the policy is disabled on add (#1287)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockedGetHoldPolicy.mockResolvedValueOnce({ enabled: false, holdDays: 7, source: "default" });
    const booking = makeBooking({
      status: "PENDING",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-05-25"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] } as any);
    mockedCalcPrice.mockImplementation(((_ci: unknown, _co: unknown, guests: unknown[]) => ({
      totalPriceCents: guests.length * 6000,
      guests: guests.map(() => ({ priceCents: 6000, perNightCents: [3000, 3000], nightDates: [] })),
    })) as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // First Paid, First In (hold disabled): the provisional hold is dropped and
    // the party goes straight to the normal payment path.
    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.hasNonMembers).toBe(true);
    expect(updateData.status).toBe("PAYMENT_PENDING");
    expect(updateData.nonMemberHoldUntil).toBeNull();
  });

  it("recomputes the hold and keeps the booking pending when the policy is enabled and outside the window on add (#1287)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockedGetHoldPolicy.mockResolvedValueOnce({ enabled: true, holdDays: 7, source: "default" });
    const booking = makeBooking({
      status: "PENDING",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
      hasNonMembers: true,
      // Stale hold from a prior policy; the add must recompute it from checkIn.
      nonMemberHoldUntil: new Date("2026-01-01"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] } as any);
    mockedCalcPrice.mockImplementation(((_ci: unknown, _co: unknown, guests: unknown[]) => ({
      totalPriceCents: guests.length * 6000,
      guests: guests.map(() => ({ priceCents: 6000, perNightCents: [3000, 3000], nightDates: [] })),
    })) as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // Members First, outside the window: stays PENDING with the hold recomputed
    // to checkIn - holdDays (not left at the stale value).
    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.status).toBe("PENDING");
    expect(updateData.nonMemberHoldUntil).toEqual(
      new Date(new Date("2026-06-01").getTime() - 7 * 24 * 60 * 60 * 1000),
    );
  });

  it("blocks adding guests to a quote-priced booking (#1032)", async () => {
    // The repro from the audit: adding one student to a school booking
    // quoted at a negotiated flat total must not reprice all guests at
    // season rates. The edit is refused with an actionable message.
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const tx = makeTx(makeBooking());
    tx.bookingRequest.findFirst.mockResolvedValue({ id: "req_1" });
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Student", ageTier: "CHILD", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("negotiated booking-request price"),
    });
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it("returns 400 when the add-guests request exceeds lodge capacity in one payload", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const guests = Array.from({ length: 30 }, (_, index) => ({
      firstName: `Guest${index}`,
      lastName: "Overflow",
      ageTier: "ADULT",
      isMember: false,
    }));
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(body.details.fieldErrors.guests?.[0]).toBeDefined();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 404 for nonexistent booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 for CANCELLED booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking({ status: "BUMPED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if capacity not available", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: false, minAvailable: 0, nightDetails: [] });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Not enough beds");
  });

  it("returns the shared profile-required shape for incomplete linked member additions", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    tx.familyGroupMember.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.memberId === "m1") {
        return [{ memberId: "m1", familyGroupId: "family-1" }];
      }
      if (args?.where?.familyGroupId?.in) {
        return [
          { memberId: "m1", familyGroupId: "family-1" },
          { memberId: "guest-member-1", familyGroupId: "family-1" },
        ];
      }
      if (args?.where?.memberId?.in) {
        return [
          { memberId: "m1", familyGroupId: "family-1" },
          { memberId: "guest-member-1", familyGroupId: "family-1" },
        ];
      }
      return [];
    });
    tx.member.findMany.mockImplementation(async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? [];
      if (ids.includes("guest-member-1")) {
        return [
          {
            id: "guest-member-1",
            active: true,
            ageTier: "ADULT",
            canLogin: false,
            firstName: "Bob",
            lastName: "Jones",
            phoneCountryCode: "64",
            phoneAreaCode: "27",
            phoneNumber: "4224115",
            dateOfBirth: null,
            streetAddressLine1: "1 Snow Road",
            streetCity: "Taupo",
            streetRegion: "Waikato",
            streetPostalCode: "3330",
            streetCountry: "NZ",
            postalAddressLine1: "1 Snow Road",
            postalCity: "Taupo",
            postalRegion: "Waikato",
            postalPostalCode: "3330",
            postalCountry: "NZ",
            role: "MEMBER",
            profileCompletedAt: null,
            detailsConfirmedAt: null,
            detailsConfirmedByMemberId: null,
            onboardingConfirmedAt: null,
          },
        ];
      }
      if (ids.includes("m1")) {
        return [{ id: "m1", active: true, canLogin: true, ageTier: "ADULT" }];
      }
      return [];
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [
          {
            firstName: "Bob",
            lastName: "Jones",
            ageTier: "ADULT",
            isMember: true,
            memberId: "guest-member-1",
          },
        ],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("GUEST_PROFILE_REQUIRED");
    expect(body.members).toContainEqual(
      expect.objectContaining({
        memberId: "guest-member-1",
        name: "Bob Jones",
        missingFields: expect.arrayContaining(["Date of Birth"]),
        action: "complete_details",
      })
    );
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  });

  it("returns member-night conflicts when adding a linked guest already booked elsewhere", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    tx.member.findMany.mockResolvedValue([
      {
        id: "guest-member-1",
        active: true,
        ageTier: "ADULT",
        firstName: "Bob",
        lastName: "Jones",
      },
    ]);
    tx.bookingGuest.findMany.mockResolvedValue([
      {
        id: "existing-guest",
        memberId: "guest-member-1",
        firstName: "Bob",
        lastName: "Jones",
        stayStart: null,
        stayEnd: null,
        nights: [],
        member: { firstName: "Bob", lastName: "Jones" },
        booking: {
          id: "existing-booking",
          memberId: "other-owner",
          status: "CONFIRMED",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          member: { firstName: "Other", lastName: "Owner" },
          guests: [
            { id: "existing-owner", memberId: "other-owner" },
            { id: "existing-guest", memberId: "guest-member-1" },
          ],
        },
      },
    ]);

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [
          {
            firstName: "Bob",
            lastName: "Jones",
            ageTier: "ADULT",
            isMember: true,
            memberId: "guest-member-1",
          },
        ],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    // #2250: the caller here is an ADMIN acting on behalf, so this row IS
    // entitled — the disclosure scoping must not strip detail an admin
    // resolving the clash needs. (The member-actor case, where none of it
    // crosses the wire, is asserted in batch-modify-payment.test.ts.)
    expect(body).toMatchObject({
      code: "BOOKING_MEMBER_NIGHT_CONFLICT",
      conflicts: [
        expect.objectContaining({
          memberId: "guest-member-1",
          canOpenBooking: true,
          bookingId: "existing-booking",
          bookingOwnerName: "Other Owner",
          guestId: "existing-guest",
        }),
      ],
    });
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  });

  it("successfully adds guests and recalculates price", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    // One full-party pricing pass (#1095): the new guest's price is their
    // slice of the combined breakdown.
    mockedCalcPrice.mockReturnValueOnce({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: false, rateMembershipTypeId: "type-nonmember", nights: 2, priceCents: 14000, perNightCents: [7000, 7000], nightDates: [] },
      ],
      totalPriceCents: 24000,
    });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(14000);
    expect(body.additionalAmountCents).toBe(14000);
    expect(tx.bookingGuest.create).toHaveBeenCalledOnce();
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modificationType: "GUEST_ADD" }),
      })
    );
  });

  it("checks guest-add capacity with existing stay ranges plus full-span new guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          stayStart: new Date("2026-06-01"),
          stayEnd: new Date("2026-06-02"),
          priceCents: 5000,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Bob",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: true,
          memberId: null,
          stayStart: new Date("2026-06-02"),
          stayEnd: new Date("2026-06-03"),
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 0, nightDetails: [] });
    mockedCalcPrice.mockReturnValueOnce({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 1, priceCents: 5000, perNightCents: [5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 1, priceCents: 5000, perNightCents: [5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: false, rateMembershipTypeId: "type-nonmember", nights: 2, priceCents: 14000, perNightCents: [7000, 7000], nightDates: [] },
      ],
      totalPriceCents: 24000,
    });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });

    expect(res.status).toBe(200);
    expect(mockedCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      "lodge-1",
      booking.checkIn,
      booking.checkOut,
      [
        ...booking.guests,
        { stayStart: booking.checkIn, stayEnd: booking.checkOut },
      ],
      "bk1",
      tx
    );
  });

  it("forces typed guest additions to non-member pricing", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice.mockReturnValueOnce({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] },
        { ageTier: "ADULT" as const, isMember: false, rateMembershipTypeId: "type-nonmember", nights: 2, priceCents: 14000, perNightCents: [7000, 7000], nightDates: [] },
      ],
      totalPriceCents: 24000,
    });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "Manual", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // The typed (unlinked) member guest is downgraded to non-member pricing
    // inside the single full-party pass.
    expect(mockedCalcPrice).toHaveBeenNthCalledWith(
      1,
      booking.checkIn,
      booking.checkOut,
      expect.arrayContaining([
        expect.objectContaining({ isMember: false, ageTier: "ADULT", memberId: null }),
      ]),
      expect.any(Array),
      undefined
    );
    expect(tx.bookingGuest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: "Manual",
          lastName: "Guest",
          isMember: false,
          memberId: null,
        }),
      })
    );
  });

  it("no change fee when adding guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice.mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }, { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }, { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }], totalPriceCents: 15000 });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    // Verify no change fee is calculated (calcChangeFee not called)
    expect(mockedCalcChangeFee).not.toHaveBeenCalled();
  });

  it("sends audit log and email after adding guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice.mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }, { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }, { ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }], totalPriceCents: 15000 });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.guests.add" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });
});

describe("DELETE /api/bookings/[id]/guests/[guestId]", () => {
  let DELETE: typeof import("@/app/api/bookings/[id]/guests/[guestId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    // Removal reductions now settle through the shared policy machinery
    // (#1014): default to a 100% card/credit tier so full-refund expectations
    // hold, and let individual tests override for partial-policy cases.
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([
      {
        daysBeforeStay: 0,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ] as any);
    mockedCalcDualRefund.mockImplementation((basisAmountCents: number) => ({
      cardRefundAmountCents: basisAmountCents,
      cardRefundPercentage: 100,
      creditRefundAmountCents: basisAmountCents,
      creditRefundPercentage: 100,
    }));
    const mod = await import("@/app/api/bookings/[id]/guests/[guestId]/route");
    DELETE = mod.DELETE;
  });

  // Removal of a guest from a booking with a captured payment now requires an
  // explicit card/credit election (parity with the batch modify endpoint).
  function deleteWithMethod(
    guestId: string,
    settlementMethod: "card" | "credit" = "card",
  ) {
    return new NextRequest(
      `http://localhost/api/bookings/bk1/guests/${guestId}`,
      {
        method: "DELETE",
        body: JSON.stringify({ settlementMethod }),
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(403);
  });

  it("lets a linked future guest remove themselves from another member's booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "guest-member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      status: "DRAFT",
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1", priceCents: 5000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });

    expect(res.status).toBe(200);
    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: "g2" } });
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: "guest-member-1" }),
      })
    );
  });

  it("does not let a linked guest remove someone else", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "guest-member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1", priceCents: 5000 },
        { id: "g3", bookingId: "bk1", firstName: "Carol", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "member-3", priceCents: 5000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g3", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g3" }) });

    expect(res.status).toBe(403);
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("returns 400 for non-modifiable booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking({ status: "COMPLETED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 if guest not found on booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/nonexistent", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "nonexistent" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Guest not found");
  });

  it("returns 400 when trying to remove last guest", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [{ id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 10000 }],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Cannot remove the last guest");
  });

  it("successfully removes guest and recalculates price", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [
        {
          paymentIntentId: "pi_123",
          refundId: "re_456",
          amountCents: 5000,
        },
      ],
      totalRefundedAmountCents: 5000,
    });
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = deleteWithMethod("g2");
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(-5000);
    expect(body.refundAmountCents).toBe(5000);
    expect(body.stripeRefundId).toBe("re_456");
    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: "g2" } });
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modificationType: "GUEST_REMOVE" }),
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 5000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("warns about CONFIRMED/COMPLETED chore assignments", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.choreAssignment.findMany.mockResolvedValue([
      { id: "ca1", status: "CONFIRMED", choreTemplate: { name: "Dishes" }, date: new Date("2026-06-01") },
    ]);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_789" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = deleteWithMethod("g2");
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choreWarnings).toHaveLength(1);
    expect(body.choreWarnings[0]).toContain("Dishes");
    expect(body.choreWarnings[0]).toContain("CONFIRMED");
  });

  it("no change fee when removing guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_000" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = deleteWithMethod("g2");
    await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(mockedCalcChangeFee).not.toHaveBeenCalled();
  });

  it("updates hasNonMembers when removing only non-member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
      totalPriceCents: 12000,
      finalPriceCents: 12000,
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_nm" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = deleteWithMethod("g2");
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    // Should update hasNonMembers to false
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hasNonMembers: false }),
      })
    );
  });

  it("sends audit log and email after removing guest", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_audit" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = deleteWithMethod("g2");
    await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.guests.remove" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });

  it("limits the refund to the cancellation-policy tier (#1014)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    // 50% card tier inside the window: the 5000 delta returns only 2500,
    // where the pre-fix path refunded the full 5000.
    mockedCalcDualRefund.mockReturnValue({
      cardRefundAmountCents: 2500,
      cardRefundPercentage: 50,
      creditRefundAmountCents: 3750,
      creditRefundPercentage: 75,
    } as any);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [{ paymentIntentId: "pi_123", refundId: "re_pol", amountCents: 2500 }],
      totalRefundedAmountCents: 2500,
    });

    const res = await DELETE(deleteWithMethod("g2", "card"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(-5000);
    expect(body.refundAmountCents).toBe(2500);
    expect(body.policyRetainedAmountCents).toBe(2500);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2500 }),
    );
  });

  it("returns 400 when a settled booking is reduced without a settlement method (#1014)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedCalcDualRefund.mockReturnValue({
      cardRefundAmountCents: 2500,
      cardRefundPercentage: 50,
      creditRefundAmountCents: 3750,
      creditRefundPercentage: 75,
    } as any);

    // Body-less DELETE (the night-conflict self-removal shape) on a booking
    // with a captured payment: must not silently settle the owner's money.
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(400);
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("holds a policy reduction as account credit when credit is elected (#1014)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 2, priceCents: 5000, perNightCents: [5000, 5000], nightDates: [] }],
      totalPriceCents: 5000,
    });
    mockedCalcDualRefund.mockReturnValue({
      cardRefundAmountCents: 2500,
      cardRefundPercentage: 50,
      creditRefundAmountCents: 3750,
      creditRefundPercentage: 75,
    } as any);

    const res = await DELETE(deleteWithMethod("g2", "credit"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refundAmountCents).toBe(0);
    expect(body.accountCreditAmountCents).toBe(3750);
    expect(body.settlementMethod).toBe("credit");
    // Credit is not a Stripe refund.
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    // #1031: the removal path passes the payment so the credit allocates
    // against it in-transaction, keeping refundedAmountCents truthful.
    const { createBookingModificationCredit } = await import("@/lib/member-credit");
    expect(vi.mocked(createBookingModificationCredit)).toHaveBeenCalledWith(
      "m1",
      3750,
      "bk1",
      expect.anything(),
      undefined,
      expect.anything(),
      "p1",
    );
  });

  it("blocks removing a guest from a quote-priced booking (#1032)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.bookingRequest.findFirst.mockResolvedValue({ id: "req_1" });
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const res = await DELETE(deleteWithMethod("g2"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("negotiated booking-request price"),
    });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it("passes stored night prices to the pricing engine so unchanged nights stay locked (#1036)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      guests: [
        {
          id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith",
          ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000,
          nights: [
            { stayDate: new Date("2026-06-01"), priceCents: 2500 },
            { stayDate: new Date("2026-06-02"), priceCents: 2500 },
          ],
        },
        {
          id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith",
          ageTier: "ADULT", isMember: true, memberId: null, priceCents: 5000,
          nights: [
            { stayDate: new Date("2026-06-01"), priceCents: 2500 },
            { stayDate: new Date("2026-06-02"), priceCents: 2500 },
          ],
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
    } as any);

    const res = await DELETE(deleteWithMethod("g2"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);

    // The remaining guest's stored per-night prices reach the engine as locks.
    const [, , pricedGuests] = mockedCalcPrice.mock.calls.at(-1) ?? [];
    expect(pricedGuests?.[0]).toEqual(
      expect.objectContaining({
        bookingGuestId: "g1",
        lockedNightPrices: [
          expect.objectContaining({ priceCents: 2500 }),
          expect.objectContaining({ priceCents: 2500 }),
        ],
      }),
    );
  });

  // --- #1100: minors-only removals flag the booking for admin review ---

  function minorsAfterRemovalBooking(overrides: Record<string, unknown> = {}) {
    // Removing the adult g1 leaves only the CHILD g2.
    return makeBooking({
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Kid", lastName: "Smith", ageTier: "CHILD", isMember: true, memberId: null, priceCents: 5000 },
      ],
      requiresAdminReview: false,
      adminReviewStatus: null,
      memberReviewJustification: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      ...overrides,
    });
  }

  it("flags a paid booking for admin review when removal leaves minors only, without touching its status (#1100)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = minorsAfterRemovalBooking({ status: "PAID" });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
    } as any);

    const res = await DELETE(deleteWithMethod("g1", "card"), {
      params: Promise.resolve({ id: "bk1", guestId: "g1" }),
    });
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.requiresAdminReview).toBe(true);
    expect(updateData.adminReviewStatus).toBe("PENDING");
    expect(updateData.memberReviewJustification).toContain("left no adult");
    // Captured money never re-enters the payment lifecycle: status stays PAID.
    expect(updateData.status).toBe("PAID");
  });

  it("parks a pre-payment booking to AWAITING_REVIEW when removal leaves minors only (#1100)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = minorsAfterRemovalBooking({
      status: "PAYMENT_PENDING",
      payment: {
        id: "p1", bookingId: "bk1", amountCents: 10000, source: "STRIPE",
        status: "PENDING", stripePaymentIntentId: "pi_123", xeroInvoiceId: null,
        refundedAmountCents: 0, changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
    } as any);

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g1" }) },
    );
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.adminReviewStatus).toBe("PENDING");
    expect(updateData.status).toBe("AWAITING_REVIEW");
  });

  it("auto-approves the minors-only flag when an admin performs the removal (#1100)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    const booking = minorsAfterRemovalBooking({ status: "PAID" });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
    } as any);

    const res = await DELETE(deleteWithMethod("g1", "card"), {
      params: Promise.resolve({ id: "bk1", guestId: "g1" }),
    });
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.requiresAdminReview).toBe(true);
    expect(updateData.adminReviewStatus).toBe("APPROVED");
    expect(updateData.status).toBe("PAID");
  });

  it("clears stale review state when a removal restores an adult-supervised party (#1100)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    // Both remaining guests are adults after removing the child.
    const booking = makeBooking({
      status: "PAID",
      requiresAdminReview: true,
      adminReviewStatus: "PENDING",
      memberReviewJustification: "Automatic: earlier removal left no adult on this booking.",
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Kid", lastName: "Smith", ageTier: "CHILD", isMember: true, memberId: null, priceCents: 5000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
    } as any);

    const res = await DELETE(deleteWithMethod("g2", "card"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.requiresAdminReview).toBe(false);
    expect(updateData.adminReviewStatus).toBeNull();
    expect(updateData.memberReviewJustification).toBeNull();
  });

  // --- #1041: lifecycle parity with the batch modify path ---

  function makeZeroDollarBooking(paymentOverrides: Record<string, unknown>) {
    // PAYMENT_PENDING booking whose price drops to 0 when g2 is removed:
    // remaining g1 reprices to 10000 and the promo adjustment covers it.
    return makeBooking({
      status: "PAYMENT_PENDING",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_123",
        xeroInvoiceId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
      promoRedemption: {
        id: "pr1",
        promoCodeId: "promo1",
        guestTargets: [],
        promoCode: { id: "promo1", assignments: [] },
      },
      ...paymentOverrides,
    });
  }

  function mockFullCoverPromo() {
    // Remaining guest reprices to 10000 and the promo covers all of it.
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] }],
    } as any);
    mockValidateAndCalculatePromoDiscount.mockResolvedValueOnce({
      discount: {
        discountCents: 0,
        priceAdjustmentCents: -10000,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [],
      },
      beneficiaryMemberIds: [],
    } as any);
  }

  it("auto-pays a zero-dollar booking and cancels superseded intents on removal (Stripe, #1041)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeZeroDollarBooking({});
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      { id: "pt1", stripePaymentIntentId: "pi_123", amountCents: 10000 },
    ]);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockFullCoverPromo();

    const res = await DELETE(deleteWithMethod("g2"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);

    // Batch parity: PAYMENT_PENDING + $0 => PAID with a zero-dollar payment.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAID", finalPriceCents: 0 }),
      }),
    );
    expect(tx.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "bk1" },
        update: expect.objectContaining({ amountCents: 0, status: "SUCCEEDED" }),
      }),
    );
    // The outstanding pre-removal intent is superseded and drained on Stripe.
    expect(mockEnqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_123" }),
    );
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledWith({ limit: 1 });
  });

  it("auto-pays a zero-dollar Internet Banking booking on removal (#1041)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeZeroDollarBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        source: "INTERNET_BANKING",
        status: "PENDING",
        stripePaymentIntentId: null,
        xeroInvoiceId: "inv_primary",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockFullCoverPromo();

    const res = await DELETE(deleteWithMethod("g2"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);

    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAID", finalPriceCents: 0 }),
      }),
    );
    expect(tx.payment.upsert).toHaveBeenCalled();
    // No Stripe intents to supersede on an Internet Banking booking.
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("recalculates the non-member hold when non-members remain after removal (#1041)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    vi.mocked(getNonMemberHoldDays).mockResolvedValue(7);
    const staleHold = new Date("2026-06-20");
    const booking = makeBooking({
      status: "PENDING",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      hasNonMembers: true,
      nonMemberHoldUntil: staleHold,
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
        { id: "g3", bookingId: "bk1", firstName: "Cara", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 24000,
      guests: [
        { priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] },
        { priceCents: 14000, perNightCents: [7000, 7000], nightDates: [] },
      ],
    } as any);

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);

    // Batch parity: the hold is recomputed from the current rules
    // (checkIn - holdDays), not left at its stale pre-removal value.
    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.hasNonMembers).toBe(true);
    expect(updateData.nonMemberHoldUntil).toEqual(
      new Date(new Date("2026-08-10").getTime() - 7 * 24 * 60 * 60 * 1000),
    );
  });

  it("clears the non-member hold when the last non-member is removed (#1041)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      status: "PENDING",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-08-03"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] }],
    } as any);

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.hasNonMembers).toBe(false);
    expect(updateData.nonMemberHoldUntil).toBeNull();
  });

  it("clears a stale non-member hold when the policy is disabled and non-members remain", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockedGetHoldPolicy.mockResolvedValueOnce({
      enabled: false,
      holdDays: 7,
      source: "default",
    });
    const booking = makeBooking({
      status: "PENDING",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-08-03"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
        { id: "g3", bookingId: "bk1", firstName: "Cara", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 24000,
      guests: [
        { priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] },
        { priceCents: 14000, perNightCents: [7000, 7000], nightDates: [] },
      ],
    } as any);

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);

    const updateData = tx.booking.update.mock.calls.at(-1)?.[0]?.data;
    expect(updateData.hasNonMembers).toBe(true);
    expect(updateData.status).toBe("PAYMENT_PENDING");
    expect(updateData.nonMemberHoldUntil).toBeNull();
  });

  // --- #1042: removal-induced price increases are collected ---

  function makePromoIncreaseBooking(overrides: Record<string, unknown> = {}) {
    // Paid 8000 with a group promo; removing g2 drops the party below the
    // promo minimum, so the remaining guest reprices to 10000 => +2000.
    return makeBooking({
      status: "PAID",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      totalPriceCents: 10000,
      promoAdjustmentCents: -2000,
      finalPriceCents: 8000,
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 8000,
        source: "STRIPE",
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_123",
        stripeCustomerId: null,
        xeroInvoiceId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
      promoRedemption: {
        id: "pr1",
        promoCodeId: "promo1",
        guestTargets: [],
        promoCode: { id: "promo1", assignments: [] },
      },
      ...overrides,
    });
  }

  function mockPromoInvalidatedRepricing() {
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] }],
    } as any);
    mockValidateAndCalculatePromoDiscount.mockResolvedValueOnce({
      error: "Party is below the promo's minimum group size",
      discount: null,
    } as any);
    mockCreatePaymentIntent.mockResolvedValue({
      id: "pi_add_1",
      client_secret: "cs_add_1",
    });
    mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_1" });
  }

  it("collects a promo-invalidation price increase via an additional PaymentIntent (#1042)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makePromoIncreaseBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockPromoInvalidatedRepricing();

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.priceDiffCents).toBe(2000);
    expect(body.additionalAmountCents).toBe(2000);
    // The remover is the booking owner, so they get the client secret.
    expect(body.additionalPaymentClientSecret).toBe("cs_add_1");

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 2000,
        customerId: "cus_1",
        idempotencyKey: "mod_guest_remove_bk1_mod1",
        metadata: expect.objectContaining({ reason: "guest_removal_price_increase" }),
      }),
    );
    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        paymentIntentId: "pi_add_1",
        amountCents: 2000,
        status: "PENDING",
      }),
    );
    // The email now surfaces the collectible Stripe increase.
    expect(sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalAmountCents: 2000,
        additionalPaymentMethod: "STRIPE",
      }),
    );
  });

  it("does not hand the owner's client secret to a self-removing linked guest (#1042)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "guest-member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makePromoIncreaseBooking({
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1", priceCents: 5000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockPromoInvalidatedRepricing();

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // The intent is still created — the payer is the booking owner, who pays
    // from their booking page — but the secret is not returned to the remover.
    expect(body.additionalPaymentClientSecret).toBeNull();
    expect(body.additionalAmountCents).toBe(2000);
    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2000 }),
    );
    // Customer lookup uses the owner's identity, not the remover's.
    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "m1", email: "alice@test.com" }),
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalAmountCents: 2000,
        additionalPaymentMethod: "STRIPE",
      }),
    );
  });

  it("creates no additional intent when the removal does not change the price (#1042)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makeBooking({
      status: "PAID",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      finalPriceCents: 10000,
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    // Repricing lands exactly on the old final price: zero delta.
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] }],
    } as any);

    const res = await DELETE(deleteWithMethod("g2"), {
      params: Promise.resolve({ id: "bk1", guestId: "g2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.additionalAmountCents).toBe(0);
    expect(body.additionalPaymentClientSecret).toBeNull();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("keeps billing Internet Banking increases via the Xero supplementary invoice (#1042)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    const booking = makePromoIncreaseBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 8000,
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        xeroInvoiceId: "inv_primary",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockPromoInvalidatedRepricing();

    const res = await DELETE(
      new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bk1", guestId: "g2" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // No Stripe intent for a non-Stripe payment; the supplementary invoice
    // bills the increase, unchanged from the pre-#1042 behaviour.
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(body.additionalPaymentClientSecret).toBeNull();
    expect(sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalAmountCents: 2000,
        additionalPaymentMethod: "INTERNET_BANKING",
      }),
    );
  });
});

// --- Email template tests ---

describe("bookingModifiedTemplate", () => {
  it("renders date change template", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "Alice",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-05"),
      newCheckOut: new Date("2026-06-07"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });
    expect(html).toContain("Booking Modified");
    expect(html).toContain("Alice");
    expect(html).toContain("Dates Changed");
    expect(html).toContain("Previous Dates");
    expect(html).toContain("New Dates");
  });

  it("renders guest add template", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "Bob",
      modificationType: "GUEST_ADD",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-03"),
      oldGuestCount: 2,
      newGuestCount: 3,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 15000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 5000,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });
    expect(html).toContain("Guests Added");
    expect(html).toContain("Previous Guests");
    expect(html).toContain("New Guests");
    expect(html).toContain("$50.00");
  });

  it("renders guest remove with refund", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "Carol",
      modificationType: "GUEST_REMOVE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-03"),
      oldGuestCount: 3,
      newGuestCount: 2,
      oldFinalPriceCents: 15000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 5000,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });
    expect(html).toContain("Guest Removed");
    expect(html).toContain("refund");
    expect(html).toContain("$50.00");
  });

  it("shows change fee when present", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "Dave",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-20"),
      newCheckOut: new Date("2026-06-22"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 5000,
      refundAmountCents: 0,
      additionalAmountCents: 5000,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });
    expect(html).toContain("Change Fee");
    expect(html).toContain("$50.00");
    expect(html).toContain("additional payment");
  });

  it("renders Internet Banking additional payment context", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "Eve",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-20"),
      newCheckOut: new Date("2026-06-22"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 15000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 5000,
      additionalPaymentMethod: "INTERNET_BANKING",
      paymentReference: "BOOKING-IB-1",
      xeroInvoiceNumber: "INV-1001",
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    expect(html).toContain("additional Internet Banking payment");
    expect(html).toContain("INV-1001");
    expect(html).toContain("BOOKING-IB-1");
    expect(html).toContain("Xero reconciliation confirms");
  });

  it("escapes HTML in firstName", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates/booking");
    const html = bookingModifiedTemplate({
      firstName: "<script>alert('xss')</script>",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-05"),
      newCheckOut: new Date("2026-06-07"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// --- #2104: no-adult review justification is machine-readable ---

describe("BookingModifyReviewJustificationRequiredError (#2104)", () => {
  it("carries the REVIEW_JUSTIFICATION_REQUIRED code and a 400 status", () => {
    const err = new BookingModifyReviewJustificationRequiredError();
    expect(err.code).toBe("REVIEW_JUSTIFICATION_REQUIRED");
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/written reason/i);
  });
});

describe("PUT /api/bookings/[id]/modify — review justification code (#2104)", () => {
  let PUT: typeof import("@/app/api/bookings/[id]/modify/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    // requireActiveSessionUser reads prisma.member.findUnique off the singleton.
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
    });
    const mod = await import("@/app/api/bookings/[id]/modify/route");
    PUT = mod.PUT;
  });

  it("returns 400 with the machine-readable code when the batch service demands a justification", async () => {
    mockedModifyBatch.mockRejectedValue(
      new BookingModifyReviewJustificationRequiredError(),
    );
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g1"] }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("REVIEW_JUSTIFICATION_REQUIRED");
    expect(body.error).toMatch(/written reason/i);
  });
});
