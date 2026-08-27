/**
 * Issue #1093 regression: edit paths must price existing guests over exactly
 * the nights they hold (their stored BookingGuestNight set), never the full
 * booking range. A partial-stay (gap) guest must not grow phantom nights —
 * priced at current season rates — because someone else was added or removed,
 * and a date change resets everyone to the full new range (the documented
 * batch-path policy) while re-syncing their night rows.
 *
 * Unlike fix-mod-payment.test.ts this harness keeps the REAL pricing engine
 * (calculateBookingPrice + membership-type policy wrapper) and fakes only the
 * database and side-effect leaf modules, so the assertions pin actual money
 * math end-to-end through each path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockTransaction = vi.fn();
const mockMemberCount = vi.fn();
const mockMemberFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as any)(fn);
      return Promise.resolve();
    },
    member: { count: mockMemberCount, findUnique: mockMemberFindUnique },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      // The ordinary-edit Xero lock-date guard's advisory pre-transaction
      // read (#1729); null skips the guard (the in-transaction re-read owns
      // the 404).
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // #1982: default lodge capacity is a self-healed DB override (the route's
    // getDefaultLodgeCapacity guest-count guard reads it off the singleton).
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  // Multi-lodge: edit-path repricing takes the per-lodge serialising lock.
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/change-fee", () => ({
  calculateChangeFee: vi.fn().mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 }),
}));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
  calculateDualRefundAmounts: vi.fn((basisAmountCents: number) => ({
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    creditRefundAmountCents: basisAmountCents,
    creditRefundPercentage: 100,
  })),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  }),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] }),
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
  processRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  createPaymentIntent: vi.fn().mockResolvedValue({ id: "pi_additional", client_secret: "secret" }),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_123" }),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
  cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "op1", message: "queued" }),
  enqueueXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({ queueOperationId: "op2", message: "queued" }),
  enqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({ queueOperationId: "op3", message: "queued" }),
  enqueueXeroSupplementaryInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "op4", message: "queued" }),
  enqueueXeroModificationCreditNoteOperation: vi.fn().mockResolvedValue({ queueOperationId: "op5", message: "queued" }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(null),
  recordSkippedXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({ queueOperationId: "op6", message: "skipped" }),
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: vi.fn().mockResolvedValue({ released: 0, queueOperationIds: [] }),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhook-log", () => ({ recordWebhookLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  refundPaymentTransactions: vi.fn().mockResolvedValue({
    refunds: [{ refundId: "re_1", paymentIntentId: "pi_original", amountCents: 0 }],
  }),
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  markPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue({}),
  markPaymentIntentTransactionFailed: vi.fn().mockResolvedValue({}),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  completeCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(undefined),
  queueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(undefined),
  queueRefundRecoveryOperation: vi.fn().mockResolvedValue(undefined),
  getStripePaymentMethodId: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: vi.fn().mockResolvedValue([]),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({ choreWarnings: [] }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({ choreWarnings: [] }),
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: vi.fn().mockResolvedValue(undefined),
  WAITLIST_OFFER_HOURS: 48,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: vi.fn().mockResolvedValue(undefined),
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn().mockResolvedValue({ id: "credit1" }),
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";

/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);

function makeSession() {
  return { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@test.com" } };
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-05T00:00:00.000Z"); // 4 nights: Aug 1-4

/**
 * Every scenario here edits a booking that has NOT started — that is the
 * "future" edit mode these self-service routes serve, and the prices asserted
 * below are the future-edit reprice. Left on the real clock the suite quietly
 * changed meaning once the NZ calendar date reached CHECK_IN: getBookingEditPolicy
 * then classifies the same fixture as "in-progress" and the routes correctly
 * answer 400 ("Use the full booking edit flow ..."). Pin the clock so the
 * scenario under test stays the intended one; the in-progress edit path has its
 * own deliberate coverage in batch-modify-payment.test.ts.
 *
 * Only `Date` is faked — real timers still run, so awaited promises resolve
 * normally. The booking dates are untouched, so seasonal rates and every money
 * assertion below are unchanged.
 */
const FIXED_NOW = new Date("2026-07-15T00:00:00.000Z"); // NZ 2026-07-15 12:00

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-08-0${day}T00:00:00.000Z`), priceCents };
}

/**
 * Booking with two guests booked at 5000/night when current member rate is
 * 6000: g1 stays all 4 nights; g2 is the gap-stay guest holding only Aug 1
 * and Aug 3 (stay envelope Aug 1-4, night set with a hole at Aug 2).
 */
function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
    // one. Omitting it here let the hosting participant fence compare
    // "bk1:m1:undefined" on both sides and pass vacuously (#2619).
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PAID",
    totalPriceCents: 30000,
    discountCents: 0,
    finalPriceCents: 30000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    requiresAdminReview: false,
    adminReviewStatus: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        // #2675: the hosting evaluator reads the LIVE Member row off this
        // relation, never the `isMember` snapshot beside it, and treats a null
        // consentStatus as "no consent was ever needed", i.e. operationally
        // present. A guest row claiming membership without a `member` relation
        // is a shape production cannot emit — the review's select always
        // hydrates it — and it does not degrade gracefully: `undefined !== null`
        // is true, so `memberIsInGoodStanding` reads `undefined.active` and the
        // seam throws the moment an active hosting mode lets the evaluator run.
        consentStatus: null,
        member: hostingMemberRow("m1"),
        priceCents: 20000,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
        nights: [night("1", 5000), night("2", 5000), night("3", 5000), night("4", 5000)],
      },
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Gappy",
        lastName: "Stayer",
        ageTier: "ADULT",
        isMember: true,
        // #1930, E4: a member guest resolves to its own (member) rate only via
        // a memberId; the rate resolver treats isMember-true-with-null-memberId
        // as a non-member. Give this member guest a memberId so it keeps the
        // member rate on reprice (see the note flagged to the orchestrator).
        memberId: "m2",
        // #2675, as for g1 — and the sparse night set above is what the hosting
        // evaluator counts for her, exactly as it is what the pricing engine
        // counts. `toHostingParticipants` prefers `nights` over the
        // stayStart..stayEnd envelope precisely so a gap stay is not credited
        // with the Aug 2 night she is not here for.
        consentStatus: null,
        member: hostingMemberRow("m2"),
        priceCents: 10000,
        stayStart: CHECK_IN,
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
        nights: [night("1", 5000), night("3", 5000)],
      },
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 30000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
}

const CURRENT_SEASON = [{
  id: "s1",
  startDate: new Date("2026-04-01T00:00:00.000Z"),
  endDate: new Date("2026-10-31T00:00:00.000Z"),
  // Membership-type-keyed rates (#1930, E4): FULL members 6000, NON_MEMBER 8000.
  membershipTypeRates: [
    { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 6000 },
    { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
  ],
}];

function makeTx(
  booking: ReturnType<typeof makeBooking>,
  options?: {
    groupDiscountSetting?: {
      enabled: boolean;
      minGroupSize: number;
      summerOnly: boolean;
      /**
       * #2770 (INV-MOD-026): whether a LATER EDIT earns the discount on the
       * nights it buys. Omitted means `true` below, which is the column's own
       * NOT NULL default and the behaviour every edit path already had — so a
       * case that does not mention it reads exactly as it did before #2770.
       */
      applyToEdits?: boolean;
    } | null;
  },
) {
  const fenceBooking = recordingBookingDouble(async () => booking);
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
    // over the whole proposed party from the booker's family groups, so the date
    // path reads these two rows before the person-night guard. This fixture is
    // about pricing and settlement, and was written when every member-linked
    // guest on it was the booker's own household — so that is what it says here,
    // rather than leaving the boundary to fall out of an empty mock.
    familyGroupMember: {
      findMany: vi.fn().mockImplementation(async (args: {
        where?: { familyGroupId?: unknown; memberId?: unknown };
      }) =>
        args?.where?.familyGroupId
          ? [
              booking.memberId,
              ...booking.guests.map(
                (guest: { memberId?: string | null }) => guest.memberId,
              ),
            ]
              .filter((memberId): memberId is string => Boolean(memberId))
              .map((memberId) => ({ memberId, familyGroupId: "fg-fixture" }))
          : [{ memberId: booking.memberId, familyGroupId: "fg-fixture" }],
      ),
    },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode, so the gate in front of the participant
    // fence lets these seams reach it. `[]` resolved to DISABLED and took the
    // gate's early return, switching the fence off in every scenario here.
    // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: under
    // ENFORCED a hosting violation REFUSES the booking write outright and
    // `settleSameOwnerDependentCoverage` fans out into coverage-incident and
    // queue writes this harness models nothing of, whereas review-only records a
    // snapshot and leaves every money assertion below untouched.
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    // #2619: the participant fence re-reads the locked Member rows and each
    // source booking's owner/lodge under the lock. An empty booking.findMany
    // made it report drift on data that never changed.
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment })),
    },
    bookingGuest: {
      // Person-night guard (#1157) queries member-linked guests on the new
      // range; no other live booking exists in these fixtures, so no conflict.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      // The group discount substitutes the FULL type for true non-members
      // (#1930, E4), preserving the old "upgrade non-members to member rate".
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options?.groupDiscountSetting
            ? {
                applyToEdits: true,
                ...options.groupDiscountSetting,
                rateMembershipTypeId: "type-full",
              }
            : null,
        ),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(CURRENT_SEASON) },
    // Multi-lodge: edit-path repricing resolves the booking's lodge via
    // getDefaultLodgeId when the booking carries none (single-lodge default).
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Rate resolver (#1930, E4): member guests (with a memberId) resolve to the
    // FULL type (role default) -> member rate; the built-in NON_MEMBER type
    // backs true non-members and the discount substitution.
    member: {
      // #2619: the participant fence's id-only re-read is answered by the
      // helper (which sorts, as the fence requires); the rate resolver's read
      // keeps the rows it always served. One delegate deliberately — a second
      // `member:` key in this literal would be silently overridden.
      findMany: fenceMemberFindMany([], async (args: unknown) =>
        ((args as { where?: { id?: { in?: string[] } } })?.where?.id?.in ?? []).map((id) => ({
          id,
          firstName: "Member",
          lastName: "Test",
          email: `${id}@test.com`,
          role: "MEMBER",
          ageTier: "ADULT",
        })),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL", bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED", name: "Full", isActive: true, isBuiltIn: true },
        { id: "type-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", subscriptionBehavior: "NOT_REQUIRED", name: "Non-Member", isActive: true, isBuiltIn: true },
      ]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  mockMemberCount.mockResolvedValue(1);
  mockMemberFindUnique.mockResolvedValue({
    id: "m1",
    active: true,
    email: "alice@test.com",
    firstName: "Alice",
  } as any);
  mockedAuth.mockResolvedValue(makeSession() as any);
  mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
  mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 20, nightDetails: [] } as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guest add prices existing guests over their stored nights (#1093)", () => {
  it("leaves a gap-stay guest's price untouched when another guest is added", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // New guest: 4 nights at the current 8000 rate (a member guest without a
    // linked memberId prices as non-member). The pre-fix bug additionally
    // added phantom Aug 2 + Aug 4 nights at 6000 to the gap-stay guest,
    // inflating the total by a further 12000 (74000 in all).
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(30000 + 32000);
    expect(bookingUpdate.finalPriceCents).toBe(62000);

    // The added guest joins the uniform night-row model: one row per night.
    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.nights.create).toHaveLength(4);
    expect(createArgs.nights.create.map((n: any) => n.priceCents)).toEqual([8000, 8000, 8000, 8000]);
  });
});

describe("guest removal prices remaining guests over their stored nights (#1093)", () => {
  it("changes the total by exactly the removed guest's booked price", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");

    await removeBookingGuestInTransaction({
      today: CLUB_TODAY_DATE_ONLY,
      tx: tx as any,
      bookingId: "bk1",
      guestId: "g1",
      actorMemberId: "m1",
      actorRole: "ADMIN",
      settlementMethod: "CREDIT" as any,
    });

    // Remaining gap-stay guest keeps exactly her two booked nights at their
    // locked 5000 (pre-fix she was repriced over the full range: 22000).
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(10000);

    const modification = tx.bookingModification.create.mock.calls[0][0].data;
    expect(modification.priceDiffCents).toBe(-20000);
  });
});

describe("date change resets guests to the full new range (#1093 policy)", () => {
  it("re-syncs night rows to the new range with locked prices preserved", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { PUT } = await import("@/app/api/bookings/[id]/modify-dates/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      // Extend by one night: Aug 1-5 stays, checkout Aug 6.
      body: JSON.stringify({ checkIn: "2026-08-01", checkOut: "2026-08-06" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // Both guests reset to the full new range. Locked nights keep 5000; new
    // nights (g1: Aug 5; g2: Aug 2, 4, 5) price at the current 6000.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(26000 + 28000);

    // Night rows are re-synced per guest: stale pre-change rows deleted, one
    // row per priced night of the new range written back.
    expect(tx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({ where: { bookingGuestId: "g1" } });
    expect(tx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({ where: { bookingGuestId: "g2" } });
    const createManyByGuest = new Map(
      tx.bookingGuestNight.createMany.mock.calls.map(([args]: any[]) => [
        args.data[0]?.bookingGuestId,
        args.data,
      ]),
    );
    expect(createManyByGuest.get("g1")).toHaveLength(5);
    expect(createManyByGuest.get("g1").map((row: any) => row.priceCents)).toEqual([
      5000, 5000, 5000, 5000, 6000,
    ]);
    expect(createManyByGuest.get("g2")).toHaveLength(5);
    expect(createManyByGuest.get("g2").map((row: any) => row.priceCents)).toEqual([
      5000, 6000, 5000, 6000, 6000,
    ]);
  });
});

describe("group discount on edit-path repricing (#1095)", () => {
  const QUALIFYING = { enabled: true, minGroupSize: 3, summerOnly: false };

  it("prices a guest added to a qualifying party at the discounted member rate", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking, { groupDiscountSetting: QUALIFYING });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // The discount is per night and per party size: on Aug 1 and 3 the full
    // party of 3 (g1, gap-stay g2, new guest) meets minGroupSize 3 and the
    // (unlinked, hence non-member-rate) new guest prices at the member 6000;
    // on Aug 2 and 4 the gap-stay guest is absent, the party of 2 does not
    // qualify, and the new guest pays the non-member 8000. Locked guests
    // unchanged.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(30000 + 28000);

    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.priceCents).toBe(28000);
    expect(createArgs.nights.create.map((n: any) => n.priceCents)).toEqual([
      6000, 8000, 6000, 8000,
    ]);
  });

  it("does not discount the added guest when the club has switched the discount off for later edits (#2770)", async () => {
    // Same club, same qualifying party, same edit as the case above — the only
    // difference is `applyToEdits: false`. Every night the addition buys is then
    // charged at the ordinary non-member rate, and the total is the one a club
    // with no group discount at all would charge (INV-MOD-026).
    const booking = makeBooking();
    const tx = makeTx(booking, {
      groupDiscountSetting: { ...QUALIFYING, applyToEdits: false },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    // 4 nights at the undiscounted 8000, where the ON case above paid
    // 6000/8000/6000/8000 = 28000. Strictly dearer, which is what proves the
    // switch reached this route rather than the plumbing being inert.
    expect(createArgs.priceCents).toBe(32000);
    expect(createArgs.nights.create.map((n: any) => n.priceCents)).toEqual([
      8000, 8000, 8000, 8000,
    ]);
  });

  it("does not discount an addition that leaves the party below the minimum", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking, {
      groupDiscountSetting: { enabled: true, minGroupSize: 5, summerOnly: false },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.priceCents).toBe(32000);
  });

  it("applies the discount to the nights a date extension adds for a qualifying party", async () => {
    const booking = makeBooking();
    // Make the gap-stay guest a non-member so the discount is visible on her
    // newly priced nights; her locked 5000s (bought under the discount) stay.
    booking.guests[1].isMember = false;
    const tx = makeTx(booking, {
      groupDiscountSetting: { enabled: true, minGroupSize: 2, summerOnly: false },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { PUT } = await import("@/app/api/bookings/[id]/modify-dates/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-01", checkOut: "2026-08-06" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // g1 (member): 4 locked + Aug 5 at 6000 = 26000. g2 (non-member): locked
    // Aug 1/3 at 5000, new Aug 2/4/5 at the discounted member 6000 = 28000
    // (34000 undiscounted). The party of 2 qualifies every night.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(26000 + 28000);
  });

  it("does not discount a date extension's new nights when the club has switched the discount off for later edits (#2770)", async () => {
    // The other edit path, the same switch, and the same shape of proof: identical
    // to the case above except `applyToEdits: false`. The nights the extension
    // buys go back to the ordinary non-member rate, while the nights g2 already
    // BOUGHT under the discount keep their locked 5000s in both states
    // (INV-MOD-005) — turning the switch off never re-rates what was paid.
    const booking = makeBooking();
    booking.guests[1].isMember = false;
    const tx = makeTx(booking, {
      groupDiscountSetting: {
        enabled: true,
        minGroupSize: 2,
        summerOnly: false,
        applyToEdits: false,
      },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { PUT } = await import("@/app/api/bookings/[id]/modify-dates/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-01", checkOut: "2026-08-06" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // g1 (member) is untouched at 26000. g2 keeps her locked Aug 1/3 at 5000 and
    // pays the undiscounted 8000 for each of Aug 2/4/5 = 34000, where the ON case
    // paid 28000. The 6000 difference is exactly three discounted nights.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(26000 + 34000);
    expect(bookingUpdate.totalPriceCents).toBeGreaterThan(26000 + 28000);
  });
});
