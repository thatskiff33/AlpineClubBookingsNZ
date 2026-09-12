import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2265 (epic #2245, E1) — saving as a draft must REMEMBER the member's credit
 * election.
 *
 * The bug: the wizard sent `applyCreditCents` on Save as draft, the create
 * route's draft branch never named the field, and the election vanished with no
 * message to the member. These tests pin the persistence half of the fix at the
 * service boundary — the row `createDraftBooking` writes — and pin the other
 * half of the promise just as hard: a draft consumes NO credit.
 */

const mocks = vi.hoisted(() => ({
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
  promoRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  season: { findMany: vi.fn().mockResolvedValue([]) },
  memberCredit: { create: mocks.memberCreditCreate, aggregate: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(
      async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    ),
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
  resolveEffectivePromoSource: vi.fn().mockResolvedValue(null),
  resolvePromoInTransaction: vi.fn(),
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
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createConfirmedBooking, createDraftBooking } from "@/lib/booking-create";

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
    ...overrides,
  };
}

function createdRow() {
  return mocks.bookingCreate.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingCreate.mockResolvedValue({
    id: "draft-1",
    status: "DRAFT",
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    finalPriceCents: 10_000,
    guests: [],
  });
  mocks.getMemberCreditBalance.mockResolvedValue(50_000);
});

describe("#2265 createDraftBooking remembers the credit election", () => {
  it("stores the elected amount on the draft, in integer cents", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 8_650 }));

    expect(createdRow().creditElectionCents).toBe(8_650);
  });

  it("consumes no credit at all while the booking is only a draft", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 8_650 }));

    // No ledger row, no balance movement: an abandoned or expired draft leaves
    // the member's balance exactly where it was. This is the reason the
    // election is stored rather than applied.
    expect(mocks.applyCreditToBooking).not.toHaveBeenCalled();
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(createdRow().status).toBe("DRAFT");
  });

  it("records an explicit election of zero as zero, not as 'never asked'", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 0 }));

    expect(createdRow().creditElectionCents).toBe(0);
  });

  it("omits the column entirely when the member made no election", async () => {
    await createDraftBooking(draftInput());

    // The create payload stays byte-identical to the pre-#2265 shape for a
    // member who never touched the credit control.
    expect(createdRow()).not.toHaveProperty("creditElectionCents");
  });
});

/**
 * The review rail is the other way a booking can be held before it is real: a
 * party with no adult supervision is created in AWAITING_REVIEW and waits for
 * an admin. It correctly consumes no credit while the admin is deciding — but
 * it used to DISCARD what the member asked for too, so an approved booking
 * arrived at the pay step with no election at all.
 */
describe("#2265 a booking held for admin review keeps the election", () => {
  const CHILD_ONLY_GUESTS = [
    {
      firstName: "Tama",
      lastName: "Ngata",
      ageTier: "CHILD" as const,
      isMember: true,
      memberId: "child-1",
    },
  ];

  function reviewInput(overrides: Record<string, unknown> = {}) {
    return {
      effectiveMemberId: "member-1",
      isOnBehalf: false,
      sessionUserId: "member-1",
      checkIn: new Date("2026-08-14"),
      checkOut: new Date("2026-08-16"),
      guests: CHILD_ONLY_GUESTS,
      memberReviewJustification: "Their grandmother is staying next door.",
      status: "PAYMENT_PENDING" as const,
      shouldBePending: false,
      holdDays: 0,
      lodgeId: "lodge-1",
      ...overrides,
    };
  }

  it("stores the election it is not allowed to spend yet", async () => {
    await createConfirmedBooking(
      reviewInput({ applyCreditCents: 8_650 }) as never,
    );

    const row = createdRow();
    expect(row.status).toBe("AWAITING_REVIEW");
    // Remembered, not spent: no ledger row moves while the admin decides.
    expect(row.creditElectionCents).toBe(8_650);
    expect(mocks.applyCreditToBooking).not.toHaveBeenCalled();
  });

  it("omits the column when a review-held booking made no election", async () => {
    await createConfirmedBooking(reviewInput() as never);

    expect(createdRow()).not.toHaveProperty("creditElectionCents");
  });

  it("still applies credit immediately when the booking is not held", async () => {
    // The guard is scoped to the review rail; an ordinary confirmed booking
    // consumes its credit at create time exactly as before.
    await createConfirmedBooking(
      {
        ...reviewInput({ applyCreditCents: 4_000 }),
        guests: GUESTS,
        memberReviewJustification: undefined,
      } as never,
    );

    const row = createdRow();
    expect(row.status).toBe("PAYMENT_PENDING");
    expect(row).not.toHaveProperty("creditElectionCents");
    expect(mocks.applyCreditToBooking).toHaveBeenCalledWith(
      "member-1",
      4_000,
      expect.any(String),
      expect.anything(),
    );
  });
});
