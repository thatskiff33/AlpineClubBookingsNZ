import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

const mockTransaction = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockCreatePaymentIntent = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockCheckCapacity = vi.fn();
const mockCalculateBookingPrice = vi.fn();
const mockCalculatePromoDiscountForGuestRates = vi.fn();
const mockValidateAndCalculatePromoDiscount = vi.fn(async () => {
  const discount = mockCalculatePromoDiscountForGuestRates();
  return {
    discount: {
      discountCents: discount?.discountCents ?? 0,
      priceAdjustmentCents:
        discount?.priceAdjustmentCents ?? -(discount?.discountCents ?? 0),
      freeNightsUsed: discount?.freeNightsUsed ?? 0,
      eligibleGuestCount: discount?.eligibleGuestCount ?? 0,
      allocations: discount?.allocations ?? [],
    },
    beneficiaryMemberIds: [],
  };
});
const mockAuth = vi.fn();
const mockRefundPaymentTransactions = vi.fn();
const mockApplyLocalRefundAllocation = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockPaymentTransactionUpdateMany = vi.fn();
const mockEnqueuePaymentIntentCancellationRecovery = vi.fn();
const mockProcessPaymentRecoveryOperations = vi.fn();
const mockEnqueueBookingModificationRefundRecovery = vi.fn();
const mockEnqueueAdditionalPaymentIntentRecovery = vi.fn();
const mockLoadCancellationPolicy = vi.fn();
const mockAssertLinkedBookingMembersCanBeBooked = vi.fn().mockResolvedValue(undefined);
const mockGetBookingGuestValidationErrorResponse = vi.fn(
  (error: { message: string }): Record<string, unknown> => ({
    error: error.message,
  })
);
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking", message: "queued" });
const mockEnqueueXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking_update", message: "queued" });
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockEnqueueXeroModificationAccountCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_account_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);
const mockRecordSkippedXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_skip", message: "skipped" });
const mockReconcileAdultMemberHostingReviewWithSiblings = vi
  .fn()
  .mockResolvedValue(undefined);

const mockBookingGuestValidationError = class BookingGuestValidationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    /*
      #3032: the modified email asks whether the club is still working out an
      amount on this booking, through `bookingHasOpenFinancialReview`. That
      reads the GLOBAL client after the transaction commits, which is a
      different read from the fence's in-transaction `findFirst`. Empty by
      default - no review is open - so every pre-#3032 assertion in this file
      means exactly what it meant before.
    */
    manualRefundTask: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as (cb: unknown) => unknown)(fn);
      return Promise.resolve();
    },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      // The ordinary-edit Xero lock-date guard's advisory pre-transaction
      // read (#1729); null skips the guard (the in-transaction re-read owns
      // the 404).
      findUnique: vi.fn().mockResolvedValue(null),
    },
    payment: {
      update: mockPaymentUpdate,
    },
    paymentTransaction: {
      updateMany: mockPaymentTransactionUpdateMany,
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: mockMemberFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacity: mockCheckCapacity,
  checkCapacityForGuestRanges: mockCheckCapacity,
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: mockCalculateBookingPrice,
}));

// #2363: the save path now consults the minimum-stay policy set for non-admin
// actors. This suite is about money and mocks `@/lib/prisma` and `@/lib/pricing`
// down to the members it needs, so the real evaluator cannot run here (it reads
// `minimumStayPolicy` and `getStayNights`). A compliant answer keeps every case
// below on the subject it was written for; the enforcement itself is pinned in
// booking-batch-modification-minimum-stay.test.ts and modify-minimum-stay.test.ts.
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi
    .fn()
    .mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn(() => ""),
}));

vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/adult-member-hosting-review")>();
  return {
    ...actual,
    reconcileAdultMemberHostingReviewWithSiblings: (...args: unknown[]) =>
      mockReconcileAdultMemberHostingReviewWithSiblings(...args),
  };
});

vi.mock("@/lib/change-fee", () => ({
  calculateChangeFee: vi.fn().mockReturnValue({ feeCents: 0 }),
}));

vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: (...args: unknown[]) => mockLoadCancellationPolicy(...args),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
  calculateDualRefundAmounts: (
    paidAmountCents: number,
    _daysUntilCheckIn: number,
    policyRules: Array<{
      refundPercentage: number;
      creditRefundPercentage: number;
      fixedFeeCents?: number;
      creditFixedFeeCents?: number;
    }>
  ) => {
    const tier = policyRules[0] ?? {
      refundPercentage: 0,
      creditRefundPercentage: 0,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
    };
    return {
      cardRefundAmountCents: Math.max(
        0,
        Math.round((paidAmountCents * tier.refundPercentage) / 100) -
          (tier.fixedFeeCents ?? 0)
      ),
      cardRefundPercentage: tier.refundPercentage,
      creditRefundAmountCents: Math.max(
        0,
        Math.round((paidAmountCents * tier.creditRefundPercentage) / 100) -
          (tier.creditFixedFeeCents ?? 0)
      ),
      creditRefundPercentage: tier.creditRefundPercentage,
    };
  },
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/promo", () => ({
  calculatePromoDiscountForGuestRates: mockCalculatePromoDiscountForGuestRates,
  validateAndCalculatePromoDiscount: mockValidateAndCalculatePromoDiscount,
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  // #2299: the promo path row-locks each PromoCode it may charge or
  // refund before reading or writing any usage cap.
  lockPromoCodeRowsForUpdate: vi.fn(),
  lockAndRefreshPromoCodeUsage: vi.fn(
    async (_tx: unknown, promoCode: unknown) => promoCode
  ),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  createPaymentIntent: mockCreatePaymentIntent,
  findOrCreateCustomer: mockFindOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  applyLocalRefundAllocation: (...args: unknown[]) =>
    mockApplyLocalRefundAllocation(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mockEnqueuePaymentIntentCancellationRecovery(...args),
  processPaymentRecoveryOperations: (...args: unknown[]) =>
    mockProcessPaymentRecoveryOperations(...args),
  enqueueBookingModificationRefundRecovery: (...args: unknown[]) =>
    mockEnqueueBookingModificationRefundRecovery(...args),
  enqueueAdditionalPaymentIntentRecovery: (...args: unknown[]) =>
    mockEnqueueAdditionalPaymentIntentRecovery(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({
    choreWarnings: [],
  }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({
    choreWarnings: [],
  }),
}));

vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mockEnqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation: mockEnqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  enqueueXeroModificationAccountCreditNoteOperation: mockEnqueueXeroModificationAccountCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation: mockRecordSkippedXeroBookingInvoiceUpdateOperation,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/age-tier-schema", () => ({
  ageTierEnum: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"]),
  bookableAgeTierEnum: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT"]),
}));

vi.mock("@/lib/booking-guests", () => {
  return {
    assertLinkedBookingMembersCanBeBooked: mockAssertLinkedBookingMembersCanBeBooked,
    BookingGuestValidationError: mockBookingGuestValidationError,
    getBookingGuestValidationErrorResponse: mockGetBookingGuestValidationErrorResponse,
    normalizeBookingGuestInputs: vi.fn((guests: unknown) => guests),
    // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
    // over the WHOLE proposed party from this function. These fixtures are about
    // pricing/payment rather than family boundaries, and were written when every
    // member-linked guest in them was family scope, so an empty boundary states
    // that assumption explicitly. The C1 behaviour itself is covered by
    // `member-guest-cross-family-refusals.test.ts` and by the source contract in
    // `review-findings-contracts.test.ts`.
    computeMemberGuestBoundary: vi.fn().mockResolvedValue({
      scopeByMemberId: new Map(),
      beyondFamilyMemberIds: [],
    }),
    resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
    // MG2 (#2307): the batch path resolves through the boundary-carrying
    // variant now; an empty boundary means "every guest is family scope".
    resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
      members: new Map(),
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
    }),
  };
});

vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuestNames: vi.fn().mockResolvedValue([]),
}));

function makeBooking(overrides: Record<string, unknown> = {}) {
  const booking = {
    id: "bk1",
    memberId: "m1",
    checkIn: new Date("2026-08-20"),
    checkOut: new Date("2026-08-22"),
    status: "PAID",
    totalPriceCents: 5000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 5000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1" as string | null,
        priceCents: 5000,
      },
    ],
    payment: {
      id: "pay_1",
      bookingId: "bk1",
      amountCents: 5000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original" as string | null,
      xeroInvoiceId: "inv_primary",
      stripeCustomerId: null,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    member: {
      id: "m1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Member",
    },
    promoRedemption: null,
    ...overrides,
  };
  return {
    ...booking,
    guests: reconcilingNightRows(booking, booking.guests),
  };
}

/**
 * Give every fixture guest stored night rows that reconcile with their total
 * (#3166), unless the case supplied its own.
 *
 * Every edit path is now judged on exact stored sold-price evidence, so a guest
 * with no `BookingGuestNight` rows PARKS the edit for financial review — nothing
 * is repriced, nothing settles, and not one payment assertion in this file can
 * run. That is the gate doing its job; it is not what this suite is about. So
 * the DEFAULT fixture guest is the ordinary readable one, and the cases that
 * genuinely mean to describe unreadable history pass `nights` themselves (the
 * `NO_STORED_NIGHT_PRICES` and `STORED_TOTAL_MISMATCH` cases below), which this
 * leaves untouched.
 *
 * The rows are an even split with the remainder on the first night, so they sum
 * to the stored total EXACTLY — an approximate split would not reconcile, and a
 * fixture that parks silently would take every assertion below down with it.
 */
function reconcilingNightRows<G extends Record<string, unknown>>(
  booking: { checkIn: Date; checkOut: Date },
  guests: G[],
): G[] {
  return guests.map((guest) => {
    if (guest.nights !== undefined) return guest;
    const start = (guest.stayStart ?? booking.checkIn) as Date;
    const end = (guest.stayEnd ?? booking.checkOut) as Date;
    const nights: Date[] = [];
    for (
      let day = new Date(start.getTime());
      day < end;
      day = new Date(day.getTime() + 86_400_000)
    ) {
      nights.push(new Date(day.getTime()));
    }
    const total = (guest.priceCents as number | undefined) ?? 0;
    const base = nights.length === 0 ? 0 : Math.floor(total / nights.length);
    return {
      ...guest,
      nights: nights.map((stayDate, index) => ({
        stayDate,
        priceCents: index === 0 ? total - base * (nights.length - 1) : base,
      })),
    };
  });
}

function makeTx(booking: ReturnType<typeof makeBooking>) {
  const createdGuests: Array<Record<string, unknown>> = [];

  return {
    // #1881 — the batch service now takes the global lock(1) via $executeRaw.
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    // #2299 — the promo path row-locks each PromoCode it may charge or refund
    // before reading or writing any cap. Since #2289 that lock is
    // `$executeRaw`SELECT 1 … FOR UPDATE``: a constant, never a raw read.
    $queryRaw: vi.fn().mockResolvedValue([]),
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...booking,
          ...data,
          guests: [...booking.guests, ...createdGuests],
          payment: booking.payment,
        })
      ),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const guest = { id: "g2", ...data };
        createdGuests.push(guest);
        return Promise.resolve(guest);
      }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    // Per-night stay rows (issue #713) re-synced on every guest write.
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // #3032: the pending-review fence reads this under the booking-edit locks.
    // Empty by default - no financial review is open - so every pre-#3032 test
    // asserts exactly what it asserted before.
    manualRefundTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      // #3170: the park's own raise is a find-then-create on the occurrence
      // key. Nothing on file by default, so a raising test sees a create and a
      // replay test can put a row here instead.
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "task_1" }),
      // #3032: the modified email asks whether the club is still working
      // out an amount on this booking (`bookingHasOpenFinancialReview`).
      // Empty by default - no review is open - so every pre-#3032
      // assertion in this file means exactly what it meant before.
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod_1" }),
    },
    bookingRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    promoRedemption: {
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    promoCode: {
      update: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({
        id: "promo_1",
        code: "FREE100",
        type: "PERCENTAGE",
        valueCents: null,
        percentOff: 100,
        freeNights: null,
        active: true,
        validFrom: null,
        validUntil: null,
        maxRedemptions: null,
        currentRedemptions: 0,
        membersOnly: false,
        singleUse: false,
        assignments: [],
      }),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    payment: {
      update: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue({
        id: booking.payment?.id ?? "pay_zero",
        amountCents: 0,
        status: "SUCCEEDED",
      }),
    },
    memberCredit: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "credit_1" }),
      update: vi.fn().mockResolvedValue({ id: "credit_1" }),
      // F1 (#1887): applyLifecycleTransitions now reads the applied-credit
      // ledger for every pre-payment modification (status-gated, not the payment
      // mirror). These fixtures carry no applied credit, so the aggregate nets to
      // 0 and the clamp stays a no-op.
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
    },
    paymentTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "season_1",
          startDate: new Date("2026-04-01"),
          endDate: new Date("2026-10-31"),
          // Membership-type-keyed rates (#1930, E4). calculateBookingPrice is
          // mocked in this suite, so the values are inert; the shape must match
          // so toSeasonRateData does not crash.
          membershipTypeRates: [
            {
              membershipTypeId: "type-full",
              ageTier: "ADULT",
              pricePerNightCents: 2500,
            },
            {
              membershipTypeId: "type-nonmember",
              ageTier: "ADULT",
              pricePerNightCents: 5000,
            },
          ],
        },
      ]),
    },
    // Rate resolver (#1930, E4) delegates.
    member: { findMany: vi.fn().mockResolvedValue([]) },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-nonmember", key: "NON_MEMBER" },
        { id: "type-full", key: "FULL" },
      ]),
    },
  };
}

/**
 * A `calculateBookingPrice` double that prices EXACTLY the nights it is handed,
 * at a per-night rate that depends only on whether the guest is a member, and
 * returns each amount attached to the night it belongs to.
 *
 * The in-progress cases below used to hand this mock a canned answer per call, in
 * call order: guest 1's old window, guest 1's new window, then the added guest.
 * #2756 made the planner price the whole PARTY in one pass per window rather than
 * one pass per guest — the group discount depends on how many people are in the
 * lodge that night, which a per-guest call can never see — and read each guest's
 * slice back out BY NIGHT. So a canned answer per call now describes neither the
 * right number of calls nor the right nights. Deriving the answer from the input
 * fixes both and changes no arithmetic: these fixtures are flat-rate bookings
 * whose stored totals divide exactly, and the rates are the ones the canned
 * answers already implied (2500 a night for the member, 3000 for the non-member
 * guest being added).
 */
function pricesNightsHandedIn(memberRateCents: number, nonMemberRateCents: number) {
  return (
    checkIn: Date,
    checkOut: Date,
    guests: Array<{ isMember?: boolean; nights?: ReadonlyArray<Date> | null }>,
  ) => {
    const breakdowns = guests.map((guest) => {
      const nights =
        guest.nights && guest.nights.length > 0
          ? [...guest.nights]
          : eachNightBetween(checkIn, checkOut);
      const rateCents = guest.isMember ? memberRateCents : nonMemberRateCents;
      return {
        priceCents: nights.length * rateCents,
        perNightCents: nights.map(() => rateCents),
        nightDates: nights,
      };
    });
    return {
      guests: breakdowns,
      totalPriceCents: breakdowns.reduce((sum, g) => sum + g.priceCents, 0),
    };
  };
}

/** `[checkIn, checkOut)` as nights — half-open, the departure morning excluded. */
function eachNightBetween(checkIn: Date, checkOut: Date): Date[] {
  const nights: Date[] = [];
  for (
    let night = new Date(checkIn.getTime());
    night < checkOut;
    night = new Date(night.getTime() + 86_400_000)
  ) {
    nights.push(new Date(night.getTime()));
  }
  return nights;
}

/**
 * #3232 (`INV-LOCK-004`): a caller that supplies the transaction owns the reads
 * that must happen before it opens — the member-guest policy, the
 * subscription-lockout mode and the Xero lock dates, the last of which is an
 * outbound HTTPS request on a cold cache. The service refuses a caller
 * transaction without them rather than doing that work under the caller's locks,
 * so every tx-mode case here hands them in. `not-applicable` is what a club with
 * the Xero module off, or no retroactive check-in, really resolves to.
 */
const TX_MODE_PRE_TRANSACTION = {
  memberGuestPolicy: { enabled: false, requiresConsent: false },
  subscriptionLockoutMode: "off",
  xeroLockDates: { kind: "not-applicable" },
} as never;

describe("PUT /api/bookings/[id]/modify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculateBookingPrice.mockReset();
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });
    mockAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@example.com" },
    });
    mockCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      email: "alice@example.com",
      firstName: "Alice",
    });
    mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_new" });
    mockCreatePaymentIntent.mockResolvedValue({
      id: "pi_batch",
      client_secret: "pi_batch_secret",
    });
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockEnqueuePaymentIntentCancellationRecovery.mockResolvedValue({
      id: "recovery_1",
    });
    mockEnqueueBookingModificationRefundRecovery.mockResolvedValue({
      id: "recovery_refund",
    });
    mockEnqueueAdditionalPaymentIntentRecovery.mockResolvedValue({
      id: "recovery_additional",
    });
    mockLoadCancellationPolicy.mockResolvedValue([
      {
        daysBeforeStay: 0,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ]);
    mockProcessPaymentRecoveryOperations.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      retried: 0,
      skipped: 0,
    });
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    mockCalculatePromoDiscountForGuestRates.mockReturnValue({
      discountCents: 0,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
    });
    mockAssertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mockGetBookingGuestValidationErrorResponse.mockImplementation((error: { message: string }) => ({
      error: error.message,
    }));
  });

  it("passes stored night prices to the pricing engine on batch edits (#1036)", async () => {
    const booking = makeBooking();
    (booking.guests as Array<Record<string, unknown>>)[0].nights = [
      { stayDate: new Date("2026-06-01"), priceCents: 2500 },
      { stayDate: new Date("2026-06-02"), priceCents: 2500 },
    ];
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockCalculateBookingPrice.mockImplementation(((_ci: unknown, _co: unknown, guests: unknown[]) => ({
      totalPriceCents: guests.length * 5000,
      guests: guests.map(() => ({
        priceCents: 5000,
        perNightCents: [2500, 2500],
        nightDates: [],
      })),
    })) as any);

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ addGuests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });
    expect(response.status).toBe(200);

    const pricedGuestLists = mockCalculateBookingPrice.mock.calls.map(
      (call) => call[2] as Array<Record<string, unknown>>,
    );
    const fullPartyCall = pricedGuestLists.find((guests) =>
      guests?.some((guest) => guest.bookingGuestId === "g1"),
    );
    expect(fullPartyCall?.find((guest) => guest.bookingGuestId === "g1")).toEqual(
      expect.objectContaining({
        lockedNightPrices: [
          expect.objectContaining({ priceCents: 2500 }),
          expect.objectContaining({ priceCents: 2500 }),
        ],
      }),
    );
    // First test in the file: the route's dynamic import (grown by #2307's
    // member-guest modules) counts against this test's clock, like the two
    // 10_000 timeouts below.
  }, 10_000);

  it("tx-mode (#2525): runs the modification on the caller's tx and DEFERS post-commit", async () => {
    const booking = makeBooking();
    (booking.guests as Array<Record<string, unknown>>)[0].nights = [
      { stayDate: new Date("2026-06-01"), priceCents: 2500 },
      { stayDate: new Date("2026-06-02"), priceCents: 2500 },
    ];
    const tx = makeTx(booking);
    // Deliberately DO NOT stub mockTransaction: in tx-mode the service MUST run
    // the DB work on the supplied tx and must open NO transaction of its own — if
    // it did, the default mock returns undefined and the assertions below fail.
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [
        { priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] },
        { priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] },
      ],
    });

    const { modifyBookingBatch } = await import(
      "@/lib/booking-batch-modification-service"
    );
    const result = await modifyBookingBatch({
      todayAtClub: FIXTURE_CLUB_DAY,
      bookingId: "bk1",
      actor: { id: "m1", role: "USER" },
      input: {
        addGuests: [
          { firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true },
        ],
      } as never,
      ipAddress: "127.0.0.1",
      tx: tx as never,
      preTransaction: TX_MODE_PRE_TRANSACTION,
    });

    // Ran inside the caller's transaction — the service opened NONE of its own.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalled();
    // Post-commit provider work is deferred, and the provider-derived fields are
    // null until the caller runs it.
    expect(typeof result.deferredPostCommit).toBe("function");
    expect(result.additionalPaymentClientSecret).toBeNull();
    expect(result.stripeRefundId).toBeNull();
    // The deferred thunk runs the post-commit work (idempotent, returns void).
    await expect(result.deferredPostCommit!()).resolves.toBeUndefined();
  }, 10_000);

  /**
   * #3232 D2: A WAIVED CHANGE FEE IS NOT AN UNMARKED ZERO.
   *
   * Nothing recorded that a waiver had happened — no flag, no reason — so "no fee
   * was due" and "we waived it because our own supervision rule compelled this
   * move" were the same 0 in the modification row, the audit trail and the Xero
   * leg. A treasurer reconciling change-fee income against the club setting had
   * nothing to reconcile against, and the dragged booking's history read as an
   * ordinary member-initiated edit to a booking the member never asked to move.
   */
  it("records that a waived change fee was WAIVED, and only when it was", async () => {
    async function runWith(waiveChangeFee: boolean, chargeableFeeCents: number) {
      const tx = makeTx(makeBooking());
      mockCalculateBookingPrice.mockReturnValue({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500], nightDates: [] }],
      });
      // WHAT THE MOVE WOULD ATTRACT IF NOBODY WAIVED IT. The waiver is only a
      // waiver against a fee that existed, so this is the variable the third case
      // below turns to zero (#3232 D2, fix round).
      const { calculateChangeFee } = await import("@/lib/change-fee");
      vi.mocked(calculateChangeFee).mockReturnValue({
        feeCents: chargeableFeeCents,
      } as never);
      const { logAudit } = await import("@/lib/audit");
      vi.mocked(logAudit).mockClear();
      const { modifyBookingBatch } = await import(
        "@/lib/booking-batch-modification-service"
      );
      const result = await modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "bk1",
        actor: { id: "m1", role: "USER" },
        // A REAL DATE MOVE, because an edit that does not move the check-in never
        // reaches the fee band at all — which is exactly how the first version of
        // this test recorded a "waiver" of a fee that was never chargeable.
        input: { checkIn: "2026-08-24", checkOut: "2026-08-26" } as never,
        ipAddress: "127.0.0.1",
        tx: tx as never,
        preTransaction: TX_MODE_PRE_TRANSACTION,
        ...(waiveChangeFee ? { waiveChangeFee: true } : {}),
      });
      await result.deferredPostCommit!();
      const row = vi.mocked(tx.bookingModification.create).mock.calls[0]?.[0] as
        | { data: { newData: Record<string, unknown> } }
        | undefined;
      const audit = vi
        .mocked(logAudit)
        .mock.calls.find(
          (call) =>
            (call[0] as { action: string }).action === "booking.modify.batch",
        )?.[0] as { metadata: Record<string, unknown> } | undefined;
      return {
        newData: row?.data.newData,
        metadata: audit?.metadata,
        changeFeeCents: result.changeFeeCents,
      };
    }

    const waived = await runWith(true, 2_500);
    expect(waived.newData?.changeFeeWaived).toBe(true);
    expect(waived.newData?.changeFeeWaivedReason).toBe(
      "LINKED_MOVE_SUPERVISION_RULE",
    );
    expect(waived.metadata?.changeFeeWaived).toBe(true);
    expect(waived.metadata?.changeFeeWaivedReason).toBe(
      "LINKED_MOVE_SUPERVISION_RULE",
    );
    // The waiver reached the MONEY, not only the label beside it.
    expect(waived.changeFeeCents).toBe(0);

    // And ABSENT on an ordinary edit, so a query for waived fees is a query for
    // the key rather than a guess at which zeroes meant something.
    const ordinary = await runWith(false, 2_500);
    expect(ordinary.newData).toBeDefined();
    expect(ordinary.newData).not.toHaveProperty("changeFeeWaived");
    expect(ordinary.metadata).toBeDefined();
    expect(ordinary.metadata).not.toHaveProperty("changeFeeWaived");
    expect(ordinary.changeFeeCents).toBe(2_500);

    /*
      AND ABSENT WHERE THERE WAS NOTHING TO WAIVE (#3232 fix round).

      The flag is passed for every booking the linked move drags along, whatever
      that booking's own fee band says. Recording a waiver from the flag ALONE
      therefore over-counted exactly the number the field exists for — the one a
      treasurer reconciles against the club setting — and wrote "we waived it
      because our own supervision rule compelled this move" into the history of a
      booking that was never going to be charged anything. Same zero on the money
      either way, which is precisely why the marker has to come from the fee that
      was suppressed rather than from the request that asked.
    */
    const nothingToWaive = await runWith(true, 0);
    expect(nothingToWaive.changeFeeCents).toBe(0);
    expect(nothingToWaive.newData).toBeDefined();
    expect(nothingToWaive.newData).not.toHaveProperty("changeFeeWaived");
    expect(nothingToWaive.metadata).toBeDefined();
    expect(nothingToWaive.metadata).not.toHaveProperty("changeFeeWaived");
  }, 10_000);

  it("real service path preserves sparse added-guest nights and forwards both hosting approvals", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    const sparseNight = new Date("2026-08-21T00:00:00.000Z");
    mockCalculateBookingPrice.mockImplementation(
      ((_checkIn: unknown, _checkOut: unknown, guests: Array<{ nights?: Date[] }>) => ({
        totalPriceCents: 8000,
        guests: guests.map((guest, index) =>
          index === 0
            ? {
                priceCents: 5000,
                perNightCents: [2500, 2500],
                nightDates: [
                  new Date("2026-08-20T00:00:00.000Z"),
                  new Date("2026-08-21T00:00:00.000Z"),
                ],
              }
            : {
                priceCents: 3000,
                perNightCents: [3000],
                nightDates: guest.nights ?? [],
              },
        ),
      })) as never,
    );

    const { modifyBookingBatch } = await import(
      "@/lib/booking-batch-modification-service"
    );
    const result = await modifyBookingBatch({
      todayAtClub: FIXTURE_CLUB_DAY,
      bookingId: "bk1",
      actor: { id: "officer-1", role: "ADMIN" },
      input: {
        addGuests: [
          {
            firstName: "Sparse",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            nights: ["2026-08-21"],
          },
        ],
      },
      approvedExceptionAdultMemberHostingDecision: {
        byMemberId: "officer-1",
        reason: "Approved adult-member hosting exception req-1.",
      },
      hostingCoverageOverride: {
        acknowledged: true,
        reason: "Confirmed alternate supervision plan.",
        strandedStateKey: `v1:${"a".repeat(64)}`,
      },
      ipAddress: "127.0.0.1",
      tx: tx as never,
      preTransaction: TX_MODE_PRE_TRANSACTION,
    });

    expect(result.priceDiffCents).toBe(3000);
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingGuestId: "g2",
          stayDate: sparseNight,
          priceCents: 3000,
        },
      ],
    });
    expect(tx.bookingGuest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stayStart: sparseNight,
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
          priceCents: 3000,
        }),
      }),
    );
    expect(mockReconcileAdultMemberHostingReviewWithSiblings).toHaveBeenCalledWith(
      "bk1",
      tx,
      expect.objectContaining({
        decision: {
          byMemberId: "officer-1",
          reason: "Approved adult-member hosting exception req-1.",
        },
        dependentCoverage: "ESCALATE",
        coverageActorMemberId: "officer-1",
        coverageChange: {
          cause: "OFFICER_OVERRIDE",
          actorMemberId: "officer-1",
          reason: "Confirmed alternate supervision plan.",
          strandedStateKey: `v1:${"a".repeat(64)}`,
        },
      }),
    );
  }, 10_000);

  it("allows identity-only edits on a quote-priced booking without repricing (#1099)", async () => {
    // A school booking's student names must be editable; the negotiated flat
    // price must not move. Identity-only edits skip the pricing engine, so
    // the quote guard lets them through.
    const booking = makeBooking({
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Teacher",
          lastName: "InCharge",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "School Child",
          lastName: "1",
          ageTier: "YOUTH",
          isMember: false,
          memberId: null,
          priceCents: 2500,
        },
      ],
    });
    const tx = makeTx(booking);
    tx.bookingRequest.findFirst.mockResolvedValue({ id: "req_1" });
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [{ guestId: "g2", firstName: "Aroha", lastName: "Ngata" }],
      }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    // The pricing engine never runs, so the negotiated basis cannot move.
    expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    // Stored totals are echoed back unchanged.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalPriceCents: booking.totalPriceCents,
          finalPriceCents: booking.finalPriceCents,
          discountCents: booking.discountCents,
        }),
      })
    );
    // The name update itself is applied.
    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g2" },
        data: expect.objectContaining({ firstName: "Aroha", lastName: "Ngata" }),
      })
    );
  });

  it("identity-only edits preserve prices on ordinary bookings too (#1099)", async () => {
    // Unpaid booking: the pre-existing paid-name lock stays in force for
    // non-quoted bookings and is tested elsewhere.
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 5000,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          priceCents: 2500,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Bob",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [{ guestId: "g2", firstName: "Robert", lastName: "Smith" }],
      }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.priceDiffCents).toBe(0);
    expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
  });

  it("echoes each stored night price back unchanged on an identity-only edit (#3031)", async () => {
    // THE CONTROL for the refusal below. `buildIdentityOnlyPricing` runs no
    // pricing at all: it hands back what is already stored, and those amounts
    // are written straight onto `BookingGuestNight` by the guest-sync step. So
    // "preserves the price" has to mean byte for byte, per night — an even split
    // of the guest total would reconcile just as well, which is why these nights
    // are deliberately unequal.
    //
    // The typo fix lands on the NON-MEMBER guest (a member-linked name is not
    // editable at all), and the assertion is over BOTH guests: an identity-only
    // edit must leave the untouched guest's history alone as well as the
    // renamed one's.
    const memberNights = [
      { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 1000 },
      { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 1500 },
    ];
    const guestNights = [
      { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 900 },
      { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 1600 },
    ];
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 5000,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          priceCents: 2500,
          nights: memberNights,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Bob",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
          nights: guestNights,
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [{ guestId: "g2", firstName: "Robert", lastName: "Smith" }],
      }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        { bookingGuestId: "g1", stayDate: memberNights[0].stayDate, priceCents: 1000 },
        { bookingGuestId: "g1", stayDate: memberNights[1].stayDate, priceCents: 1500 },
      ],
    });
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        { bookingGuestId: "g2", stayDate: guestNights[0].stayDate, priceCents: 900 },
        { bookingGuestId: "g2", stayDate: guestNights[1].stayDate, priceCents: 1600 },
      ],
    });
  });

  it("refuses an identity-only edit whose night rows arrived without their price (#3031)", async () => {
    // The prohibited answer is `?? 0` — and this echo carried one, on an edit
    // whose entire promise is that it changes no money. A night loaded without
    // its price is a SELECT that did not ask for it, and defaulting would
    // replace a real sold price with a magic zero that the NEXT edit reads back
    // as evidence the member paid nothing (INV-MOD-028).
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 5000,
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          priceCents: 2500,
          nights: [
            { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 1000 },
            { stayDate: new Date("2026-08-21T00:00:00.000Z") },
          ],
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Bob",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
          nights: [
            { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 1250 },
            { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 1250 },
          ],
        },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const { default: logger } = await import("@/lib/logger");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [{ guestId: "g2", firstName: "Robert", lastName: "Smith" }],
      }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    // #1888: an untyped failure does not leak its message to the client, so
    // WHICH failure it was is asserted against the log instead of the body —
    // otherwise this case is indistinguishable from any other 400 the route can
    // produce, including the one a mis-built fixture would cause.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringContaining(
            "was loaded without its stored sold price (#3031)",
          ),
        }),
      }),
      "Batch modify failed",
    );
    expect(tx.bookingGuestNight.createMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("blocks batch edits on a quote-priced booking (#1032)", async () => {
    // A booking converted from a school/public booking request keeps its
    // negotiated flat total; the batch edit path would reprice every guest
    // at season rates, so it refuses with an actionable message instead.
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.bookingRequest.findFirst.mockResolvedValue({ id: "req_1" });
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ addGuests: [{ firstName: "New", lastName: "Student", ageTier: "CHILD", isMember: false }] }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("negotiated booking-request price"),
    });
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  });

  it("returns the shared profile-required shape when added linked member guests are blocked", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockAssertLinkedBookingMembersCanBeBooked.mockRejectedValueOnce(
      new mockBookingGuestValidationError(
        "Some member guests need their details completed or confirmed before booking.",
        403
      )
    );
    mockGetBookingGuestValidationErrorResponse.mockReturnValueOnce({
      code: "GUEST_PROFILE_REQUIRED",
      error: "Some member guests need their details completed or confirmed before booking.",
      members: [
        {
          memberId: "guest-member-1",
          name: "Bob Jones",
          canCurrentUserResolve: true,
          needsOwnLoginConfirmation: false,
          missingFields: ["Date of Birth"],
          action: "complete_details",
        },
      ],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
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

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data).toMatchObject({
      code: "GUEST_PROFILE_REQUIRED",
      members: [
        expect.objectContaining({
          memberId: "guest-member-1",
          action: "complete_details",
        }),
      ],
    });
    expect(mockAssertLinkedBookingMembersCanBeBooked).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      "m1",
      {
        actorRole: "USER",
        onBehalfOfMemberId: null,
        // MG2 (#2307, D-8): the batch path now names which added members sit
        // beyond the family boundary; none here, so the list is empty.
        crossFamilyMemberIds: [],
      }
    );
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  }, 10_000);

  it("rejects batch add when a linked member is already booked elsewhere", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
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

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
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

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      code: string;
      conflicts: Record<string, unknown>[];
    };
    expect(body.code).toBe("BOOKING_MEMBER_NIGHT_CONFLICT");
    // #2250 at the route boundary: the actor owns bk1 and is neither the
    // clashing guest nor an admin, so the 409 names nothing about the OTHER
    // booking — not its id, owner, status, stay dates, or guest row. All they
    // get is who in their own party clashes and on which of their own nights.
    expect(body.conflicts).toEqual([
      {
        memberId: "guest-member-1",
        memberName: "Bob Jones",
        conflictingNights: expect.any(Array),
        isOwnBooking: false,
        canOpenBooking: false,
        canSelfRemove: false,
        isSelfGuest: false,
      },
    ]);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("existing-booking");
    expect(serialised).not.toContain("existing-guest");
    expect(serialised).not.toContain("Other Owner");
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  }, 10_000);

  it("creates an additional PaymentIntent when a paid booking increases in price", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.additionalAmountCents).toBe(10000);
    expect(data.additionalPaymentClientSecret).toBe("pi_batch_secret");

    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith({
      email: "alice@example.com",
      name: "Alice Member",
      memberId: "m1",
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        customerId: "cus_new",
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
          reason: "batch_modify_price_increase",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_1",
        paymentIntentId: "pi_batch",
        amountCents: 10000,
        stripeCustomerId: "cus_new",
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 10000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_batch",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("enqueues durable intent recovery when additional PaymentIntent creation fails (#1096)", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCreatePaymentIntent.mockRejectedValueOnce(new Error("stripe down"));

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    // The modification stands; the collectable arrives via the recovery cron.
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.additionalPaymentClientSecret ?? null).toBeNull();

    expect(mockEnqueueAdditionalPaymentIntentRecovery).toHaveBeenCalledTimes(1);
    expect(mockEnqueueAdditionalPaymentIntentRecovery).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "pay_1",
      // #3170: the recovery key is passed rather than derived inside, so a
      // review-completion charge can scope its own to the TASK. The ordinary
      // edit path still builds the modification-scoped key, and this pins the
      // exact string it has always used.
      idempotencyKey: "payment_recovery_additional_intent_mod_1",
      amountCents: 10000,
      stripeIdempotencyKey: "mod_batch_bk1_mod_1",
      // #3181: the edit's OWN answer to "did this booking already have a primary
      // Xero invoice", frozen here because this is the last moment it is known.
      // The replay reads it back rather than re-deriving one hours later, when
      // an invoice minted in between would make it say yes to a different
      // question.
      hadIssuedXeroInvoice: true,
    });
  });

  it("updates non-member guest names while an additional payment is outstanding", async () => {
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Old",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 5000,
        },
      ],
      payment: {
        ...makeBooking().payment,
        additionalAmountCents: 2000,
        additionalPaymentStatus: "PENDING",
      },
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [
          {
            guestId: "g1",
            firstName: "New",
            lastName: "Guest",
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({
          firstName: "New",
          lastName: "Guest",
        }),
      })
    );
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modificationType: "GUEST_UPDATE",
          priceDiffCents: 0,
          changeFeeCents: 0,
          previousData: expect.objectContaining({
            updatedGuests: [
              {
                guestId: "g1",
                firstName: "Old",
                lastName: "Guest",
              },
            ],
          }),
          newData: expect.objectContaining({
            updatedGuests: [
              {
                guestId: "g1",
                firstName: "New",
                lastName: "Guest",
              },
            ],
          }),
        }),
      })
    );
  });

  it("rejects swapping in a different person after the booking is fully paid (#1386)", async () => {
    // "Old Guest" -> "New Guest" is a swap (full-name edit distance 3), not a
    // spelling correction, so the paid-name lock still rejects it.
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Old",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [
          {
            guestId: "g1",
            firstName: "New",
            lastName: "Guest",
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("spelling corrections"),
    });
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("allows an identity-preserving typo fix after the booking is fully paid (#1386)", async () => {
    // "Jhon" -> "John" is a single-transposition spelling fix on a free-text
    // non-member guest: allowed after payment, price-preserving, audited.
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Jhon",
          lastName: "Doe",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [
          {
            guestId: "g1",
            firstName: "John",
            lastName: "Doe",
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({
          firstName: "John",
          lastName: "Doe",
          // Price-preserving: the stored per-guest price is echoed back.
          priceCents: 5000,
        }),
      })
    );
    // Identity-only path is taken: no pricing engine, no capacity recheck.
    expect(tx.season.findMany).not.toHaveBeenCalled();
    expect(mockCheckCapacity).not.toHaveBeenCalled();
    // The booking total is untouched.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalPriceCents: 5000,
          finalPriceCents: 5000,
        }),
      })
    );
    // Audited with the post-payment discriminator and zero price delta.
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modificationType: "GUEST_TYPO_FIX",
          priceDiffCents: 0,
          changeFeeCents: 0,
          previousData: expect.objectContaining({
            updatedGuests: [
              { guestId: "g1", firstName: "Jhon", lastName: "Doe" },
            ],
          }),
          newData: expect.objectContaining({
            paidNameTypoFix: true,
            updatedGuests: [
              { guestId: "g1", firstName: "John", lastName: "Doe" },
            ],
          }),
        }),
      })
    );
  });

  it("rejects a paid typo fix combined with a structural change (#1386)", async () => {
    // A structural change (here a promo code) makes the request no longer
    // identity-only, so the typo exemption does not apply and the hard lock
    // rejects the name edit with the original message.
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Jhon",
          lastName: "Doe",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [{ guestId: "g1", firstName: "John", lastName: "Doe" }],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("fully paid"),
    });
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("still rejects renaming a member-linked guest on a fully paid booking (#1386)", async () => {
    // Member-linked guests are never renamed on a booking, typo or not — the
    // #1386 exemption is only for free-text non-member guests.
    const booking = makeBooking({
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        // "Alise" -> "Alice" would be a typo fix for a free-text guest, but a
        // member-linked guest is blocked outright.
        guestUpdates: [{ guestId: "g1", firstName: "Alise", lastName: "Member" }],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Member guest names cannot be edited"),
    });
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("rejects the whole request atomically when one of two paid name edits is a swap (#1386)", async () => {
    // A valid typo (g1: Jhon -> John) bundled with a swap (g2: Old Guest ->
    // New Guest) must fail the entire request; neither guest may be renamed.
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Jhon",
          lastName: "Doe",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Old",
          lastName: "Guest",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 2500,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        guestUpdates: [
          { guestId: "g1", firstName: "John", lastName: "Doe" },
          { guestId: "g2", firstName: "New", lastName: "Guest" },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("spelling corrections"),
    });
    // Atomic reject: neither the valid typo nor the swap is applied.
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
    expect(tx.bookingModification.create).not.toHaveBeenCalled();
  });

  it("marks a payment-pending booking paid when a batch edit promo reduces the total to zero", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.booking.status).toBe("PAID");
    expect(data.booking.finalPriceCents).toBe(0);

    // F20 (#1887): the $0 payment mirror now stamps creditAppliedCents (0 here,
    // no credit) so amountCents + creditAppliedCents = finalPriceCents holds.
    expect(tx.payment.upsert).toHaveBeenCalledWith({
      where: { bookingId: "bk1" },
      create: {
        bookingId: "bk1",
        amountCents: 0,
        creditAppliedCents: 0,
        status: "SUCCEEDED",
      },
      update: {
        amountCents: 0,
        creditAppliedCents: 0,
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    expect(tx.paymentTransaction.findMany).toHaveBeenCalledWith({
      where: {
        paymentId: "pay_1",
        kind: "PRIMARY",
        source: "STRIPE",
        status: { in: ["PENDING", "PROCESSING"] },
        stripePaymentIntentId: { not: null },
        amountCents: { gt: 0, not: 0 },
      },
      select: {
        id: true,
        stripePaymentIntentId: true,
        amountCents: true,
      },
    });
    expect(mockEnqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "pay_1",
      paymentTransactionId: "ptx_pending",
      paymentIntentId: "pi_pending",
      amountCents: 6000,
      store: tx,
    });
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledWith({ limit: 1 });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAID",
          finalPriceCents: 0,
        }),
      })
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("bk1", {
      createdByMemberId: "m1",
    });
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("rolls back the modification when the in-transaction recovery enqueue throws", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);

    mockTransaction.mockImplementation(async (fn: (innerTx: typeof tx) => unknown) => {
      // A real prisma.$transaction would rethrow the callback error and not
      // commit the transaction. Mirror that here so the route's outer catch
      // returns a 4xx/5xx.
      return await fn(tx);
    });

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });
    mockEnqueuePaymentIntentCancellationRecovery.mockRejectedValueOnce(
      new Error("recovery upsert failed inside transaction")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(tx.bookingModification.create).not.toHaveBeenCalled();
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("still succeeds when immediate queued Stripe recovery processing fails", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });
    mockProcessPaymentRecoveryOperations.mockRejectedValueOnce(
      new Error("Stripe unavailable")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(mockEnqueuePaymentIntentCancellationRecovery).toHaveBeenCalled();
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledWith({ limit: 1 });
  });

  it("queues a primary Xero invoice update for zero-net batch date changes", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        checkIn: "2026-08-24",
        checkOut: "2026-08-26",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.additionalAmountCents).toBe(0);
    expect(data.refundAmountCents).toBe(0);

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod_1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
  });

  it("shortens an in-progress completed booking from NZ tomorrow without deleting past guest occupancy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            stayStart: new Date("2026-08-20T00:00:00.000Z"),
            stayEnd: new Date("2026-08-24T00:00:00.000Z"),
            // #3031: an in-progress edit prices from the stored sold-price rows
            // and refuses to invent an amount when there are none. Four nights
            // at 2500 summing to the stored 10000 below.
            nights: [
              { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-22T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-23T00:00:00.000Z"), priceCents: 2500 },
            ],
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          bookingId: "bk1",
          amountCents: 10000,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_original",
          xeroInvoiceId: "inv_primary",
          stripeCustomerId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          checkOut: "2026-08-22",
          removeGuestIds: ["g1"],
          settlementMethod: "card",
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.refundAmountCents).toBe(5000);
      expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
      expect(tx.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g1" },
        data: {
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
          priceCents: 5000,
        },
      });

      await Promise.resolve();
      expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
        {
          bookingId: "bk1",
          refundAmountCents: 5000,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "m1",
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("COMMITS the save, writes NULL for what it cannot price, and parks exactly one task (#3170)", async () => {
    // THE APPLY HALF of the issue's quote/apply parity criterion. The parity
    // suite proves the quote and the save reach the same discriminated VALUE;
    // it does not prove what the save route DOES with the review branch.
    //
    // #3031 REFUSED here and this case asserted the 409. #3170 replaced that
    // with a park on the owner's decision of 30 Aug 2026, so asserting a refusal
    // would now pin behaviour that was deliberately removed. The property being
    // protected is the stronger one: the structural change commits, the money
    // does not move, and the unknown is STORED as unknown rather than as a
    // number.
    //
    // The same in-progress shortening as the case above, on a strand whose
    // stored rows do not add up to its stored total (9000 against 10000). That
    // is INV-MOD-028's `STORED_TOTAL_MISMATCH`: the club cannot say what the
    // surrendered nights were sold for, so the amount needs a person and there
    // is no number on the review branch to fall back to.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            stayStart: new Date("2026-08-20T00:00:00.000Z"),
            stayEnd: new Date("2026-08-24T00:00:00.000Z"),
            // Four priced nights that come to 9000, against a stored total of
            // 10000. Nothing is missing; the evidence simply does not add up.
            nights: [
              { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-22T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-23T00:00:00.000Z"), priceCents: 1500 },
            ],
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          bookingId: "bk1",
          amountCents: 10000,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_original",
          xeroInvoiceId: "inv_primary",
          stripeCustomerId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
      const { sendBookingModifiedEmail } = await import("@/lib/email");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          checkOut: "2026-08-22",
          removeGuestIds: ["g1"],
          settlementMethod: "card",
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      // THE STRUCTURAL HALF COMMITTED. The strand's stay is shortened, its night
      // rows are rewritten and the change is on the history — which is what
      // "park" means and what a refusal could not give.
      expect(tx.bookingGuest.update).toHaveBeenCalled();
      expect(tx.bookingGuestNight.createMany).toHaveBeenCalled();
      expect(tx.bookingModification.create).toHaveBeenCalled();

      // EVERY RETAINED NIGHT KEEPS ITS STORED PRICE, BYTE FOR BYTE. This strand
      // is a `STORED_TOTAL_MISMATCH`: its rows are individually readable (they
      // simply do not add up to the stored total), so the park preserves them
      // rather than blanking them. Writing NULL over a number the club DOES have
      // would be its own kind of damage, and this is what stops it.
      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ stayDate: Date; priceCents: number | null }>;
        }
      ).data;
      expect(
        nightRows.map((row) => ({
          date: row.stayDate.toISOString().slice(0, 10),
          priceCents: row.priceCents,
        })),
      ).toEqual([
        { date: "2026-08-20", priceCents: 2500 },
        { date: "2026-08-21", priceCents: 2500 },
      ]);

      // The strand's own stored total is NOT rewritten. What this edit does to
      // it is the question the OPEN task exists to answer.
      const guestUpdate = tx.bookingGuest.update.mock.calls[0][0] as {
        data: { priceCents?: number };
      };
      expect(guestUpdate.data.priceCents).toBe(10000);

      // AND THE MONEY DID NOT MOVE. Each of these is a separate door, and the
      // park has to close every one of them: no payment row rewritten, no
      // refund sent, no credit note enqueued, and the response's own deltas are
      // zero because the booking's money genuinely did not move.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(
        mockEnqueueXeroModificationCreditNoteOperation,
      ).not.toHaveBeenCalled();
      expect(data.priceDiffCents).toBe(0);
      expect(data.changeFeeCents).toBe(0);
      expect(data.refundAmountCents).toBe(0);
      expect(data.accountCreditAmountCents).toBe(0);

      // EXACTLY ONE TASK, carrying NO AMOUNT. A number here would be the guess
      // the whole epic exists to avoid, so `raisedAmountCents` is asserted as
      // null rather than merely "not the wrong number".
      expect(tx.manualRefundTask.create).toHaveBeenCalledTimes(1);
      const raised = tx.manualRefundTask.create.mock.calls[0][0] as {
        data: { raisedAmountCents: number | null; kind: string };
      };
      expect(raised.data.raisedAmountCents).toBeNull();
      expect(raised.data.kind).toBe("EDIT_FINANCIAL_REVIEW");

      await Promise.resolve();
      // The member is told, because the change DID happen to their booking.
      expect(sendBookingModifiedEmail).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The shared fixture for the two cases below: a strand whose rows are
   * PARTIALLY readable. Three nights carry real money and one carries a
   * negative, which INV-MOD-028 classifies as an ABSENCE of usable evidence
   * rather than as a cheap night — trusting it would invert the edit.
   *
   * Shortening the stay to the 22nd leaves the guest holding the 20th and the
   * 21st, so the edit RETAINS one readable night and one unreadable one. That is
   * the shape #3170 exists for: there is no honest number for the 21st, and
   * before this change the column could not say so.
   */
  const partiallyReadableInProgressBooking = () =>
    makeBooking({
      status: "COMPLETED",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-24T00:00:00.000Z"),
          nights: [
            { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
            // Not money. Pre-#2744 arithmetic could write one of these, and it
            // is deliberately NOT a missing row: the row exists, and what it
            // holds cannot be a price.
            { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: -100 },
            { stayDate: new Date("2026-08-22T00:00:00.000Z"), priceCents: 2500 },
            { stayDate: new Date("2026-08-23T00:00:00.000Z"), priceCents: 2500 },
          ],
          priceCents: 10000,
        },
      ],
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 10000,
        source: "STRIPE",
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_original",
        xeroInvoiceId: "inv_primary",
        stripeCustomerId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });

  const shortenInProgressStay = () =>
    new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        checkOut: "2026-08-22",
        removeGuestIds: ["g1"],
        settlementMethod: "card",
      }),
    });

  it("stores a retained night it cannot price as NULL, never as 0 (#3170)", async () => {
    // THE CENTRAL ASSERTION OF #3170, and it is made against the value that
    // REACHES THE DATABASE rather than against anything a formatter produced.
    //
    // A zero would satisfy every arithmetic check in this file — it sums, it is
    // a non-negative integer, it reconciles — and it would be a lie the NEXT
    // edit reads back as evidence that the member paid nothing for that night.
    // A comped night legitimately stores 0, which is exactly why 0 cannot also
    // mean "not known". So this asserts `null` and, separately, that it is not
    // `0`: `toBeNull` alone would still pass if someone later widened the
    // assertion, and the pair says which of the two failures happened.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    try {
      const booking = partiallyReadableInProgressBooking();
      const tx = makeTx(booking);
      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx),
      );
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
      const response = await PUT(shortenInProgressStay(), {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ stayDate: Date; priceCents: number | null }>;
        }
      ).data;
      const written = nightRows.map((row) => ({
        date: row.stayDate.toISOString().slice(0, 10),
        priceCents: row.priceCents,
      }));
      expect(written).toEqual([
        // Readable, so preserved byte for byte.
        { date: "2026-08-20", priceCents: 2500 },
        // Not readable, so recorded as not known.
        { date: "2026-08-21", priceCents: null },
      ]);
      // Said twice on purpose — see the comment above.
      expect(written[1].priceCents).toBeNull();
      expect(written[1].priceCents).not.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises nothing further when the same parked edit is replayed (#3170)", async () => {
    // The idempotency the park depends on. The raise is a find-then-create on
    // the occurrence key; a replay must return the task ALREADY ON FILE rather
    // than create a second one — and rather than throw a unique violation,
    // which would roll this edit's structural half back with it and undo a save
    // the member was told had succeeded.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    try {
      const booking = partiallyReadableInProgressBooking();
      const tx = makeTx(booking);
      // The first run's task, already on file under this occurrence's key.
      tx.manualRefundTask.findUnique.mockResolvedValue({
        id: "task_1",
        status: "OPEN",
        kind: "EDIT_FINANCIAL_REVIEW",
      } as never);
      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx),
      );
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
      const response = await PUT(shortenInProgressStay(), {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      // The control for the assertion below: the raise DID run and DID look.
      expect(tx.manualRefundTask.findUnique).toHaveBeenCalled();
      expect(tx.manualRefundTask.create).not.toHaveBeenCalled();
      // And still no money, on the replay as on the first run.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a member correct a name on a booking with an unknown night, and preserves it (#3170)", async () => {
    // THE IDENTITY ECHO copies a booking's rows straight back on an edit that
    // changes only a name, and it used to refuse anything that was not a number.
    // A parked booking's rows now carry NULLs, and that edit is not
    // money-affecting, so it passes the pending-review fence and reaches the
    // echo — which means refusing here would refuse a member a typo correction
    // on a booking whose amount an officer has yet to confirm.
    //
    // Byte-for-byte preservation is the echo's whole promise, so a row that says
    // "not known" is preserved as that. Writing a number instead would invent the
    // very figure the review exists to establish.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    try {
      // A strand carrying a real NULL night — one a parked edit wrote earlier —
      // held by a NON-member. Two deliberate differences from the parked fixture
      // above:
      //
      //  - a member guest's name is owned by their member record and cannot be
      //    edited on a booking at all, which is a different refusal and not the
      //    one under test;
      //  - the unreadable night here is `null`, not a negative. The echo's
      //    promise is BYTE-FOR-BYTE preservation, so it echoes a negative
      //    unchanged (repairing damaged rows is #2745's audited decision, not
      //    this echo's) — and `null` is the value #3170 added, so `null` is what
      //    this case has to carry.
      const base = partiallyReadableInProgressBooking();
      const booking = {
        ...base,
        guests: [
          {
            ...base.guests[0],
            isMember: false,
            memberId: null,
            // `makeBooking`'s declared guest type does not carry `nights` — the
            // fixture builder attaches them — so the read is spelled out here
            // rather than left to inference.
            nights: (
              base.guests[0] as unknown as {
                nights: Array<{ stayDate: Date; priceCents: number | null }>;
              }
            ).nights.map((night) =>
              night.priceCents === -100
                ? { stayDate: night.stayDate, priceCents: null }
                : night,
            ),
          },
        ],
      };
      const tx = makeTx(booking);
      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx),
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
      const request = new NextRequest(
        "http://localhost/api/bookings/bk1/modify",
        {
          method: "PUT",
          body: JSON.stringify({
            guestUpdates: [
              { guestId: "g1", firstName: "Alicia", lastName: "Member" },
            ],
          }),
        },
      );
      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      // The control: this really is the identity echo, so no pricing ran and no
      // review task was raised — a name is not a money question.
      expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
      expect(tx.manualRefundTask.create).not.toHaveBeenCalled();

      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ stayDate: Date; priceCents: number | null }>;
        }
      ).data;
      expect(
        nightRows.map((row) => ({
          date: row.stayDate.toISOString().slice(0, 10),
          priceCents: row.priceCents,
        })),
      ).toEqual([
        { date: "2026-08-20", priceCents: 2500 },
        // Preserved as the absence it is, rather than refused and rather than
        // filled in.
        { date: "2026-08-21", priceCents: null },
        { date: "2026-08-22", priceCents: 2500 },
        { date: "2026-08-23", priceCents: 2500 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds guests to an in-progress completed booking from NZ tomorrow only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            stayStart: new Date("2026-08-20T00:00:00.000Z"),
            stayEnd: new Date("2026-08-24T00:00:00.000Z"),
            // #3031: an in-progress edit prices from the stored sold-price rows
            // and refuses to invent an amount when there are none. Four nights
            // at 2500 summing to the stored 10000 below.
            nights: [
              { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-22T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-23T00:00:00.000Z"), priceCents: 2500 },
            ],
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          bookingId: "bk1",
          amountCents: 10000,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_original",
          xeroInvoiceId: "inv_primary",
          stripeCustomerId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          addGuests: [
            {
              firstName: "Bob",
              lastName: "Guest",
              ageTier: "ADULT",
              isMember: false,
            },
          ],
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.additionalAmountCents).toBe(6000);
      expect(tx.bookingGuest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingId: "bk1",
          firstName: "Bob",
          stayStart: new Date("2026-08-22T00:00:00.000Z"),
          stayEnd: new Date("2026-08-24T00:00:00.000Z"),
          priceCents: 6000,
        }),
      });

      await Promise.resolve();
      expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
        {
          bookingId: "bk1",
          priceDiffCents: 6000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "m1",
          paymentIntentId: "pi_batch",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects in-progress member attempts to change check-in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          checkIn: "2026-08-21",
          checkOut: "2026-08-24",
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Check-in cannot be changed for an in-progress booking");
      expect(tx.booking.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 with a structured error envelope when the request body is not valid JSON", async () => {
    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: "{not json",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid JSON");
    expect(data.details).toEqual({
      body: ["Request body must be valid JSON"],
    });
  });

  it("enqueues refund recovery when the Stripe refund call fails after a price-decrease modification", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    // Two guests at $50 each = $100, dropping to one guest = $50 → refund $50
    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      });

    mockRefundPaymentTransactions.mockRejectedValueOnce(
      new Error("Stripe is unavailable")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"], settlementMethod: "card" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(5000);
    expect(data.stripeRefundId).toBeNull();

    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000 })
    );
    expect(mockEnqueueBookingModificationRefundRecovery).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "pay_1",
      bookingModificationId: "mod_1",
      amountCents: 5000,
      // The recovery row carries the route's exact Stripe key prefix (#1152)
      // so retries replay identical keys.
      stripeKeyPrefix: "mod_batch_refund_bk1_mod_1",
    });
    // Nonzero price changes supersede pending primary intents stranded at
    // any other amount (#1161).
    expect(tx.paymentTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "PRIMARY",
          amountCents: { gt: 0, not: 5000 },
        }),
      }),
    );
  });

  it("keeps paid Internet Banking reductions out of Stripe refund recovery", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment = {
      ...booking.payment!,
      amountCents: 10000,
      source: "INTERNET_BANKING",
      stripePaymentIntentId: null,
      stripeCustomerId: null,
      xeroInvoiceId: "inv_ib_1",
    };

    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"], settlementMethod: "card" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(5000);
    expect(data.stripeRefundId).toBeNull();
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(mockEnqueueBookingModificationRefundRecovery).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 5000,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("corrects an unpaid pay-on-account Xero invoice for the full delta on a batch reduction (#1015)", async () => {
    const booking = makeBooking({
      status: "CONFIRMED",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
    });
    // Pay-on-account: Xero invoice issued but not yet paid, so no captured
    // payment. hasCapturedPayment() is false, settlementOptions is null, and
    // before the fix xeroRefundAmountCents collapsed to 0 -> classify 'none'
    // -> the outstanding invoice kept the removed guest.
    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.payment = {
      ...booking.payment!,
      amountCents: 10000,
      status: "PENDING",
      source: "INTERNET_BANKING",
      stripePaymentIntentId: null,
      stripeCustomerId: null,
      xeroInvoiceId: "inv_unpaid_1",
    };
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    // No settlementMethod: an unpaid invoice has no policy tier / captured
    // funds, so the endpoint must not demand a card/credit choice.
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(0);
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 5000,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("caps partially refunded Stripe reductions at the remaining refundable balance", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment = {
      ...booking.payment!,
      amountCents: 10000,
      status: "PARTIALLY_REFUNDED",
      refundedAmountCents: 6000,
    };

    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"], settlementMethod: "card" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(4000);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4000 })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 4000,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("rejects paid reductions without a settlement method", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;

    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Choose a refund or account credit before saving",
    });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("creates account credit and skips Stripe refund when credit is selected for a partial policy reduction", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;
    mockLoadCancellationPolicy.mockResolvedValueOnce([
      {
        daysBeforeStay: 0,
        refundPercentage: 50,
        creditRefundPercentage: 75,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ]);
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"], settlementMethod: "credit" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(0);
    expect(data.accountCreditAmountCents).toBe(3750);
    expect(data.settlementMethod).toBe("credit");
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(tx.memberCredit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "m1",
        amountCents: 3750,
        type: "BOOKING_MODIFICATION_REFUND",
        sourceBookingId: "bk1",
        sourceBookingModificationId: "mod_1",
      }),
    });
    // #1031: the credit settlement allocates against the payment in the same
    // transaction, keeping refundedAmountCents truthful for a later cancel.
    expect(mockApplyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "pay_1",
      amountCents: 3750,
      store: tx,
    });

    await Promise.resolve();
    expect(mockEnqueueXeroModificationAccountCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3750,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
      }
    );
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("does not require settlement or return value when reduction policy refund is zero", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;
    mockLoadCancellationPolicy.mockResolvedValueOnce([
      {
        daysBeforeStay: 0,
        refundPercentage: 0,
        creditRefundPercentage: 0,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ]);
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(0);
    expect(data.accountCreditAmountCents).toBe(0);
    expect(data.settlementMethod).toBeNull();
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(tx.memberCredit.create).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationAccountCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("ignores stale settlement method input when no reduction value is returnable", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    booking.guests = reconcilingNightRows(booking, [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ]);
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;
    mockLoadCancellationPolicy.mockResolvedValueOnce([
      {
        daysBeforeStay: 0,
        refundPercentage: 0,
        creditRefundPercentage: 0,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ]);
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"], settlementMethod: "credit" }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(0);
    expect(data.accountCreditAmountCents).toBe(0);
    expect(data.settlementMethod).toBeNull();
    expect(tx.memberCredit.create).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationAccountCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("persists per-guest stay range edits and checks capacity by active guest nights", async () => {
    const booking = makeBooking({
      status: "CONFIRMED",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-22T00:00:00.000Z"),
      totalPriceCents: 12500,
      finalPriceCents: 12500,
      payment: null,
      guests: [
        {
          id: "g1",
          bookingId: "bk1",
          firstName: "Alice",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
          priceCents: 5000,
        },
        {
          id: "g2",
          bookingId: "bk1",
          firstName: "Bob",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: null,
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
          priceCents: 5000,
        },
      ],
    });
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 12500,
      guests: [
        { priceCents: 5000, perNightCents: [2500, 2500] },
        { priceCents: 7500, perNightCents: [2500, 2500, 2500] },
      ],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        checkOut: "2026-08-24",
        guestStayRanges: [
          {
            guestId: "g1",
            stayStart: "2026-08-20",
            stayEnd: "2026-08-22",
          },
          {
            guestId: "g2",
            stayStart: "2026-08-21",
            stayEnd: "2026-08-24",
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(mockCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      new Date("2026-08-20T00:00:00.000Z"),
      new Date("2026-08-24T00:00:00.000Z"),
      [
        expect.objectContaining({
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
        }),
        expect.objectContaining({
          stayStart: new Date("2026-08-21T00:00:00.000Z"),
          stayEnd: new Date("2026-08-24T00:00:00.000Z"),
        }),
      ],
      "bk1",
      tx
    );
    expect(mockCalculateBookingPrice).toHaveBeenCalledWith(
      new Date("2026-08-20T00:00:00.000Z"),
      new Date("2026-08-24T00:00:00.000Z"),
      [
        expect.objectContaining({
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
        }),
        expect.objectContaining({
          stayStart: new Date("2026-08-21T00:00:00.000Z"),
          stayEnd: new Date("2026-08-24T00:00:00.000Z"),
        }),
      ],
      expect.any(Array),
      undefined
    );
    expect(tx.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: {
        stayStart: new Date("2026-08-20T00:00:00.000Z"),
        stayEnd: new Date("2026-08-22T00:00:00.000Z"),
        priceCents: 5000,
      },
    });
    expect(tx.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g2" },
      data: {
        stayStart: new Date("2026-08-21T00:00:00.000Z"),
        stayEnd: new Date("2026-08-24T00:00:00.000Z"),
        priceCents: 7500,
      },
    });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkIn: new Date("2026-08-20T00:00:00.000Z"),
          checkOut: new Date("2026-08-24T00:00:00.000Z"),
        }),
      })
    );
  });

  // Issue #1696: the per-edit member-email choice now applies to EVERY admin
  // edit, not just admin overrides. bookingManagementAuthorizationRole is the
  // real function here, so a Full Admin session resolves to the ADMIN actor the
  // service honours the choice for.
  const FULL_ADMIN_SESSION = {
    user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
  };

  async function runZeroNetDateChange(body: Record<string, unknown>) {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx),
    );
    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");
    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-24", checkOut: "2026-08-26", ...body }),
    });
    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });
    // Flush the awaited post-transaction dispatch's fire-and-forget email.
    await Promise.resolve();
    return response;
  }

  it("suppresses the member email and audits the choice when an admin sets notifyMember: false on a plain edit (#1696)", async () => {
    mockAuth.mockResolvedValue(FULL_ADMIN_SESSION);

    const response = await runZeroNetDateChange({ notifyMember: false });
    expect(response.status).toBe(200);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).not.toHaveBeenCalled();

    const { logAudit } = await import("@/lib/audit");
    const auditCall = vi
      .mocked(logAudit)
      .mock.calls.find(
        (call) => (call[0] as { action: string }).action === "booking.modify.batch",
      );
    expect(auditCall).toBeDefined();
    expect(
      (auditCall![0] as { metadata: Record<string, unknown> }).metadata
        .notifyMember,
    ).toBe(false);
  });

  it("emails the member by default when an admin omits notifyMember (#1696)", async () => {
    mockAuth.mockResolvedValue(FULL_ADMIN_SESSION);

    const response = await runZeroNetDateChange({});
    expect(response.status).toBe(200);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).toHaveBeenCalledTimes(1);
  });

  it("tells the member their money is still being worked out (#3032)", async () => {
    /*
      THE WIRE #3033 LEFT DEAD. `financialReviewPending` was optional and
      defaulted to false, and no production caller set it - so the sentence
      #3033 added to the email could not reach a member from this path at all.

      This path raises no review of its own (the batch park is #3170, held on an
      owner money decision), so the honest question is not "did this edit park
      money" but "is the club still working out an amount on this booking". The
      value therefore comes from the real `bookingHasOpenFinancialReview` read,
      and this test drives it by putting an OPEN review row in front of that
      read rather than by handing the route a literal.

      Note the fence's own `findFirst` stays empty, so the edit proceeds. That
      is not a contrived pairing: the fence reads inside the transaction and
      this reads after it commits, so a review opened by another lane in between
      produces exactly this state.
    */
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.manualRefundTask.findMany).mockResolvedValue([
      { bookingId: "bk1" },
    ] as never);

    const response = await runZeroNetDateChange({});
    expect(response.status).toBe(200);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ financialReviewPending: true }),
    );
  });

  it("says nothing about a review when the booking has none (#3032)", async () => {
    // The CONTROL. Hard-code `true` at the call site and this fails; hard-code
    // `false` and the case above fails. Only a real read passes both.
    //
    // The empty result is set EXPLICITLY rather than relied on from the mock's
    // declaration: `vi.clearAllMocks()` clears recorded calls but keeps
    // implementations, so the row the case above installed survives into this
    // test and this control silently inverted until it was stated here.
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.manualRefundTask.findMany).mockResolvedValue([] as never);

    const response = await runZeroNetDateChange({});
    expect(response.status).toBe(200);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ financialReviewPending: false }),
    );
  });

  it("always emails a member self-edit by default (#1696)", async () => {
    // Default session (a plain member owner) resolves to the USER actor, whose
    // edits always notify.
    const response = await runZeroNetDateChange({});
    expect(response.status).toBe(200);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).toHaveBeenCalledTimes(1);
  });

  it("rejects notifyMember from a member self-edit with 403 under real role resolution (#1696)", async () => {
    // Default session resolves to the USER actor via the REAL
    // bookingManagementAuthorizationRole, so any notify flag is refused before
    // the service runs — a member can never suppress their own notification.
    const response = await runZeroNetDateChange({ notifyMember: false });
    expect(response.status).toBe(403);

    const { sendBookingModifiedEmail } = await import("@/lib/email");
    expect(vi.mocked(sendBookingModifiedEmail)).not.toHaveBeenCalled();
  });

  /**
   * #3032 (epic #2797): the pending-review fence on the BATCH edit path.
   *
   * The rule is "a second money-affecting edit is fenced when it would need
   * unresolved money as its baseline; identity-only changes stay independent where
   * safe". The service's own name for that split is `pricePreservingModification`,
   * and the fence asks it rather than re-deriving it — an earlier revision asked a
   * second expression that differed by one term, which is the case pinned below.
   */
  describe("#3032 pending financial review fences a batch edit", () => {
    const openReview = {
      id: "task-open",
      occurrenceKey: "edit-financial-review:v1:abc",
      amountCents: null,
      raisedAmountCents: null,
      reviewContext: null,
    };

    function twoGuestBooking({
      memberGuest = true,
    }: { memberGuest?: boolean } = {}) {
      return makeBooking({
        status: "PAYMENT_PENDING",
        payment: {
          id: "p1",
          bookingId: "bk1",
          amountCents: 5000,
          source: "STRIPE",
          status: "PENDING",
          stripePaymentIntentId: "pi_1",
          xeroInvoiceId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: memberGuest ? "Member" : "Visitor",
            ageTier: "ADULT",
            isMember: memberGuest,
            memberId: memberGuest ? "m1" : null,
            priceCents: 2500,
          },
          {
            id: "g2",
            bookingId: "bk1",
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            memberId: null,
            priceCents: 2500,
          },
        ],
      });
    }

    async function runBatch(
      tx: ReturnType<typeof makeTx>,
      input: Record<string, unknown>,
    ) {
      const { modifyBookingBatch } = await import(
        "@/lib/booking-batch-modification-service"
      );
      return modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "bk1",
        // ADMIN, because the other-lodge election below is officer-only. The fence
        // is about the booking's money, not about who is asking, so using one
        // actor throughout keeps the cases comparable.
        actor: { id: "officer-1", role: "ADMIN" },
        input: input as never,
        ipAddress: "127.0.0.1",
        tx: tx as never,
        preTransaction: TX_MODE_PRE_TRANSACTION,
      });
    }

    it("refuses a structural edit while the booking's money is under review", async () => {
      const tx = makeTx(twoGuestBooking());
      tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

      await expect(
        runBatch(tx, {
          addGuests: [
            { firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false },
          ],
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "EDIT_FINANCIAL_REVIEW_PENDING",
      });

      // Refused BEFORE anything is priced or written, so the booking is untouched.
      expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
      expect(tx.booking.update).not.toHaveBeenCalled();
      expect(tx.bookingModification.create).not.toHaveBeenCalled();
    });

    it("lets a name correction through — it reads no stored money, so it compounds nothing", async () => {
      const tx = makeTx(twoGuestBooking());
      tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

      const result = await runBatch(tx, {
        guestUpdates: [{ guestId: "g2", firstName: "Robert", lastName: "Smith" }],
      });

      expect(result.priceDiffCents).toBe(0);
      expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
      // The fence never even queried: `moneyAffecting` is false, so it returns
      // without a read.
      expect(tx.manualRefundTask.findFirst).not.toHaveBeenCalled();
    });

    it("REGRESSION: a name correction carrying an other-lodge election IS fenced", async () => {
      // The shape that slipped through. `requestedStructuralChange` deliberately
      // excludes the other-lodge fields (#2978 kept them out so the quote-priced
      // exemptions keep the meaning `modify-quote` gives them), so this request is
      // "identity-only" by that test — and then reprices anyway, because an
      // other-lodge election re-rates guests. A fence asking anything other than
      // `pricePreservingModification` lets it past and re-rates the party off
      // stored money that is under review. The route's own schema accepts both
      // fields on one PUT, so this is a reachable request, not a contrived one.
      // No member-flagged guest, so the eligibility resolver short-circuits with
      // no query and the election reaches the fence on this harness.
      const tx = Object.assign(makeTx(twoGuestBooking({ memberGuest: false })), {
        otherLodge: {
          findUnique: vi.fn().mockResolvedValue({ id: "lodge-other" }),
        },
      });
      tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

      await expect(
        runBatch(tx, {
          guestUpdates: [{ guestId: "g2", firstName: "Robert", lastName: "Smith" }],
          otherLodgeId: "lodge-other",
          otherLodgeMemberGuestIds: ["g2"],
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "EDIT_FINANCIAL_REVIEW_PENDING",
      });

      expect(mockCalculateBookingPrice).not.toHaveBeenCalled();
      expect(tx.booking.update).not.toHaveBeenCalled();
    });

    it("CONTROL: the same structural edit succeeds when no review is open", async () => {
      // Without this the three cases above would still pass against a fence that
      // refused every edit.
      const tx = makeTx(twoGuestBooking());
      tx.manualRefundTask.findFirst.mockResolvedValue(null);
      mockCalculateBookingPrice.mockReturnValue({
        totalPriceCents: 7500,
        guests: [
          { priceCents: 2500, perNightCents: [2500], nightDates: [] },
          { priceCents: 2500, perNightCents: [2500], nightDates: [] },
          { priceCents: 2500, perNightCents: [2500], nightDates: [] },
        ],
      });

      const result = await runBatch(tx, {
        addGuests: [
          { firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false },
        ],
      });

      expect(result.priceDiffCents).toBe(2500);
      expect(tx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ finalPriceCents: 7500 }),
        }),
      );
      // The fence DID run and passed — it is not silently absent on this path.
      expect(tx.manualRefundTask.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * #3166 (epic #2797): the gate on the path members actually use — an edit to a
   * booking that has NOT started yet.
   *
   * Until this existed the gate ran only for a stay already under way, so the same
   * booking with the same defect in its data got opposite answers depending on
   * which side of check-in the edit landed on, and the wrong answer was the common
   * case: the ordinary pricing pass valued any night without a usable stored row
   * at today's rate and `syncGuestNights` wrote that number into
   * `BookingGuestNight.priceCents`, where the NEXT edit read it back as evidence.
   *
   * The frozen clock puts "today" at 2026-07-01, so the default fixture's stay
   * (20-22 Aug 2026) is entirely in the future and every case here is pre-check-in
   * by construction.
   *
   * WHAT THESE CASES ARE FOR is the question the owner's decision turned on. When
   * the gate was widened the recorded cost was that some member edits would FAIL
   * until an admin priced them. #3170 landed parking on this path first, so what
   * should actually happen is a SAVE plus a review — and "should" is not evidence.
   * Each case below asserts which of the two the member gets.
   */
  describe("#3166 an edit to a booking that has not started is judged on stored evidence", () => {
    /** A pre-check-in booking whose single strand carries no stored night rows. */
    function unreadableBooking() {
      return makeBooking({
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1" as string | null,
            priceCents: 5000,
            // Explicitly none — a legacy strand, or one from a booking created by
            // approving a request (#2739). Stated rather than omitted so the
            // fixture's own reconciling default cannot quietly fill them in.
            nights: [] as Array<{ stayDate: Date; priceCents: number | null }>,
          },
        ],
      });
    }

    async function runPreCheckInBatch(
      tx: ReturnType<typeof makeTx>,
      input: Record<string, unknown>,
    ) {
      const { modifyBookingBatch } = await import(
        "@/lib/booking-batch-modification-service"
      );
      return modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "bk1",
        actor: { id: "officer-1", role: "ADMIN" },
        input: input as never,
        ipAddress: "127.0.0.1",
        tx: tx as never,
        preTransaction: TX_MODE_PRE_TRANSACTION,
      });
    }

    beforeEach(() => {
      mockCalculateBookingPrice.mockImplementation(
        pricesNightsHandedIn(2500, 3000) as never,
      );
    });

    it("SAVES AND PARKS a check-out extension rather than refusing it", async () => {
      // The shape the owner accepted a refusal for, measured. It does not refuse:
      // the stay moves, no money moves, and one task is raised.
      const tx = makeTx(unreadableBooking());

      const result = await runPreCheckInBatch(tx, { checkOut: "2026-08-23" });

      // The structural half committed.
      expect(tx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkOut: new Date("2026-08-23T00:00:00.000Z"),
            // And the money did not: the booking's own stored totals are written
            // back unchanged rather than recomposed.
            totalPriceCents: 5000,
            finalPriceCents: 5000,
          }),
        }),
      );
      expect(tx.bookingModification.create).toHaveBeenCalled();

      expect(result.priceDiffCents).toBe(0);
      expect(result.changeFeeCents).toBe(0);
      expect(result.refundAmountCents ?? 0).toBe(0);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();

      // Exactly one review task, carrying no amount.
      expect(tx.manualRefundTask.create).toHaveBeenCalledTimes(1);
      const raised = tx.manualRefundTask.create.mock.calls[0][0] as {
        data: { raisedAmountCents: number | null; kind: string };
      };
      expect(raised.data.kind).toBe("EDIT_FINANCIAL_REVIEW");
      expect(raised.data.raisedAmountCents).toBeNull();
    });

    it("writes NULL for every night it cannot value, and never a today's-rate guess", async () => {
      // THE DEFECT THIS ISSUE IS ABOUT. Before the gate these three nights were
      // written as 2500 each — today's rate for a night nobody had priced — and
      // the next edit read them back as what the member had paid.
      const tx = makeTx(unreadableBooking());

      await runPreCheckInBatch(tx, { checkOut: "2026-08-23" });

      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ stayDate: Date; priceCents: number | null }>;
        }
      ).data;
      expect(
        nightRows.map((row) => ({
          date: row.stayDate.toISOString().slice(0, 10),
          priceCents: row.priceCents,
        })),
      ).toEqual([
        { date: "2026-08-20", priceCents: null },
        { date: "2026-08-21", priceCents: null },
        { date: "2026-08-22", priceCents: null },
      ]);

      // And the strand's own stored total is not rewritten either.
      const guestUpdate = tx.bookingGuest.update.mock.calls[0][0] as {
        data: { priceCents?: number };
      };
      expect(guestUpdate.data.priceCents).toBe(5000);
    });

    it("preserves a readable night byte for byte while blanking only the unreadable one", async () => {
      // A PARTIAL strand: the 20th carries real money and the 21st carries a
      // negative, which INV-MOD-028 classifies as an absence of evidence rather
      // than a cheap night. Blanking the readable row too would be its own damage.
      const booking = makeBooking({
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1" as string | null,
            priceCents: 5000,
            nights: [
              { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: -100 },
            ],
          },
        ],
      });
      const tx = makeTx(booking);

      await runPreCheckInBatch(tx, { checkOut: "2026-08-23" });

      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ stayDate: Date; priceCents: number | null }>;
        }
      ).data;
      expect(
        nightRows.map((row) => ({
          date: row.stayDate.toISOString().slice(0, 10),
          priceCents: row.priceCents,
        })),
      ).toEqual([
        { date: "2026-08-20", priceCents: 2500 },
        { date: "2026-08-21", priceCents: null },
        // The night this edit newly puts the strand on. It is NOT priced at
        // today's rate: no money is moving for it, and a number here would be read
        // back by the next edit as evidence the member had paid it.
        { date: "2026-08-22", priceCents: null },
      ]);
    });

    it("records a REMOVED strand whose own rows were readable, so a parked edit destroys no number", async () => {
      // Two strands: g1 unreadable, g2 exact. Removing g2 deletes its rows, and
      // its BookingGuestNight history goes with them — so if only g1 were
      // recorded, the departing guest's refund would be a figure no longer present
      // anywhere in the database.
      const booking = makeBooking({
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1" as string | null,
            priceCents: 5000,
            nights: [] as Array<{ stayDate: Date; priceCents: number | null }>,
          },
          {
            id: "g2",
            bookingId: "bk1",
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            memberId: null as string | null,
            priceCents: 5000,
            nights: [
              { stayDate: new Date("2026-08-20T00:00:00.000Z"), priceCents: 2500 },
              { stayDate: new Date("2026-08-21T00:00:00.000Z"), priceCents: 2500 },
            ],
          },
        ],
      });
      const tx = makeTx(booking);

      await runPreCheckInBatch(tx, { removeGuestIds: ["g2"] });

      // The removal committed and no money moved.
      expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: "g2" } });
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();

      // TWO tasks: the unreadable strand, and the readable one whose evidence this
      // edit is about to delete.
      expect(tx.manualRefundTask.create).toHaveBeenCalledTimes(2);
      const occurrences = tx.manualRefundTask.create.mock.calls.map((call) => {
        const data = (call[0] as { data: { reviewContext: unknown } }).data;
        const context = data.reviewContext as {
          occurrence: { cause: string; bookingGuestId: string };
        };
        return context.occurrence;
      });
      expect(occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bookingGuestId: "g1",
            cause: "NO_STORED_NIGHT_PRICES",
          }),
          expect.objectContaining({
            bookingGuestId: "g2",
            cause: "COUNTERPART_STRAND_UNREADABLE",
          }),
        ]),
      );
    });

    it("CONTROL: the identical edit on a readable booking still prices and settles", async () => {
      // Without this, every case above would pass against a gate that parked
      // EVERY pre-check-in edit — which would be a far worse defect than the one
      // being fixed, and invisible from the assertions alone.
      const tx = makeTx(makeBooking());

      const result = await runPreCheckInBatch(tx, { checkOut: "2026-08-23" });

      expect(tx.manualRefundTask.create).not.toHaveBeenCalled();
      expect(result.priceDiffCents).toBe(2500);
      const nightRows = (
        tx.bookingGuestNight.createMany.mock.calls[0][0] as {
          data: Array<{ priceCents: number | null }>;
        }
      ).data;
      expect(nightRows.map((row) => row.priceCents)).toEqual([2500, 2500, 2500]);
    });
  });
});
