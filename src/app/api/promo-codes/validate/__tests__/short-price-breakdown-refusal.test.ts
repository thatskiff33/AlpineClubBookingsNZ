/**
 * #2801 — a promo quote is refused, never mispaired, when the pricing pass
 * returns fewer guests than it was given.
 *
 * WHY THIS EXISTS. This route used to walk the BREAKDOWN and read the input
 * guest back out of `guests[index]`; it now walks the guests it handed over and
 * reads the breakdown row for each. Both directions rely on the same
 * undeclared relation — the pricing engine returns one row per input guest —
 * and `PriceBreakdown` states no length relation at all, so a short breakdown
 * type-checks cleanly. Stage 3 of this programme (#2800) found the same class
 * for real: a per-night vector with a HOLE in it passed a length check, an
 * every-entry-is-an-integer check and a sum check, because `every` and `reduce`
 * both skip holes, and a night reached the database with no price.
 *
 * What a mispaired promo costs: the discount is allocated against a guest's
 * nightly rates, so pairing guest 2's rates onto guest 1 quotes a number the
 * save will not honour — the disagreement INV-MOD-028 exists to prevent.
 * Refusing is the only answer that does not invent a price, and the route's
 * existing catch turns it into the non-leaking 400 (#1888) rather than showing
 * an internal message.
 *
 * Frozen clock discipline: every date is anchored to the 2026-07-01 freeze.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  prisma: {
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    promoCode: { findUnique: vi.fn() },
    workPartyEvent: { findUnique: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    member: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    membershipType: { findMany: vi.fn() },
  },
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
  validateAndCalculatePromoDiscount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  })),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));

// Partial mocks with `importOriginal`: both modules export a great deal this
// route's graph reads at import time, and replacing either wholesale kills the
// file before a test runs (docs/TESTING.md).
vi.mock("@/lib/membership-type-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/membership-type-policy")>()),
  priceBookingGuestsWithMembershipTypePolicy:
    mocks.priceBookingGuestsWithMembershipTypePolicy,
}));

vi.mock("@/lib/promo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/promo")>()),
  validateAndCalculatePromoDiscount: mocks.validateAndCalculatePromoDiscount,
}));

import { POST } from "@/app/api/promo-codes/validate/route";

/** Two adults, one night, over the frozen clock's own week. */
function twoGuestRequest() {
  return new NextRequest("http://localhost/api/promo-codes/validate", {
    method: "POST",
    body: JSON.stringify({
      code: "WELCOME",
      checkIn: "2026-08-01",
      checkOut: "2026-08-02",
      guests: [
        { ageTier: "ADULT", isMember: true, memberId: "member-1" },
        { ageTier: "ADULT", isMember: false },
      ],
    }),
    headers: { "Content-Type": "application/json" },
  });
}

function pricedGuest(perNightCents: number[]) {
  return {
    isMember: true,
    priceCents: perNightCents.reduce((sum, cents) => sum + cents, 0),
    perNightCents,
    nightDates: ["2026-08-01"],
    rateMembershipTypeId: "type-full",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.prisma.lodge.findUnique.mockResolvedValue({
    id: "lodge-1",
    active: true,
  });
  mocks.prisma.promoCode.findUnique.mockResolvedValue({
    id: "promo-1",
    code: "WELCOME",
    description: "Welcome discount",
    type: "PERCENT",
    active: true,
  });
  mocks.prisma.season.findMany.mockResolvedValue([]);
  mocks.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
  mocks.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  mocks.prisma.member.findMany.mockResolvedValue([]);
  mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
  mocks.prisma.membershipType.findMany.mockResolvedValue([]);
  mocks.validateAndCalculatePromoDiscount.mockResolvedValue({
    error: null,
    discount: {
      discountCents: 1000,
      priceAdjustmentCents: -1000,
      freeNightsUsed: 0,
      eligibleGuestCount: 2,
    },
  });
});

describe("POST /api/promo-codes/validate with a short price breakdown", () => {
  it("refuses rather than allocating a promo against a guest with no priced row", async () => {
    // ONE row for TWO guests. The old positional read would simply have
    // produced one promo guest and quoted a discount off it.
    mocks.priceBookingGuestsWithMembershipTypePolicy.mockResolvedValue({
      guests: [pricedGuest([7500])],
      totalPriceCents: 15000,
    });

    const response = await POST(twoGuestRequest());

    expect(response.status).toBe(400);
    // The non-leaking sentence (#1888): the internal reason stays in the log.
    expect(await response.json()).toEqual({
      error: "Failed to calculate price",
    });
    // Nothing was allocated, because nothing could be priced honestly.
    expect(mocks.validateAndCalculatePromoDiscount).not.toHaveBeenCalled();
  });

  it("still quotes normally when every guest has a priced row", async () => {
    mocks.priceBookingGuestsWithMembershipTypePolicy.mockResolvedValue({
      guests: [pricedGuest([7500]), pricedGuest([5000])],
      totalPriceCents: 12500,
    });

    const response = await POST(twoGuestRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      valid: true,
      discountCents: 1000,
      totalPriceCents: 12500,
    });
    // Each promo guest carries ITS OWN nightly rates, in the order the guests
    // were sent — the pairing this refusal protects.
    const [, application] =
      mocks.validateAndCalculatePromoDiscount.mock.calls[0] ?? [];
    expect(
      (application as { guests: Array<{ perNightRates: number[] }> }).guests.map(
        (guest) => guest.perNightRates,
      ),
    ).toEqual([[7500], [5000]]);
  });
});
