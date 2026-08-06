import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

// Cross-lodge waitlist confirm (ADR-004): Phase-1 duplicate-stay guard (M3).
// If an earlier confirm's Phase 3 (cancel the entry) failed, the entry is
// stranded in WAITLIST_OFFERED with a booking already created at the offered
// lodge; a re-confirm must not create a SECOND booking for the same stay.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  bookingFindUnique: vi.fn(),
  // #2363 Phase 0 reads the entry on the MODULE client, outside any
  // transaction, before the offered lodge's lock is taken.
  prismaBookingFindUnique: vi.fn(),
  validateMinimumStay: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  lodgeFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  priceBooking: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  createConfirmedBooking: vi.fn(),
  getNonMemberHoldDays: vi.fn(),
  recordBookingEvent: vi.fn(),
  logAudit: vi.fn(),
  // #2543 Phase 0b reads the promoted party on the MODULE client, outside any
  // transaction, before the offered lodge's lock is taken — exactly as Phase 0's
  // minimum-stay check does.
  prismaBookingGuestFindMany: vi.fn(),
  resolveSubscriptionLockoutMode: vi.fn(),
  evaluateNonMemberPricing: vi.fn(),
}));

const txClient = {
  $executeRaw: vi.fn(),
  booking: {
    findUnique: mocks.bookingFindUnique,
    findFirst: mocks.bookingFindFirst,
    update: mocks.bookingUpdate,
    updateMany: mocks.bookingUpdateMany,
  },
  lodge: { findUnique: mocks.lodgeFindUnique },
  season: { findMany: mocks.seasonFindMany },
  groupDiscountSetting: { findUnique: mocks.groupDiscountFindUnique },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    booking: { findUnique: mocks.prismaBookingFindUnique },
    // #2543: the promoted party, read outside the transaction.
    bookingGuest: { findMany: mocks.prismaBookingGuestFindMany },
  },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutMode: mocks.resolveSubscriptionLockoutMode,
  // The enforcement module's own fallback reader. Never reached here: this suite
  // always supplies a resolved mode, which is the property that keeps a policy
  // read out from under the offered lodge's capacity lock.
  peekSubscriptionLockoutMode: vi.fn(async () => "HARD_BLOCK"),
}));
/**
 * #2543 — only the EVALUATOR is doubled. `toSubscriptionLockoutParticipants` and
 * `buildPaidUpAdultRefusalBody` stay real, so the refusal body this path returns is
 * the genuine shared one rather than a fixture that could drift from it.
 *
 * The evaluator's own semantics — who is repriced, who counts as a paid-up adult,
 * and the two triggers — are pinned exhaustively against real facts in
 * `subscription-lockout-enforcement.test.ts`. What this suite owns is the WIRING
 * that decides whether those answers ever reach a cross-lodge promotion: the
 * arguments passed, and what happens to the offer on a refusal. So the cells below
 * are driven by the four result shapes the real evaluator produces for them.
 */
vi.mock("@/lib/subscription-lockout-enforcement", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/subscription-lockout-enforcement")
    >();
  return { ...actual, evaluateNonMemberPricingRequirements: mocks.evaluateNonMemberPricing };
});
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mocks.validateMinimumStay,
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: mocks.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: mocks.createConfirmedBooking,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: mocks.priceBooking,
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: mocks.getNonMemberHoldDays,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { confirmCrossLodgeWaitlistOffer } from "@/lib/waitlist-cross-lodge";
// The real formatter (this module is NOT mocked), so the two waitlist paths are
// checked against one shared string rather than against a copy of it.
import { formatMissingPaidUpAdultWaitlistRefusal } from "@/lib/policies/subscription-lockout-pricing";
// Real class (this module is NOT mocked here), so both the production code and
// the test share its identity and `instanceof` works.
import { DuplicateStayConflictError } from "@/lib/booking-create-types";

const CHECK_IN = new Date("2026-08-10");
const CHECK_OUT = new Date("2026-08-12");

function offeredEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    memberId: "member-1",
    status: BookingStatus.WAITLIST_OFFERED,
    lodgeId: "lodge-a",
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    waitlistOfferedAt: new Date("2026-08-06T00:00:00.000Z"),
    waitlistOfferExpiresAt: new Date(Date.now() + 86_400_000),
    waitlistOfferedLodgeId: "lodge-b",
    waitlistOfferedPriceCents: 34_000,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [],
    promoRedemption: null,
    notes: null,
    ...overrides,
  };
}

function expectOfferEpochFence(where: unknown): void {
  expect(where).toEqual(
    expect.objectContaining({
      id: "entry-1",
      status: BookingStatus.WAITLIST_OFFERED,
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
      waitlistOfferedAt: new Date("2026-08-06T00:00:00.000Z"),
      waitlistOfferExpiresAt: expect.any(Date),
      waitlistOfferedLodgeId: "lodge-b",
      waitlistOfferedPriceCents: 34_000,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (cb: (tx: typeof txClient) => unknown) => cb(txClient),
  );
  mocks.bookingFindUnique.mockResolvedValue(offeredEntry());
  mocks.prismaBookingFindUnique.mockResolvedValue(offeredEntry());
  mocks.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  mocks.lodgeFindUnique.mockResolvedValue({ active: true });
  mocks.isMemberEligibleToBookLodge.mockResolvedValue(true);
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  // Default: no duplicate stay.
  mocks.bookingFindFirst.mockResolvedValue(null);
  // #2543 defaults: a club in the relaxed mode, an empty promoted party, and
  // nothing for the requirement to bite on. Every pre-#2543 expectation in this
  // file is therefore judged exactly as it was before the gate existed.
  mocks.resolveSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
  mocks.prismaBookingGuestFindMany.mockResolvedValue([]);
  mocks.evaluateNonMemberPricing.mockResolvedValue(null);
});

describe("confirmCrossLodgeWaitlistOffer duplicate-stay guard (M3)", () => {
  it("rejects with DUPLICATE_STAY and creates no booking when the member already holds an overlapping active stay at the offered lodge", async () => {
    // The member already has a real (PAYMENT_PENDING) booking overlapping the
    // offer's dates at the offered lodge — the residue of a stranded confirm.
    mocks.bookingFindFirst.mockResolvedValue({ id: "existing-booking" });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("DUPLICATE_STAY");
    // The whole point of the guard: no second booking is created.
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
    // The offer is left intact (not reverted) — the member cancels the
    // duplicate and re-confirms.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();

    // The guard is scoped to the member, the offered lodge, active statuses
    // (PAYMENT_PENDING counts), an overlapping range, and excludes the entry.
    const where = mocks.bookingFindFirst.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        memberId: "member-1",
        lodgeId: "lodge-b",
        id: { not: "entry-1" },
        deletedAt: null,
        checkIn: { lt: CHECK_OUT },
        checkOut: { gt: CHECK_IN },
      }),
    );
    expect(where.status.in).toEqual(
      expect.arrayContaining([
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.PAID,
      ]),
    );
    // Waitlist placeholders must NOT count as duplicate stays.
    expect(where.status.in).not.toContain(BookingStatus.WAITLISTED);
    expect(where.status.in).not.toContain(BookingStatus.WAITLIST_OFFERED);
    expect(where.status.in).not.toContain(BookingStatus.CANCELLED);
  });

  it("does not trip on the entry's own booking: the guard excludes it by id and the confirm proceeds past the guard", async () => {
    // No duplicate found (the entry itself is excluded by `id: { not }`), so
    // the confirm advances to the capacity re-check. Fail capacity there to
    // stop before the create path — the rejection is NOT the duplicate one.
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    // Not rejected as a duplicate — it got past the guard.
    expect(result.code).toBeUndefined();
    expect(result.error).toContain("Capacity is no longer available");
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
    // The guard query excluded the entry's own id.
    expect(mocks.bookingFindFirst.mock.calls[0][0].where.id).toEqual({
      not: "entry-1",
    });
  });
});

describe("confirmCrossLodgeWaitlistOffer in-transaction duplicate-stay guard (M2)", () => {
  // These cases drive Phase 1 to completion (no duplicate visible to the
  // pre-flight guard, capacity available, quote unchanged) so Phase 2 —
  // createConfirmedBooking — actually runs; the concurrent-confirm window is
  // closed by the guard re-running INSIDE that transaction, surfaced here as a
  // DuplicateStayConflictError thrown by createConfirmedBooking.
  beforeEach(() => {
    // Phase-1 duplicate-stay guard sees nothing (the concurrent confirm hasn't
    // committed yet from this transaction's snapshot).
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
    // Quote path: a priceable lodge whose price still matches the stored offer.
    mocks.seasonFindMany.mockResolvedValue([
      {
        id: "season-1",
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-31"),
        type: "STANDARD",
        // Membership-type-keyed rates (#1930, E4); pricing is mocked so an
        // empty set is fine, but toSeasonRateData reads this relation.
        membershipTypeRates: [],
      },
    ]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.priceBooking.mockResolvedValue({ totalPriceCents: 34_000 });
  });

  it("rejects with DUPLICATE_STAY, creates no committed booking, and leaves the offer intact when the in-transaction re-check trips", async () => {
    // Phase 1 passes; the second-layer guard inside createConfirmedBooking finds
    // a stay committed by a concurrent confirm and rolls its transaction back,
    // surfaced as DuplicateStayConflictError.
    mocks.createConfirmedBooking.mockRejectedValue(new DuplicateStayConflictError());

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("DUPLICATE_STAY");
    // Same friendly message as the Phase-1 guard.
    expect(result.error).toBe(
      "You already have a booking at this lodge for these dates. Cancel it before accepting this offer.",
    );
    // Phase 2 ran (Phase 1 passed) and was handed the guard field naming the
    // entry to exclude.
    expect(mocks.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(mocks.createConfirmedBooking.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        duplicateStayGuard: { excludeBookingId: "entry-1" },
      }),
    );
    // The rolled-back transaction committed nothing, and the offer is NOT
    // reverted to WAITLISTED — no booking mutation happens on this path.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
  });

  it("lets a non-guard error from createConfirmedBooking propagate to the generic failure (not misclassified as DUPLICATE_STAY)", async () => {
    // A different failure inside Phase 2 must not be mapped to the duplicate
    // rejection: only DuplicateStayConflictError is special-cased.
    mocks.createConfirmedBooking.mockRejectedValue(new Error("boom"));

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe("An error occurred while confirming your booking");
    expect(mocks.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });
});

describe("confirmCrossLodgeWaitlistOffer minimum-stay guard (#2363)", () => {
  // A cross-lodge offer calls `createConfirmedBooking` directly, so nothing
  // else on this path applies the minimum-stay rule at all. It also matters
  // more here than anywhere else: per-lodge policy resolution REPLACES the
  // club-wide set, so the offered lodge can carry rules the member's own lodge
  // has never had.
  const violation = {
    reasonCode: "MINIMUM_STAY",
    policyId: "policy-lodge-b",
    policyVersion: 3,
    policyName: "Lodge B winter week",
    resolvedScope: {
      kind: "LODGE",
      lodgeId: "lodge-b",
      effectiveLodgeId: "lodge-b",
    },
    affectedNights: ["2026-08-10", "2026-08-11"],
    exceptionEligible: true,
    capacityMode: "HOLD",
    message:
      "Bookings including a Monday night require a minimum stay of 4 nights (Lodge B winter week). Your booking is 2 nights.",
    triggerDay: "Monday",
    minimumNights: 4,
    actualNights: 2,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights: 4,
      actualNights: 2,
      triggerDays: [1],
    },
  };

  it("refuses an offer the OFFERED lodge's stricter rule rejects, leaves the entry waitlisted, and creates nothing", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("MINIMUM_STAY_VIOLATION");
    // Evaluated against the OFFERED lodge, not the lodge the member queued at.
    expect(mocks.validateMinimumStay).toHaveBeenCalledWith(
      CHECK_IN,
      CHECK_OUT,
      "lodge-b",
    );
    // Nothing was priced, claimed or created for a stay the policy refuses.
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
    expect(mocks.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    // The offer is NOT consumed: the entry goes back on the waitlist under the
    // offered lodge's lock, exactly as the no-longer-eligible branch does.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-b",
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.WAITLISTED }),
      }),
    );
    expectOfferEpochFence(mocks.bookingUpdateMany.mock.calls[0][0].where);
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
  });

  it("tells the member a plain sentence and never the rule's name or night counts", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");
    const wire = JSON.stringify(result);

    expect(result.error).toBe(
      "That lodge's minimum stay for these nights is longer than your stay, so " +
        "this offer cannot be confirmed. You've been returned to the waitlist.",
    );
    // The frozen review snapshot stays server-side: none of the policy's own
    // identifying detail rides the result the route serialises.
    expect(wire).not.toContain("Lodge B winter week");
    expect(wire).not.toContain("policy-lodge-b");
    expect(wire).not.toContain("minimum stay of 4 nights");
  });

  it("does not run the check for a stranger, an already-expired offer, or a non-offered entry", async () => {
    mocks.prismaBookingFindUnique.mockResolvedValue(offeredEntry());
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-2");
    expect(mocks.validateMinimumStay).not.toHaveBeenCalled();

    mocks.prismaBookingFindUnique.mockResolvedValue(
      offeredEntry({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
    );
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");
    expect(mocks.validateMinimumStay).not.toHaveBeenCalled();

    mocks.prismaBookingFindUnique.mockResolvedValue(
      offeredEntry({ status: BookingStatus.WAITLISTED }),
    );
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");
    expect(mocks.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("leaves a compliant confirm completely unaffected", async () => {
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
    mocks.seasonFindMany.mockResolvedValue([
      {
        id: "season-1",
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-31"),
        type: "STANDARD",
        membershipTypeRates: [],
      },
    ]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.priceBooking.mockResolvedValue({ totalPriceCents: 34_000 });
    mocks.createConfirmedBooking.mockRejectedValue(new Error("boom"));

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    // It got all the way to Phase 2, so the guard let it through untouched.
    expect(mocks.validateMinimumStay).toHaveBeenCalledTimes(1);
    expect(mocks.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(result.code).toBeUndefined();
  });
});

/**
 * #2543's paid-up-adult requirement on the CROSS-LODGE promotion (owner arm:
 * owner decision, 3 Aug 2026).
 *
 * This path reached none of the rule. The offer sweep re-bases a stored waitlisted
 * price at current rates and inherits the unpaid-subscription reprice, and the
 * promotion then calls `createConfirmedBooking` DIRECTLY — so the create route's
 * own gate never ran either. A party the create route would have refused with a 409
 * and an override door could be promoted here and charged non-member rates
 * instead: the reprice was universal, the safeguards were wired to hand-picked
 * routes. Same defect the removal and modify-apply paths had.
 */
describe("confirmCrossLodgeWaitlistOffer paid-up-adult requirement (#2543)", () => {
  /** What the real evaluator returns for a party it is repricing and refusing. */
  const repricedRefusal = {
    repricedMemberIds: ["member-unpaid"],
    hasPaidUpAdultMember: false,
    paidUpAdultMemberRequired: true,
    memberRateNotice: "A membership subscription on this booking isn't paid",
    violation: {
      reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED" as const,
      policyId: "membership-lockout-settings:default",
      policyVersion: 1,
      policyName: "Paid-up adult member required (subscription lockout)",
      resolvedScope: {
        kind: "CLUB_WIDE" as const,
        lodgeId: null,
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2026-08-10", "2026-08-11"],
      requirements: {
        kind: "PAID_UP_ADULT_MEMBER" as const,
        requiredPaidUpAdultMembers: 1 as const,
        repricedUnpaidMemberCount: 1,
        participantCount: 2,
      },
      exceptionEligible: true,
      capacityMode: "HOLD" as const,
      message:
        "This booking needs at least one paid-up adult member staying on it.",
    },
  };

  /**
   * The OWNER arm's shape: nobody on the party is repriced (the unfinancial member
   * is the booker and takes no bed here), so there is no rate notice to give — and
   * the requirement bites anyway. This is the cell the widened trigger added, and
   * the one a cross-lodge promotion could otherwise be used to walk around.
   */
  const ownerRefusal = {
    ...repricedRefusal,
    repricedMemberIds: [] as string[],
    memberRateNotice: null,
    violation: {
      ...repricedRefusal.violation,
      requirements: {
        ...repricedRefusal.violation.requirements,
        repricedUnpaidMemberCount: 0,
      },
    },
  };

  /** Repriced, but a paid-up adult IS on the party: it promotes, and is told why. */
  const repricedAndCompliant = {
    repricedMemberIds: ["member-unpaid"],
    hasPaidUpAdultMember: true,
    paidUpAdultMemberRequired: true,
    memberRateNotice: "A membership subscription on this booking isn't paid",
    violation: null,
  };

  /** Reaches Phase 2, so a compliant party is shown to get all the way through. */
  function letPhase1Pass() {
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
    mocks.seasonFindMany.mockResolvedValue([
      {
        id: "season-1",
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-31"),
        type: "STANDARD",
        membershipTypeRates: [],
      },
    ]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.priceBooking.mockResolvedValue({ totalPriceCents: 34_000 });
  }

  function createdBooking() {
    return {
      type: "created",
      booking: {
        id: "new-booking",
        status: BookingStatus.PAYMENT_PENDING,
        finalPriceCents: 34_000,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
      },
    };
  }

  it.each([
    ["somebody staying is repriced", repricedRefusal],
    ["the BOOKER is unfinancial and takes no bed", ownerRefusal],
  ])(
    "refuses the promotion when %s and no paid-up adult member is on the party",
    async (_case, evaluation) => {
      mocks.evaluateNonMemberPricing.mockResolvedValue(evaluation);

      const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

      expect(result.success).toBe(false);
      expect(result.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
      // The WAITLIST flavour of the shared refusal: the offer was rejected without
      // being consumed, so the bare sentence would read as though the member had
      // lost the offer AND their spot.
      expect(result.error).toBe(formatMissingPaidUpAdultWaitlistRefusal());
      expect(result.error).toContain("kept your place on the waitlist");
      // The frozen violation's own message is unchanged — it is hashed into
      // exception snapshots and read by the reviewing officer, for whom the
      // waitlist sentence is neither true nor relevant.
      expect(result.paidUpAdultRefusal?.details).toBe(
        evaluation.violation.message,
      );
      // Nothing was priced, claimed or created for a party the rule refuses.
      expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
      expect(mocks.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    },
  );

  it("fails closed WITHOUT consuming the offer, so the member keeps their place", async () => {
    mocks.evaluateNonMemberPricing.mockResolvedValue(repricedRefusal);

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    // Reverted to WAITLISTED under the OFFERED lodge's lock, exactly as the
    // minimum-stay branch beside it does: the member can fix the party or ask a
    // Booking Officer instead of the offer being burnt.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-b",
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingStatus.WAITLISTED,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
        }),
      }),
    );
    expectOfferEpochFence(mocks.bookingUpdateMany.mock.calls[0][0].where);
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
  });

  it("carries the override door and the HOLD promise, in the shared shape", async () => {
    // Built by the REAL `buildPaidUpAdultRefusalBody`, so this path cannot answer
    // the same refusal in a different shape from the booking write paths — and the
    // waitlist-confirm route spreads it into a 409 with no cross-lodge special case.
    mocks.evaluateNonMemberPricing.mockResolvedValue(repricedRefusal);

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.paidUpAdultRefusal?.code).toBe(
      "PAID_UP_ADULT_MEMBER_REQUIRED",
    );
    expect(result.paidUpAdultRefusal?.exceptionRequestPath).toBe(
      "/api/bookings/exception-requests",
    );
    expect(result.paidUpAdultRefusal?.exceptionReview.capacityMode).toBe("HOLD");
  });

  it("names no identities on the wire", async () => {
    mocks.evaluateNonMemberPricing.mockResolvedValue(repricedRefusal);

    const wire = JSON.stringify(
      await confirmCrossLodgeWaitlistOffer("entry-1", "member-1"),
    );

    expect(wire).not.toContain("member-unpaid");
  });

  it("judges the OFFERED lodge, the entry's owner, and the promoted party", async () => {
    mocks.prismaBookingGuestFindMany.mockResolvedValue([
      { isMember: true, memberId: "member-1", consentStatus: null },
    ]);
    mocks.evaluateNonMemberPricing.mockResolvedValue(null);

    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(mocks.evaluateNonMemberPricing).toHaveBeenCalledTimes(1);
    const input = mocks.evaluateNonMemberPricing.mock.calls[0][1];
    expect(input).toEqual(
      expect.objectContaining({
        // The lodge the booking will exist at, not the one the member queued at —
        // matching the minimum-stay check above it.
        lodgeId: "lodge-b",
        mode: "NON_MEMBER_PRICING",
        seasonYear: 2026,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        // Owner decision, 3 Aug 2026: the entry's owner, who stays the owner of
        // the booking Phase 2 creates.
        bookingOwnerMemberId: "member-1",
      }),
    );
    // The party was read on the MODULE client, and mapped through the shared D-12
    // participant mapper rather than passed raw.
    expect(mocks.prismaBookingGuestFindMany).toHaveBeenCalledWith({
      where: { bookingId: "entry-1" },
    });
    expect(input.participants).toEqual([
      expect.objectContaining({
        isMember: true,
        memberId: "member-1",
        operationallyPresent: true,
      }),
    ]);
  });

  it("promotes a repriced party that HAS a paid-up adult member, and tells them why", async () => {
    letPhase1Pass();
    mocks.evaluateNonMemberPricing.mockResolvedValue(repricedAndCompliant);
    mocks.createConfirmedBooking.mockResolvedValue(createdBooking());

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(true);
    expect(result.newBookingId).toBe("new-booking");
    // The cross-lodge quote can differ from the member's own lodge by the whole
    // member/non-member spread, so the figure they have just accepted owes them
    // the reason — the same sentence the offer email carried.
    expect(result.subscriptionMemberRateNotice).toContain("isn't paid");
  });

  it("adds no notice key at all when nobody is repriced", async () => {
    // Every other outcome keeps its exact previous shape, so a caller comparing
    // the whole object sees no new key on a party nobody is being repriced on.
    letPhase1Pass();
    mocks.evaluateNonMemberPricing.mockResolvedValue(null);
    mocks.createConfirmedBooking.mockResolvedValue(createdBooking());

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(true);
    expect("subscriptionMemberRateNotice" in result).toBe(false);
  });

  it("cancels Phase 3 only for the exact offer epoch and reconciles the winner", async () => {
    letPhase1Pass();
    mocks.createConfirmedBooking.mockResolvedValue(createdBooking());

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(true);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(1);
    expectOfferEpochFence(mocks.bookingUpdateMany.mock.calls[0][0].where);
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ waitlistEntryCleanupCompleted: true }),
      }),
    );
  });

  it("keeps a changed offer intact when Phase 3 loses its epoch claim", async () => {
    letPhase1Pass();
    mocks.createConfirmedBooking.mockResolvedValue(createdBooking());
    mocks.bookingUpdateMany.mockResolvedValue({ count: 0 });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(true);
    expectOfferEpochFence(mocks.bookingUpdateMany.mock.calls[0][0].where);
    expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.stringContaining("changed before cleanup"),
        metadata: expect.objectContaining({ waitlistEntryCleanupCompleted: false }),
      }),
    );
  });

  it("commits replacement cancellation when the price-refresh epoch claim loses", async () => {
    letPhase1Pass();
    mocks.createConfirmedBooking.mockResolvedValue({
      ...createdBooking(),
      booking: { ...createdBooking().booking, finalPriceCents: 35_000 },
    });
    mocks.bookingUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result).toEqual({
      success: false,
      error:
        "This waitlist offer changed while it was being confirmed. Refresh and review the current offer.",
    });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: { id: "new-booking", status: BookingStatus.PAYMENT_PENDING },
        data: { status: BookingStatus.CANCELLED },
      }),
    );
    expectOfferEpochFence(mocks.bookingUpdateMany.mock.calls[1][0].where);
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
  });

  it("resolves the club's mode ONCE, and before any capacity lock is taken", async () => {
    // `resolveSubscriptionLockoutMode` reseeds the financial-year cache and can
    // reach Xero; underneath the offered lodge's capacity lock that is the one
    // thing the booking rules forbid outright. The resolved mode is passed in, so
    // the evaluation takes no second pool connection either.
    mocks.evaluateNonMemberPricing.mockResolvedValue(repricedRefusal);

    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(mocks.resolveSubscriptionLockoutMode).toHaveBeenCalledTimes(1);
    expect(
      mocks.resolveSubscriptionLockoutMode.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]);
  });

  it("does not run the check for a stranger, an already-expired offer, or a non-offered entry", async () => {
    // Same preconditions as the minimum-stay check it sits beside: the gate must
    // not answer anything about an offer this caller does not own.
    mocks.prismaBookingFindUnique.mockResolvedValue(offeredEntry());
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-2");
    expect(mocks.evaluateNonMemberPricing).not.toHaveBeenCalled();

    mocks.prismaBookingFindUnique.mockResolvedValue(
      offeredEntry({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
    );
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");
    expect(mocks.evaluateNonMemberPricing).not.toHaveBeenCalled();

    mocks.prismaBookingFindUnique.mockResolvedValue(
      offeredEntry({ status: BookingStatus.WAITLISTED }),
    );
    await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");
    expect(mocks.evaluateNonMemberPricing).not.toHaveBeenCalled();
  });

  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "is a no-op under %s: the promotion is untouched",
    async (mode) => {
      mocks.resolveSubscriptionLockoutMode.mockResolvedValue(mode);
      // What the real evaluator does outside NON_MEMBER_PRICING, before any query.
      mocks.evaluateNonMemberPricing.mockResolvedValue(null);
      letPhase1Pass();
      mocks.createConfirmedBooking.mockRejectedValue(new Error("boom"));

      const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

      // It got all the way to Phase 2, so the gate let it through untouched.
      expect(mocks.createConfirmedBooking).toHaveBeenCalledTimes(1);
      expect(result.code).toBeUndefined();
      // ...and the mode the gate branched on is the one the club is in.
      expect(mocks.evaluateNonMemberPricing).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mode }),
      );
    },
  );
});
