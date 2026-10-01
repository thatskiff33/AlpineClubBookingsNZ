import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
  DIFFERENT_PERSON_SAME_NAME,
  OwnDependantIdentityRefusedError,
  type DependantIdentityRefusal,
} from "@/lib/booking-dependant-identity";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_EDIT_MESSAGE,
  DEPENDANT_IDENTITY_UNRESOLVED_EDIT_MESSAGE,
  DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE,
} from "@/lib/booking-dependant-identity-doors";

// #3451 (`INV-GUEST-019`): the SAVE door's wiring. The guard itself runs in the
// guest planner and is pinned in `booking-modify-plan-dependant-identity.test.ts`;
// this suite pins that `PUT /modify` carries the member's answers to it, refuses
// them on a date-only override, and turns the planner's refusal into the create
// route's body — in the member's words, or the officer's when the officer is not
// the booking's own member.

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
    body: JSON.stringify(body),
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

const unresolved: DependantIdentityRefusal = {
  code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  status: 409,
  error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
  collisions: [],
};

const declaration = {
  kind: DIFFERENT_PERSON_SAME_NAME,
  dependantMemberId: "dep-sam",
  normalizedName: "sam smith",
};

const addSam = {
  addGuests: [
    { firstName: "Sam", lastName: "Smith", ageTier: "CHILD", isMember: false },
  ],
};

describe("PUT /api/bookings/[id]/modify — own-dependant identity (#3451)", () => {
  it("hands the member's answers to the batch service", async () => {
    const res = await PUT(
      req({ ...addSam, dependantIdentityDeclarations: [declaration] }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(
      h.modifyBookingBatch.mock.calls[0][0].input.dependantIdentityDeclarations,
    ).toEqual([declaration]);
  });

  it("refuses a malformed answer at the schema", async () => {
    const res = await PUT(
      req({
        ...addSam,
        dependantIdentityDeclarations: [{ kind: "override", override: true }],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("answers the planner's refusal with the create route's code, in the edit wording", async () => {
    h.modifyBookingBatch.mockRejectedValue(
      new OwnDependantIdentityRefusedError(unresolved, "m1"),
    );

    const res = await PUT(req(addSam), { params });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
      error: DEPENDANT_IDENTITY_UNRESOLVED_EDIT_MESSAGE,
    });
  });

  it("speaks to an officer about the member's dependant", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin1" } });
    h.authorizationRole.mockReturnValue("ADMIN");
    h.modifyBookingBatch.mockRejectedValue(
      new OwnDependantIdentityRefusedError(unresolved, "m1"),
    );

    const res = await PUT(req(addSam), { params });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
      error: DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE,
    });
  });

  it("speaks to an officer editing their OWN booking as the member they are", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin1" } });
    h.authorizationRole.mockReturnValue("ADMIN");
    h.modifyBookingBatch.mockRejectedValue(
      new OwnDependantIdentityRefusedError(unresolved, "admin1"),
    );

    const res = await PUT(req(addSam), { params });

    expect((await res.json()).error).toBe(DEPENDANT_IDENTITY_UNRESOLVED_EDIT_MESSAGE);
  });

  it("passes a tampering refusal through with its own status and sentence", async () => {
    h.modifyBookingBatch.mockRejectedValue(
      new OwnDependantIdentityRefusedError(
        {
          code: DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
          status: 400,
          error: "stale",
          collisions: [],
        },
        "m1",
      ),
    );

    const res = await PUT(req(addSam), { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
      error: DEPENDANT_IDENTITY_DECLARATION_INVALID_EDIT_MESSAGE,
    });
  });

  it("refuses an answer on an admin date-only override", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin1" } });
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-08-20",
        dependantIdentityDeclarations: [declaration],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });
});
