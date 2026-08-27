import { beforeEach, describe, expect, it, vi } from "vitest";

// #2266 (epic #2245, E2) — the edit-path counterpart of #2265's stored credit
// election, plus the draft-resume policy change. This suite pins the pure
// policy layer:
//
//  1. `resolveCreditElectionUpdate` — what a modification may write to
//     `Booking.creditElectionCents`, including every refusal (settled,
//     organiser-settled, captured money, PENDING's charge-saved-method
//     invariant) and the two silent clears ($0 settle, explicit 0).
//  2. Booking-edit policy — a member may now edit their OWN draft (the
//     dashboard Resume journey), while the lifecycle set stays FROZEN so admin
//     draft edits keep skipping lifecycle rules exactly as before.
//  3. `applyLifecycleTransitions` — a member draft edit (which does NOT skip
//     lifecycle rules) must not stamp a nonMemberHoldUntil onto a DRAFT.

import {
  CreditElectionNotAllowedError,
  resolveCreditElectionNoticeAudience,
  resolveCreditElectionUpdate,
} from "@/lib/booking-credit-election";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";

const baseInput = {
  status: "PAYMENT_PENDING",
  organiserSettled: false,
  hasCapturedPayment: false,
  settledAtZeroDollars: false,
};

describe("resolveCreditElectionUpdate (#2266)", () => {
  it("leaves the stored election alone when the request carries no credit input", () => {
    expect(
      resolveCreditElectionUpdate({ ...baseInput, requestedCents: undefined }),
    ).toBeUndefined();
  });

  it("clears the election on an explicit 0, whatever the status", () => {
    for (const status of ["DRAFT", "PAYMENT_PENDING", "PAID", "PENDING"]) {
      expect(
        resolveCreditElectionUpdate({
          ...baseInput,
          status,
          requestedCents: 0,
        }),
      ).toBeNull();
    }
  });

  it("drops a request as moot when this very edit settled the booking at $0", () => {
    expect(
      resolveCreditElectionUpdate({
        ...baseInput,
        status: "PAID",
        settledAtZeroDollars: true,
        requestedCents: 8_650,
      }),
    ).toBeNull();
  });

  it.each(["DRAFT", "AWAITING_REVIEW", "PAYMENT_PENDING"])(
    "stores the RAW requested cents on %s — the pay step clamps, not the writer",
    (status) => {
      expect(
        resolveCreditElectionUpdate({
          ...baseInput,
          status,
          requestedCents: 8_650,
        }),
      ).toBe(8_650);
    },
  );

  it.each(["PENDING", "PAID", "CONFIRMED", "COMPLETED", "CANCELLED", "WAITLISTED"])(
    "refuses a positive election on %s — no consumer would ever honour it",
    (status) => {
      expect(() =>
        resolveCreditElectionUpdate({
          ...baseInput,
          status,
          requestedCents: 100,
        }),
      ).toThrow(CreditElectionNotAllowedError);
    },
  );

  it("refuses when the booking is organiser-settled — the member owes nothing", () => {
    expect(() =>
      resolveCreditElectionUpdate({
        ...baseInput,
        organiserSettled: true,
        requestedCents: 100,
      }),
    ).toThrow(/organiser/);
  });

  it("refuses when money has already been captured", () => {
    expect(() =>
      resolveCreditElectionUpdate({
        ...baseInput,
        hasCapturedPayment: true,
        requestedCents: 100,
      }),
    ).toThrow(/has not been paid/);
  });

  it("refuses a negative or fractional amount outright", () => {
    expect(() =>
      resolveCreditElectionUpdate({ ...baseInput, requestedCents: -1 }),
    ).toThrow(CreditElectionNotAllowedError);
    expect(() =>
      resolveCreditElectionUpdate({ ...baseInput, requestedCents: 12.5 }),
    ).toThrow(CreditElectionNotAllowedError);
  });
});

describe("resolveCreditElectionNoticeAudience (#2266 MED-2)", () => {
  it("addresses the booking owner in the second person", () => {
    expect(
      resolveCreditElectionNoticeAudience({
        isBookingOwner: true,
        isNonOwnerAdminViewer: false,
      }),
    ).toBe("owner");
  });

  it("gives an admin-type viewer the third-person phrasing", () => {
    expect(
      resolveCreditElectionNoticeAudience({
        isBookingOwner: false,
        isNonOwnerAdminViewer: true,
      }),
    ).toBe("admin");
  });

  it("shows a linked-guest viewer nothing — the election is the owner's money", () => {
    // A linked guest is neither the owner nor an admin-type viewer; they must
    // not be addressed in the second person about the owner's money, and the
    // owner's elected amount must not be disclosed to them at all.
    expect(
      resolveCreditElectionNoticeAudience({
        isBookingOwner: false,
        isNonOwnerAdminViewer: false,
      }),
    ).toBeNull();
  });
});

describe("booking-edit policy — member drafts (#2266)", () => {
  const future = {
    checkIn: new Date("2999-01-10T00:00:00.000Z"),
    checkOut: new Date("2999-01-12T00:00:00.000Z"),
    // #3123 - the club's day is now an input. Any real day is far behind these
    // fixtures; the frozen clock's own day keeps the case exactly as it read.
    today: new Date("2026-07-01T00:00:00.000Z"),
  };

  it("lets a member edit their own future-dated DRAFT (the Resume journey)", () => {
    expect(canModifyBookingStatusForRole("DRAFT", "USER")).toBe(true);
    const policy = getBookingEditPolicy({
      status: "DRAFT",
      role: "USER",
      ...future,
    });
    expect(policy.canModify).toBe(true);
    expect(policy.mode).toBe("future");
  });

  it("still refuses members on the admin-only statuses", () => {
    for (const status of ["WAITLISTED", "WAITLIST_OFFERED", "BUMPED"]) {
      expect(canModifyBookingStatusForRole(status, "USER")).toBe(false);
      expect(canModifyBookingStatusForRole(status, "ADMIN")).toBe(true);
    }
  });

  it("keeps DRAFT OUT of the active edit lifecycle — admin draft edits must keep skipping lifecycle rules", () => {
    expect(usesActiveBookingEditLifecycle("DRAFT")).toBe(false);
    // The frozen set is byte-for-byte what it derived to before #2266.
    for (const status of [
      "PENDING",
      "PAYMENT_PENDING",
      "CONFIRMED",
      "PAID",
      "COMPLETED",
    ]) {
      expect(usesActiveBookingEditLifecycle(status)).toBe(true);
    }
    expect(usesActiveBookingEditLifecycle("WAITLISTED")).toBe(false);
    expect(usesActiveBookingEditLifecycle("AWAITING_REVIEW")).toBe(false);
  });
});

// --- applyLifecycleTransitions: DRAFT hold guard -------------------------

const mockClamp = vi.fn();
const mockDerive = vi.fn();
const mockQueueSuperseded = vi.fn();
const mockGetHoldPolicy = vi.fn();

vi.mock("@/lib/member-credit", () => ({
  clampAppliedCreditToBookingPrice: (...args: unknown[]) => mockClamp(...args),
  deriveBookingAppliedCreditCents: (...args: unknown[]) => mockDerive(...args),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: (...args: unknown[]) =>
    mockQueueSuperseded(...args),
}));
vi.mock("@/lib/cancellation", () => ({
  calculateDualRefundAmounts: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  getNonMemberHoldPolicy: (...args: unknown[]) => mockGetHoldPolicy(...args),
}));
vi.mock("@/lib/booking-payment-state", () => ({
  getRemainingRefundableCents: vi.fn(),
  hasCapturedPayment: vi.fn(),
  hasIssuedPrimaryXeroInvoice: vi.fn(),
  isSettledBookingStatus: vi.fn(),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: vi.fn(),
}));

import { applyLifecycleTransitions } from "@/lib/booking-modify-settlement";

describe("applyLifecycleTransitions — member DRAFT edits stay hold-free (#2266)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDerive.mockResolvedValue(0);
    mockQueueSuperseded.mockResolvedValue([]);
  });

  it("never computes or stamps a non-member hold on a DRAFT, even with lifecycle rules ON", async () => {
    const result = await applyLifecycleTransitions(
      { payment: { upsert: vi.fn() }, booking: { updateMany: vi.fn() } } as never,
      {
        booking: {
          id: "bk-draft",
          memberId: "m1",
          status: "DRAFT",
          nonMemberHoldUntil: null,
          lodgeId: "lodge-1",
          payment: null,
          creditElectionCents: null,
        } as never,
        bookingId: "bk-draft",
        newCheckIn: new Date("2999-01-10"),
        newFinalPriceCents: 10_000,
        // Non-member guests would trip the hold rail on a real booking.
        guestsForPricing: [{ isMember: false }, { isMember: true }],
        // Member edit: lifecycle rules run (only admins skip on DRAFT).
        skipBookingLifecycleRules: false,
      },
    );

    expect(mockGetHoldPolicy).not.toHaveBeenCalled();
    expect(result.newStatus).toBe("DRAFT");
    expect(result.newNonMemberHoldUntil).toBeNull();
    expect(result.zeroDollarAutoPaid).toBe(false);
  });

  it("parks a review-flagged DRAFT to AWAITING_REVIEW and clears its expiry (create parity)", async () => {
    // The lens scenario's root cause: a member draft edit that trips the
    // no-adult rule must park the booking exactly as booking-create parks a
    // no-adult draft — AWAITING_REVIEW, with draftExpiresAt nulled so the
    // 72-hour sweep cannot delete it mid-review. Before this fix the booking
    // stayed DRAFT with adminReviewStatus PENDING, and the DRAFT pay/confirm
    // doors did not check review fields.
    const result = await applyLifecycleTransitions(
      { payment: { upsert: vi.fn() }, booking: { updateMany: vi.fn() } } as never,
      {
        booking: {
          id: "bk-draft",
          memberId: "m1",
          status: "DRAFT",
          nonMemberHoldUntil: null,
          lodgeId: "lodge-1",
          payment: null,
          creditElectionCents: null,
        } as never,
        bookingId: "bk-draft",
        newCheckIn: new Date("2999-01-10"),
        newFinalPriceCents: 10_000,
        // Minors-only after the edit — the review rule tripped upstream.
        guestsForPricing: [{ isMember: true }],
        skipBookingLifecycleRules: false,
        reviewUpdate: {
          requiresAdminReview: true,
          adminReviewReason: "No adult guest on the booking",
          memberReviewJustification: "Youth trip",
          adminReviewStatus: "PENDING",
          adminReviewNotes: null,
          adminReviewedById: null,
          adminReviewedAt: null,
          parkForReview: true,
          releaseFromReview: false,
        } as never,
      },
    );

    expect(result.newStatus).toBe("AWAITING_REVIEW");
    expect(result.clearDraftExpiresAt).toBe(true);
    // Parked bookings never auto-settle and take no hold.
    expect(result.zeroDollarAutoPaid).toBe(false);
    expect(result.newNonMemberHoldUntil).toBeNull();
    expect(mockGetHoldPolicy).not.toHaveBeenCalled();
  });

  it("does not clear the expiry when parking from PAYMENT_PENDING (non-draft park)", async () => {
    const result = await applyLifecycleTransitions(
      { payment: { upsert: vi.fn() }, booking: { updateMany: vi.fn() } } as never,
      {
        booking: {
          id: "bk-pp",
          memberId: "m1",
          status: "PAYMENT_PENDING",
          nonMemberHoldUntil: null,
          lodgeId: "lodge-1",
          payment: null,
          creditElectionCents: null,
        } as never,
        bookingId: "bk-pp",
        newCheckIn: new Date("2999-01-10"),
        newFinalPriceCents: 10_000,
        guestsForPricing: [{ isMember: true }],
        skipBookingLifecycleRules: false,
        reviewUpdate: {
          requiresAdminReview: true,
          adminReviewReason: "No adult guest on the booking",
          memberReviewJustification: "Youth trip",
          adminReviewStatus: "PENDING",
          adminReviewNotes: null,
          adminReviewedById: null,
          adminReviewedAt: null,
          parkForReview: true,
          releaseFromReview: false,
        } as never,
      },
    );

    expect(result.newStatus).toBe("AWAITING_REVIEW");
    expect(result.clearDraftExpiresAt).toBe(false);
  });

  it("sweeps superseded intents against the EFFECTIVE (credit-reduced) price (INFO-10)", async () => {
    // A PAYMENT_PENDING card booking with $30.00 of applied credit reprices to
    // $100.00: the pay page mints primary intents at the effective $70.00, so
    // the stale-intent sweep must compare against 7000, not the raw 10000 —
    // otherwise a pending intent already at the correct effective amount is
    // cancelled needlessly.
    mockDerive.mockResolvedValue(3_000);
    mockClamp.mockResolvedValue({
      appliedCreditCents: 3_000,
      refundedExcessCents: 0,
    });

    await applyLifecycleTransitions(
      { payment: { upsert: vi.fn() }, booking: { updateMany: vi.fn() } } as never,
      {
        booking: {
          id: "bk-effective",
          memberId: "m1",
          status: "PAYMENT_PENDING",
          nonMemberHoldUntil: null,
          lodgeId: "lodge-1",
          payment: { id: "pay-1" },
          creditElectionCents: null,
        } as never,
        bookingId: "bk-effective",
        newCheckIn: new Date("2999-01-10"),
        newFinalPriceCents: 10_000,
        guestsForPricing: [{ isMember: true }],
        skipBookingLifecycleRules: false,
      },
    );

    expect(mockQueueSuperseded).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "bk-effective",
      paymentId: "pay-1",
      newFinalPriceCents: 7_000,
    });
  });

  it("keeps the hold rail intact for a PENDING booking (control case)", async () => {
    const { calculateBookingHoldDecision } = await import(
      "@/lib/policies/booking-route-decisions"
    );
    (calculateBookingHoldDecision as ReturnType<typeof vi.fn>).mockReturnValue({
      shouldBePending: true,
    });
    mockGetHoldPolicy.mockResolvedValue({ enabled: true, holdDays: 14 });

    const result = await applyLifecycleTransitions(
      { payment: { upsert: vi.fn() }, booking: { updateMany: vi.fn() } } as never,
      {
        booking: {
          id: "bk-pending",
          memberId: "m1",
          status: "PENDING",
          nonMemberHoldUntil: null,
          lodgeId: "lodge-1",
          payment: null,
          creditElectionCents: null,
        } as never,
        bookingId: "bk-pending",
        newCheckIn: new Date("2999-01-10"),
        newFinalPriceCents: 10_000,
        guestsForPricing: [{ isMember: false }],
        skipBookingLifecycleRules: false,
      },
    );

    expect(mockGetHoldPolicy).toHaveBeenCalledTimes(1);
    expect(result.newNonMemberHoldUntil).not.toBeNull();
  });
});

// The flag above is only half the guard: the batch-modification service must
// actually TRANSLATE `lifecycle.clearDraftExpiresAt` into a `draftExpiresAt:
// null` on the booking write. That wiring lives inside a transaction the pure
// suites above never enter, so it is pinned here as a source contract — the
// same technique `review-findings-contracts.test.ts` uses for lock ordering.
// Without it, a review-parked draft would keep its 72-hour expiry stamp,
// diverging from booking-create's review-parked drafts (which carry none).
describe("#2266 — the parked-draft expiry clear is wired into the booking write", () => {
  it("nulls draftExpiresAt on the batch modification update when the lifecycle asks for it", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/booking-batch-modification-service.ts"),
      "utf8",
    );

    // The single booking.update that writes the post-lifecycle status.
    const updateStart = source.indexOf("const updatedBooking = await tx.booking.update(");
    expect(updateStart).toBeGreaterThan(-1);
    const updateBlock = source.slice(updateStart, source.indexOf("include: { guests: true, payment: true },", updateStart));

    expect(updateBlock).toContain("status: lifecycle.newStatus,");
    expect(updateBlock).toContain(
      "...(lifecycle.clearDraftExpiresAt ? { draftExpiresAt: null } : {}),",
    );
  });
});
