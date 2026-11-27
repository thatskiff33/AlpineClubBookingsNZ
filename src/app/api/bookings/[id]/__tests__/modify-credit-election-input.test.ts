import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSaveFigures } from "@/lib/__tests__/support/edit-save-figures";
import { NextRequest } from "next/server";

// #2266: PUT /api/bookings/[id]/modify accepts `applyCreditCents` (the edit
// path's credit election, #2265) and hands it to the batch service untouched —
// and the admin date-only override refuses it explicitly, because a 0-cent
// election is falsy and would slip a Boolean() check.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  modifyBookingBatch: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: h.modifyBookingBatch,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/booking-modify-validation", () => ({
  BookingModifyReviewJustificationRequiredError: class extends Error {},
}));
vi.mock("@/lib/booking-guests", () => ({
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
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  BookingMemberNightConflictError: class extends Error {},
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    conflicts,
  }),
}));
vi.mock("@/lib/over-capacity-confirmation", () => ({
  OverCapacityConfirmationRequiredError: class extends Error {},
}));
vi.mock("@/lib/booking-envelope-invariants", () => ({
  isBookingEnvelopeInvariantViolation: () => false,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/xero-period-lock-guard", () => ({
  getXeroLockGuardErrorResponse: () => null,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify", {
    method: "PUT",
    body: JSON.stringify(withSaveFigures(body)),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.modifyBookingBatch.mockResolvedValue({ booking: { id: "b1" } });
});

describe("PUT /api/bookings/[id]/modify — applyCreditCents (#2266)", () => {
  it("passes the election through to the batch service", async () => {
    const res = await PUT(req({ applyCreditCents: 8_650 }), { params });

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingBatch.mock.calls[0][0].input.applyCreditCents).toBe(
      8_650,
    );
  });

  it("accepts 0 (clear the saved election)", async () => {
    const res = await PUT(req({ applyCreditCents: 0 }), { params });

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch.mock.calls[0][0].input.applyCreditCents).toBe(0);
  });

  it("rejects negative and fractional amounts at the schema", async () => {
    for (const applyCreditCents of [-1, 12.5]) {
      const res = await PUT(req({ applyCreditCents }), { params });
      expect(res.status).toBe(400);
    }
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("refuses a credit election on an admin date-only override — even a falsy 0", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin1" } });
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-08-20",
        applyCreditCents: 0,
      }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/dates only/);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });
});
