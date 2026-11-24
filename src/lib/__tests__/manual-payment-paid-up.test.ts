import { beforeEach, describe, expect, it, vi } from "vitest";

// E14 (#1944): a manually marked-paid subscription is a status === "PAID" row,
// so every consumer that keys off PAID treats the member as paid-up with no
// extra wiring. This integration-style test drives the booking paid-up gate
// (findUnpaidMemberGuests) with a PAID row and asserts the member is NOT flagged
// unpaid — the same status the nomination check and /api/member/subscription-
// status already read.

vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutPolicy: vi.fn().mockResolvedValue({
    mode: "HARD_BLOCK",
    liabilitySettings: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
  }),
}));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));

import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";

function buildDb(subscriptionStatus: string) {
  const memberRows = [
    { id: "g1", firstName: "Guest", lastName: "One", email: "g1@test", role: "USER", ageTier: "ADULT" },
  ];
  return {
    memberSubscription: {
      findMany: vi.fn().mockResolvedValue([
        {
          memberId: "g1",
          status: subscriptionStatus,
          xeroOnlineInvoiceUrl: null,
          xeroInvoiceNumber: null,
        },
      ]),
    },
    member: { findMany: vi.fn().mockResolvedValue(memberRows) },
    seasonalMembershipAssignment: {
      findMany: vi.fn().mockResolvedValue([
        {
          memberId: "g1",
          seasonYear: 2026,
          membershipType: {
            id: "type-full", key: "FULL", name: "Full", isActive: true, isBuiltIn: true,
            bookingBehavior: "ALLOW_BOOKING", subscriptionBehavior: "REQUIRED",
          },
        },
      ]),
    },
    membershipType: { findMany: vi.fn().mockResolvedValue([]) },
  } as never;
}

describe("manual PAID makes a member paid-up on the booking gate (#1944)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not flag a REQUIRED-type member guest whose subscription is PAID", async () => {
    const unpaid = await findUnpaidMemberGuests(buildDb("PAID"), {
      bookingMemberId: "owner",
      checkIn: new Date("2026-07-15T00:00:00.000Z"),
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(unpaid).toEqual([]);
  });

  it("still flags the same REQUIRED-type member guest when NOT paid (control)", async () => {
    const unpaid = await findUnpaidMemberGuests(buildDb("NOT_INVOICED"), {
      bookingMemberId: "owner",
      checkIn: new Date("2026-07-15T00:00:00.000Z"),
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(unpaid.map((row) => row.memberId)).toEqual(["g1"]);
  });
});
