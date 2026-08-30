/**
 * Tests for Issue 2 fix: modification payment collection for price increases.
 *
 * Covers:
 * - modify-dates: price increase creates additional PaymentIntent, returns clientSecret
 * - modify-dates: price decrease still processes refund (no regression)
 * - add-guests: price increase creates additional PaymentIntent, returns clientSecret
 * - stripe webhook: payment_intent.succeeded for additional PI updates payment record
 * - confirm-modification-payment endpoint: verifies PI and updates DB
 * - additional-payment-secret endpoint: returns clientSecret for pending additional PI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockTransaction = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingGuestCreate = vi.fn();
const mockBookingGuestUpdate = vi.fn();
const mockBookingModCreate = vi.fn();
const mockSeasonFindMany = vi.fn();
const mockChoreAssignFindMany = vi.fn();
const mockChoreAssignDeleteMany = vi.fn();
const mockProcessedWebhookCreate = vi.fn();
const mockProcessedWebhookDeleteMany = vi.fn();
const mockProcessedWebhookFindUnique = vi.fn();
const mockProcessedWebhookFindFirst = vi.fn();
const mockProcessedWebhookUpdateMany = vi.fn();
const mockMemberCount = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockAuditCreate = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockRefundPaymentTransactions = vi.fn();
const mockFindPaymentTransactionByIntentId = vi.fn();
const mockMarkPaymentIntentTransactionSucceeded = vi.fn();
const mockMarkPaymentIntentTransactionFailed = vi.fn();
const mockCompleteCanceledSupersededPaymentIntentRecovery = vi.fn();
const mockQueueSupersededPaymentIntentRefundRecovery = vi.fn();
const mockQueueSupersededAdditionalIntentCancellations = vi.fn();
const mockQueueSupersededPrimaryIntentCancellations = vi.fn();
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking", message: "queued" });
const mockEnqueueXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking_update", message: "queued" });
const mockEnqueueXeroRefundCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_refund", message: "queued" });
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);
const mockRecordSkippedXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_skip", message: "skipped" });
const mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent = vi.fn().mockResolvedValue({ released: 1, queueOperationIds: ["op_supplementary"] });

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as any)(fn);
      return Promise.resolve();
    },
    payment: {
      findUnique: mockPaymentFindUnique,
      update: mockPaymentUpdate,
    },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      findUnique: mockBookingFindUnique,
      update: mockBookingUpdate,
    },
    // #1982: default lodge capacity is a self-healed DB override (the guest-add
    // route's early getDefaultLodgeCapacity guard reads it off the singleton).
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    bookingGuest: { create: mockBookingGuestCreate, update: mockBookingGuestUpdate },
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
    bookingModification: { create: mockBookingModCreate },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    season: { findMany: mockSeasonFindMany },
    choreAssignment: { findMany: mockChoreAssignFindMany, deleteMany: mockChoreAssignDeleteMany },
    processedWebhookEvent: {
      findUnique: mockProcessedWebhookFindUnique,
      findFirst: mockProcessedWebhookFindFirst,
      create: mockProcessedWebhookCreate,
      deleteMany: mockProcessedWebhookDeleteMany,
      updateMany: mockProcessedWebhookUpdateMany,
    },
    member: { count: mockMemberCount, findUnique: mockMemberFindUnique },
    auditLog: { create: mockAuditCreate },
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
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
  // Date reductions settle through the shared policy machinery (#1024);
  // default to a 100% tier so existing full-refund expectations hold.
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
  processRefund: vi.fn(),
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
}));
// DB-only (#2082): the webhook route resolves its signing secret via
// stripe-config and records a test-mode verified marker.
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeWebhookSecret: vi.fn().mockResolvedValue("whsec_test"),
  recordStripeWebhookVerified: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
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
  enqueueXeroBookingInvoiceOperation: mockEnqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation: mockEnqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroRefundCreditNoteOperation: mockEnqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation: mockRecordSkippedXeroBookingInvoiceUpdateOperation,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
}));
vi.mock("@/lib/webhook-log", () => ({ recordWebhookLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mockFindPaymentTransactionByIntentId(...args),
  markPaymentIntentTransactionSucceeded: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionSucceeded(...args),
  markPaymentIntentTransactionFailed: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionFailed(...args),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  completeCanceledSupersededPaymentIntentRecovery: (...args: unknown[]) =>
    mockCompleteCanceledSupersededPaymentIntentRecovery(...args),
  queueSupersededPaymentIntentRefundRecovery: (...args: unknown[]) =>
    mockQueueSupersededPaymentIntentRefundRecovery(...args),
  getStripePaymentMethodId: (paymentIntent: {
    payment_method?: string | { id?: string | null } | null;
  }) =>
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null,
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: (...args: unknown[]) =>
    mockQueueSupersededAdditionalIntentCancellations(...args),
  queueSupersededPrimaryIntentCancellations: (...args: unknown[]) =>
    mockQueueSupersededPrimaryIntentCancellations(...args),
}));

// Chore cleanup mock
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({ choreWarnings: [] }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({ choreWarnings: [] }),
}));

import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import { calculateBookingPrice } from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import { processRefund, createPaymentIntent, findOrCreateCustomer, getPaymentIntent, constructWebhookEvent } from "@/lib/stripe";
import { calculateDualRefundAmounts } from "@/lib/cancellation";
import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const mockedAuth = vi.mocked(auth);
const mockedCalcDualRefund = vi.mocked(calculateDualRefundAmounts);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedCalcChangeFee = vi.mocked(calculateChangeFee);
const mockedProcessRefund = vi.mocked(processRefund);
const mockedCreatePaymentIntent = vi.mocked(createPaymentIntent);
const mockedFindOrCreateCustomer = vi.mocked(findOrCreateCustomer);
const mockedGetPaymentIntent = vi.mocked(getPaymentIntent);
const mockedConstructWebhookEvent = vi.mocked(constructWebhookEvent);

function makeSession() {
  return { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@test.com" } };
}

/**
 * The bookings below run 2026-08-01 onward and every scenario edits a stay that
 * has NOT started — the "future" edit mode these routes serve. Left on the real
 * clock the suite quietly changed meaning once the NZ calendar date reached the
 * fixture check-in: getBookingEditPolicy then classifies the same booking as
 * "in-progress" and the routes correctly answer 400 ("Use the full booking edit
 * flow ..."), so the payment/refund assertions never ran. Pin the clock so the
 * scenario under test stays the intended one; the in-progress edit path has its
 * own deliberate coverage in batch-modify-payment.test.ts.
 *
 * Only `Date` is faked — real timers still run, so awaited promises resolve
 * normally. Booking dates are untouched, so every money assertion is unchanged.
 */
const FIXED_NOW = new Date("2026-07-15T00:00:00.000Z"); // NZ 2026-07-15 12:00

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
    // one. Omitting it here let the hosting participant fence compare
    // "bk1:m1:undefined" on both sides and pass vacuously (#2619).
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    status: "CONFIRMED",
    totalPriceCents: 10000,
    discountCents: 0,
    finalPriceCents: 10000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        priceCents: 5000,
        /*
          #2675: with an ACTIVE hosting mode on the tx double below, the
          reconciler's EVALUATOR now runs against this row rather than bailing
          out at the mode gate, and `BOOKING_HOSTING_SELECT` /
          `toHostingParticipants` are the authority on the shape it reads. Every
          field below is one of theirs.

          `nights` must be an ARRAY — `toHostingParticipants` reads
          `guest.nights.length`, so an absent one is a TypeError, not a graceful
          "no nights". Empty is the honest value for this fixture: it persists no
          `BookingGuestNight` rows, so the evaluator falls back to the guest's own
          stayStart..stayEnd envelope. It is also inert for the date path, whose
          `lockedNightPricesForGuest` reads the same field and already treated the
          absent one as "this guest locked no prices".
        */
        stayStart: new Date("2026-08-01"),
        stayEnd: new Date("2026-08-03"),
        nights: [],
        // No consent was ever needed for an ordinary guest, and `null` is one of
        // the two values `isOperationallyPresentConsent` treats as present (D-12).
        consentStatus: null,
        /*
          The LIVE Member relation, never the `isMember` snapshot beside it. A
          guest row claiming membership without one is a shape production cannot
          emit — the review's select always hydrates `member` — and it does not
          degrade gracefully: `undefined !== null` is TRUE, so
          `memberIsInGoodStanding` goes on to read `undefined.active` and the
          seam throws the moment an active mode lets the evaluator run.
        */
        member: hostingMemberRow("m1"),
      },
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 10000,
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

function makeTx(booking: ReturnType<typeof makeBooking>) {
  /*
    #2619: the hosting participant fence runs inside this very transaction. It
    locks the source booking's owner/actor Member rows FOR KEY SHARE NOWAIT and
    then, UNDER that lock, re-reads (1) those Member rows and (2) each source
    booking's owner and lodge, refusing unless the second read still fingerprints
    identically to what the caller planned.

    This tx had no `booking.findMany` at all, so the re-read could not even be
    attempted. The recorder replays exactly what this tx's own `findUnique`
    served the planner — including an ABSENT lodgeId left absent, since the
    fingerprint interpolates it and a re-read normalised to null would read as
    drift against a plan that printed "undefined". So the no-drift case matches
    by construction, and real drift is still refused.
  */
  const fenceBooking = recordingBookingDouble(async () => booking);
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    // F1 (#1887): the date path now reads the applied-credit ledger for every
    // pre-payment modification (gated on status, not the payment mirror) so the
    // clamp also fires for a card booking with no payment row. These fixtures
    // carry no applied credit, so the aggregate nets to 0 and the clamp is a
    // no-op (never taking the ledger lock or writing a row).
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
    memberCredit: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
      create: vi.fn().mockResolvedValue({}),
    },
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode, so the gate that now stands in front of
    // the participant fence lets these seams reach it. `[]` here resolved to
    // DISABLED and took the gate's early return, which switched the #2619 fence
    // off in all eleven modify-dates/guest-add cases below while the fence
    // doubles beside it still looked like coverage.
    //
    // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: under
    // ENFORCED a hosting violation REFUSES the booking write outright, which
    // would change what these money assertions mean; under review-only a
    // violation would merely queue a review. Neither happens on these fixtures
    // (their only guest is an adult member in good standing, so nobody needs
    // hosting), but the weaker consequence is the one that cannot rewrite the
    // scenario if a fixture ever gains a non-member guest.
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      update: vi.fn().mockImplementation(({ data }) => {
        return Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment });
      }),
    },
    bookingGuest: {
      // Person-night guard (#1157) queries member-linked guests on the new
      // range; no other live booking exists in these fixtures, so no conflict.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
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
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: {
      findMany: vi.fn().mockResolvedValue([{
        id: "s1",
        startDate: new Date("2026-04-01"),
        endDate: new Date("2026-10-31"),
        // Membership-type-keyed rates (#1930, E4): FULL members 5000, NON_MEMBER
        // 7000. The pricing engine (calculateBookingPrice) is mocked in this
        // suite, so these values only need the re-keyed shape, not the amounts.
        membershipTypeRates: [
          { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 5000 },
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 },
        ],
      }]),
    },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    // Rate-membership-type snapshot resolution (#1930, E4): the modify/guest-add
    // paths now resolve every guest's rate type before pricing. Provide the
    // policy-db delegates so the resolver sees the built-in types (member guests
    // -> FULL/member rate, true non-members -> NON_MEMBER) instead of throwing.
    member: {
      // #2619: the fence's own id-only re-read is answered by the shared helper
      // — every locked id back, in sorted order. Every OTHER member.findMany
      // (the rate resolver's, below) still gets exactly the rows it always did.
      findMany: fenceMemberFindMany([], async (args) =>
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
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  mockQueueSupersededAdditionalIntentCancellations.mockResolvedValue([]);
  mockQueueSupersededPrimaryIntentCancellations.mockResolvedValue([]);
  mockUpsertPaymentIntentTransaction.mockResolvedValue({});
  mockRefundPaymentTransactions.mockResolvedValue({
    refunds: [{ refundId: "re_test_1", paymentIntentId: "pi_original", amountCents: 1000 }],
  });
  mockFindPaymentTransactionByIntentId.mockResolvedValue({
    id: "ptx_1",
    paymentId: "p1",
    kind: "ADDITIONAL",
    amountCents: 3000,
    status: "PENDING",
    createdAt: new Date(),
  });
  mockMarkPaymentIntentTransactionSucceeded.mockResolvedValue({});
  mockMarkPaymentIntentTransactionFailed.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// modify-dates: price increase creates additional PaymentIntent
// ============================================================================

describe("PUT /api/bookings/[id]/modify-dates — price increase", () => {
  let PUT: typeof import("@/app/api/bookings/[id]/modify-dates/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/modify-dates/route");
    PUT = mod.PUT;
  });

  it("creates additional PaymentIntent and returns clientSecret when price increases", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000, // price increased from 10000
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_additional",
      client_secret: "pi_additional_secret_xxx",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(5000);
    expect(data.additionalPaymentClientSecret).toBe("pi_additional_secret_xxx");

    // Verify PaymentIntent was created with correct amount
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 5000,
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        paymentIntentId: "pi_additional",
        amountCents: 5000,
        status: "PENDING",
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_additional",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("uses existing stripeCustomerId if present (no findOrCreateCustomer call)", async () => {
    const booking = makeBooking(); // has stripeCustomerId: "cus_123"
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 12000,
      guests: [{ priceCents: 12000, perNightCents: [6000, 6000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_add2",
      client_secret: "secret_2",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-05" }),
    });
    await PUT(req, { params: Promise.resolve({ id: "bk1" }) });

    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_123" })
    );
  });

  it("includes change fee in additionalAmountCents", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000, // same price, but change fee applies
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 2000, fromTierRefundPct: 50, toTierRefundPct: 100 }); // $20 change fee
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_fee",
      client_secret: "fee_secret",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    // Changing check-in from Aug 1 to Aug 2 (still before checkOut Aug 3) — triggers late-notice fee
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    // priceDiff = 0, changeFee = 2000, total additional = 2000
    expect(data.additionalAmountCents).toBe(2000);
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2000 })
    );
  });

  it("processes refund for price decrease (no additional PI created)", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000, // price decreased from 10000
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02", settlementMethod: "card" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.refundAmountCents).toBe(3000);
    expect(data.additionalAmountCents).toBe(0);
    expect(data.additionalPaymentClientSecret).toBeNull();

    // Refund was processed
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        amountCents: 3000,
      })
    );

    // No additional PI created
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("limits a captured-payment date reduction to the cancellation-policy tier (#1024)", async () => {
    // Regression guard: date reductions must settle through the shared policy
    // core, not refund the full price delta. Here the tier only returns 50%, so
    // a $30 delta must refund $15 — the pre-#1024 code refunded the full $30.
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000, // price decreased from 10000 → $30 delta
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockedCalcDualRefund.mockReturnValueOnce({
      cardRefundAmountCents: 1500,
      cardRefundPercentage: 50,
      creditRefundAmountCents: 1500,
      creditRefundPercentage: 50,
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02", settlementMethod: "card" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    // Policy-limited, NOT the full 3000 delta.
    expect(data.refundAmountCents).toBe(1500);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "p1", amountCents: 1500 }),
    );

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 1500,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      },
    );
  });

  it("does not send Internet Banking date reductions to Stripe refund recovery", async () => {
    const booking = makeBooking({
      payment: {
        ...makeBooking().payment,
        source: "INTERNET_BANKING",
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        xeroInvoiceId: "inv_ib_1",
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000,
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02", settlementMethod: "card" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.refundAmountCents).toBe(3000);
    expect(data.additionalPaymentClientSecret).toBeNull();
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("does not create PI for PENDING bookings (payment not yet taken)", async () => {
    // For PENDING bookings, no payment has been collected yet.
    // The booking price update is recorded, but additionalAmountCents stays 0
    // (the new price will be charged when the booking auto-confirms).
    const booking = makeBooking({
      status: "PENDING",
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 0,
        status: "PENDING",
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000,
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    // No additional payment for PENDING bookings - original payment not taken yet
    expect(data.additionalAmountCents).toBe(0);
    expect(data.additionalPaymentClientSecret).toBeNull();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("queues a supplementary Xero invoice for invoice-backed unpaid bookings without creating a new PI", async () => {
    const booking = makeBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_original",
        stripeCustomerId: "cus_123",
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_primary",
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000,
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(5000);
    expect(data.additionalPaymentClientSecret).toBeNull();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: null,
        waitForConfirmedAdditionalPayment: false,
        recordPayment: false,
      }
    );
  });

  it("queues a Xero credit note for invoice-backed unpaid decreases without refunding Stripe", async () => {
    const booking = makeBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_original",
        stripeCustomerId: "cus_123",
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_primary",
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000,
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.refundAmountCents).toBe(0);
    expect(mockedProcessRefund).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("queues a primary Xero invoice update for zero-net date changes", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-07" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(0);
    expect(data.refundAmountCents).toBe(0);

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
  });
});

// ============================================================================
// POST /api/bookings/[id]/guests — price increase creates additional PI
// ============================================================================

describe("POST /api/bookings/[id]/guests — price increase", () => {
  let POST: typeof import("@/app/api/bookings/[id]/guests/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/guests/route");
    POST = mod.POST;
  });

  it("creates additional PaymentIntent when adding guest to CONFIRMED booking", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 20, nightDetails: [] } as any);
    // New guest price: 5000 per guest for 2 nights = 10000 extra
    mockedCalcPrice.mockImplementation((_ci, _co, guests) => ({
      totalPriceCents: guests.length === 1 ? 10000 : 20000,
      guests: guests.map(() => ({ priceCents: 10000, perNightCents: [5000, 5000] })),
    } as any));
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_guest_extra",
      client_secret: "guest_extra_secret",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(10000);
    expect(data.additionalPaymentClientSecret).toBe("guest_extra_secret");

    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
          reason: "guest_add_price_increase",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        paymentIntentId: "pi_guest_extra",
        amountCents: 10000,
        status: "PENDING",
      })
    );
    expect(mockQueueSupersededAdditionalIntentCancellations).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "p1",
      newPaymentIntentId: "pi_guest_extra",
    });

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 10000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_guest_extra",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
  });
});

// ============================================================================
// Stripe webhook — additional PaymentIntent succeeded
// ============================================================================

describe("Stripe webhook — additional modification payment succeeded", () => {
  let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

  const makeWebhookRequest = () =>
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "test-sig" },
      body: JSON.stringify({}),
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(false);
    mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValue(false);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("updates additionalPaymentStatus and amountCents when additional PI succeeds", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookFindUnique.mockResolvedValue(null);
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });

    const req = makeWebhookRequest();
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.received).toBe(true);

    expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_additional",
        amountCents: 3000,
      })
    );
    expect(
      mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).toHaveBeenCalledWith("pi_additional");
  });

  it("is idempotent: skips already-SUCCEEDED additional payment", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_test2",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookFindUnique.mockResolvedValue(null);
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "SUCCEEDED",
      createdAt: new Date(),
    });

    const req = makeWebhookRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });

  it("does not update payment when additional PI amount mismatches", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_mismatch",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 2500,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 1 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "bk1",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { firstName: "Alice", lastName: "Smith" },
    });

    const req = makeWebhookRequest();
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    // F16 fence (#1887): the claim release keys on status + the lease token.
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "evt_mismatch",
        source: "stripe",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
    });
  });

  it("returns success for duplicate Stripe webhook deliveries", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_duplicate",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });
    // F16 (#1887): the existing claim is COMPLETED, so the redelivery ACKs 200.
    mockProcessedWebhookFindFirst.mockResolvedValue({
      status: "COMPLETED",
      processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const req = makeWebhookRequest();
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.received).toBe(true);
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
  });
});

// ============================================================================
// POST /api/bookings/[id]/confirm-modification-payment
// ============================================================================

describe("POST /api/bookings/[id]/confirm-modification-payment", () => {
  let POST: typeof import("@/app/api/bookings/[id]/confirm-modification-payment/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import(
      "@/app/api/bookings/[id]/confirm-modification-payment/route"
    );
    POST = mod.POST;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 if paymentIntentId does not match booking", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_different",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_wrong" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("verifies PI with Stripe and updates payment when succeeded", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_additional",
      status: "succeeded",
      amount: 3000,
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_additional",
        amountCents: 3000,
      })
    );
    expect(
      mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).toHaveBeenCalledWith("pi_additional");
  });

  it("returns 400 if Stripe PI has not succeeded yet", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({ status: "requires_action" } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if Stripe PI amount does not match the modification amount", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({ status: "succeeded", amount: 2500 } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });

  it("returns 403 for deactivated members", async () => {
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockedAuth.mockResolvedValue(makeSession() as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });

  it("is idempotent for already-SUCCEEDED payments", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "SUCCEEDED",
      additionalAmountCents: 3000,
      amountCents: 13000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "SUCCEEDED",
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // Should not call Stripe or update DB again
    expect(mockedGetPaymentIntent).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });
});

// ============================================================================
// GET /api/bookings/[id]/additional-payment-secret
// ============================================================================

describe("GET /api/bookings/[id]/additional-payment-secret", () => {
  let GET: typeof import("@/app/api/bookings/[id]/additional-payment-secret/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    const mod = await import(
      "@/app/api/bookings/[id]/additional-payment-secret/route"
    );
    GET = mod.GET;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  /** A live, payable booking unless a test says otherwise. */
  function additionalPaymentRow(overrides: Record<string, unknown> = {}) {
    const { booking, ...rest } = overrides as {
      booking?: Record<string, unknown>;
    } & Record<string, unknown>;
    return {
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      ...rest,
      booking: { memberId: "m1", status: "PAID", deletedAt: null, ...(booking ?? {}) },
    };
  }

  it("returns 404 if no pending additional payment", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue(
      additionalPaymentRow({
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
        additionalAmountCents: 0,
      })
    );

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 if additional payment already SUCCEEDED", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue(
      additionalPaymentRow({ additionalPaymentStatus: "SUCCEEDED" })
    );

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns clientSecret and amountCents for pending additional payment", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue(additionalPaymentRow());
    mockedGetPaymentIntent.mockResolvedValue({
      client_secret: "pi_additional_secret_xyz",
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("pi_additional_secret_xyz");
    expect(data.amountCents).toBe(3000);
  });

  /*
    #2350. Cancelling a booking marks the additional intent FAILED and leaves
    `additionalAmountCents` alone, and the cancel path only asks Stripe to cancel
    an intent that was still OUTSTANDING — an intent that had already failed (a
    declined card) is left confirmable. So an intent-id-and-status gate handed
    the owner of a cancelled booking a live client secret they could confirm with
    a different card, and the member was charged for a booking that no longer
    existed. Stripe is never even asked here now.
  */
  it("refuses the secret for a booking whose lifecycle cannot collect it", async () => {
    for (const status of ["CANCELLED", "BUMPED", "DRAFT", "WAITLISTED"]) {
      mockedGetPaymentIntent.mockClear();
      mockedAuth.mockResolvedValue(makeSession() as any);
      mockPaymentFindUnique.mockResolvedValue(
        additionalPaymentRow({
          additionalPaymentStatus: "FAILED",
          booking: { status },
        })
      );

      const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
      const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
      expect(res.status).toBe(404);
      expect(mockedGetPaymentIntent).not.toHaveBeenCalled();
    }
  });

  it("refuses the secret for a soft-deleted booking", async () => {
    mockedGetPaymentIntent.mockClear();
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue(
      additionalPaymentRow({ booking: { deletedAt: new Date() } })
    );

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
    expect(mockedGetPaymentIntent).not.toHaveBeenCalled();
  });

  /*
    PAYMENT_PENDING is deliberately IN the payable list even though the admin
    owed queues drop it: they drop it only so their counts can be summed with the
    unpaid-finished-stays queue without double-counting, and a PAYMENT_PENDING
    booking can genuinely carry a delta (adding a guest to a booking with an
    issued Xero invoice raises one). Hiding the member's own pay button for a
    counting reason would strand real money.
  */
  it("still serves a PAYMENT_PENDING booking, which the admin queues exclude", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue(
      additionalPaymentRow({ booking: { status: "PAYMENT_PENDING" } })
    );
    mockedGetPaymentIntent.mockResolvedValue({
      client_secret: "pi_additional_secret_xyz",
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
  });

  it("returns 403 for a different member trying to access", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other-member", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockPaymentFindUnique.mockResolvedValue(additionalPaymentRow());

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });
});
