import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

/**
 * #4933 (`INV-LOCK-006`): both booking-create transactions wait for
 * `pg_advisory_xact_lock(1)`, and Prisma counts that wait against the
 * transaction's budget. On the 2 s / 5 s defaults any long holder of the key
 * (bed-range assignment, group settlement) aborted the create, so each one it
 * opens must run on the shared lock(1) budget - and a caller-supplied
 * transaction keeps its opener's. The mock world is
 * `issue-2265-draft-save-persists-election.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  bookingCreate: vi.fn(),
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: vi.fn().mockResolvedValue(50_000),
  memberCreditCreate: vi.fn(),
}));

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(1),
  // #2364: the create transaction reconciles the hosting review from the rows it
  // just wrote. `findUnique` answering undefined is the "booking not found"
  // branch, which writes nothing — right for a double that models one create.
  booking: { create: mocks.bookingCreate, findUnique: vi.fn() },
  // #3276: the night adjustment build-up writer reads and rewrites these.
  bookingGuestNightAdjustment: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  bookingGuestNight: {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  promoRedemption: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  season: { findMany: vi.fn().mockResolvedValue([]) },
  memberCredit: { create: mocks.memberCreditCreate, aggregate: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    member: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-1"),
  lodgeNullTolerantScope: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/lodge-access", () => ({
  assertMemberMayBookLodge: vi.fn().mockResolvedValue(undefined),
  LodgeBookingEligibilityError: class extends Error {},
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn().mockResolvedValue({
    available: true,
    nightDetails: [],
  }),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  BookingMemberNightConflictError: class extends Error {},
  DUPLICATE_STAY_BOOKING_STATUSES: [],
}));
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: vi.fn().mockResolvedValue({
    totalPriceCents: 10_000,
    guests: [
      {
        priceCents: 10_000,
        perNightCents: [5_000, 5_000],
        nightDates: [new Date("2026-08-14"), new Date("2026-08-15")],
      },
    ],
  }),
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  MembershipTypeBookingPolicyError: class extends Error {},
}));
vi.mock("@/lib/booking-create-promo", () => ({
  // #3827: the plural resolution; no codes, so no promotion.
  promoCodeRequestsOf: vi.fn().mockReturnValue([]),
  resolveEffectivePromoSources: vi.fn().mockResolvedValue([]),
  resolvePromotionsInTransaction: vi.fn().mockResolvedValue({
    discountCents: 0,
    promoAdjustmentCents: 0,
    promoAdjustmentTargets: [],
    redemptions: [],
  }),
  getPromoTargetBookingGuestIds: vi.fn().mockReturnValue([]),
  remapPromoIndexesToSubset: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  applyCreditToBooking: mocks.applyCreditToBooking,
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createConfirmedBooking, createDraftBooking } from "@/lib/booking-create";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const GUESTS = [
  {
    firstName: "Aroha",
    lastName: "Ngata",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "member-1",
  },
];

function draftInput(overrides: Record<string, unknown> = {}) {
  return {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    guests: GUESTS,
    lodgeId: "lodge-1",
    guestDietarySeeding: bookingGuestDietarySeeding(false),
    format: CLUB_FORMAT_TEST,
    ...overrides,
  };
}

function confirmedInput(overrides: Record<string, unknown> = {}) {
  return {
    ...draftInput(),
    status: "PAYMENT_PENDING" as const,
    shouldBePending: false,
    holdDays: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.bookingCreate.mockResolvedValue({
    id: "booking-1",
    status: "PAYMENT_PENDING",
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    finalPriceCents: 10_000,
    guests: [],
  });
});

describe("#4933 the booking-create transactions run on the shared lock(1) budget", () => {
  it("is wider than Prisma's 2 s / 5 s defaults that lock(1) waits used to exhaust", () => {
    expect(LOCK1_HOLDER_TRANSACTION_BUDGET.maxWait).toBeGreaterThan(2_000);
    expect(LOCK1_HOLDER_TRANSACTION_BUDGET.timeout).toBeGreaterThan(5_000);
  });

  it("createDraftBooking opens its transaction with the shared budget", async () => {
    await createDraftBooking(draftInput());

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1]).toBe(LOCK1_HOLDER_TRANSACTION_BUDGET);
  });

  it("createConfirmedBooking opens its own transaction with the shared budget", async () => {
    await createConfirmedBooking(confirmedInput() as never);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1]).toBe(LOCK1_HOLDER_TRANSACTION_BUDGET);
  });

  it("createConfirmedBooking in a caller's transaction opens none and takes no lock(1)", async () => {
    await createConfirmedBooking(confirmedInput({ tx }) as never);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.bookingCreate).toHaveBeenCalledTimes(1);
    // The caller already holds lock(1); only the per-lodge key is (re-)taken.
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it.each(["P2028", "P2034"])(
    "a %s from the draft transaction propagates for the route to answer 503",
    async (code) => {
      const contention = Object.assign(new Error("Transaction API error"), { code });
      mocks.transaction.mockRejectedValue(contention);

      await expect(createDraftBooking(draftInput())).rejects.toBe(contention);
      expect(mocks.bookingCreate).not.toHaveBeenCalled();
    },
  );

  it.each(["P2028", "P2034"])(
    "a %s from the confirmed transaction propagates for the route to answer 503",
    async (code) => {
      const contention = Object.assign(new Error("Transaction API error"), { code });
      mocks.transaction.mockRejectedValue(contention);

      await expect(createConfirmedBooking(confirmedInput() as never)).rejects.toBe(contention);
      expect(mocks.bookingCreate).not.toHaveBeenCalled();
    },
  );
});
