import { describe, it, expect } from "vitest";
import { validatePromoCodeRules, type PromoRuleSubject } from "../promo";
import { requireCalendarDate } from "@/lib/club-time";

function makePromoCode(overrides: Partial<PromoRuleSubject> = {}): PromoRuleSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    ...overrides,
  };
}

// #3123 — the CLUB's calendar day, which is what the validator takes now.
// Same day the old instant fixture projected to under the container's zone.
const now = requireCalendarDate("2026-07-16");

describe("validatePromoCodeRules - member assignments", () => {
  it("allows any member when no assignments (null)", () => {
    expect(
      validatePromoCodeRules(makePromoCode(), { memberId: "member-1" }, now, {}, null)
    ).toBeNull();
  });

  it("allows any member when assignments array is empty", () => {
    expect(
      validatePromoCodeRules(makePromoCode(), { memberId: "member-1" }, now, {}, [])
    ).toBeNull();
  });

  it("allows an assigned member to use the code", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode(),
        { memberId: "member-1" },
        now,
        {},
        ["member-1", "member-2", "member-3"]
      )
    ).toBeNull();
  });

  it("rejects a member not in the assignment list", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode(),
        { memberId: "member-99" },
        now,
        {},
        ["member-1", "member-2", "member-3"]
      )
    ).toBe("This promo code is not assigned to you");
  });

  it("rejects when memberId is empty and assignments exist", () => {
    expect(
      validatePromoCodeRules(makePromoCode(), { memberId: "" }, now, {}, ["member-1"])
    ).toBe("This promo code is not assigned to you");
  });

  it("checks assignment before single-use", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        { memberId: "member-99" },
        now,
        { memberRedemptionCount: 1 },
        ["member-1"]
      )
    ).toBe("This promo code is not assigned to you");
  });

  it("assigned member blocked by single-use (maxUsesPerMember=1) if already redeemed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        { memberId: "member-1" },
        now,
        { memberRedemptionCount: 1 },
        ["member-1", "member-2"]
      )
    ).toBe("You have already used this promo code");
  });

  it("assigned member allowed when single-use not yet redeemed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        { memberId: "member-2" },
        now,
        { memberRedemptionCount: 0 },
        ["member-1", "member-2"]
      )
    ).toBeNull();
  });

  it("inactive code check takes precedence over assignment check", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ active: false }),
        { memberId: "member-99" },
        now,
        {},
        ["member-1"]
      )
    ).toBe("This promo code is no longer active");
  });

  it("expired code check takes precedence over assignment check", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validUntil: new Date("2026-01-01") }),
        { memberId: "member-99" },
        now,
        {},
        ["member-1"]
      )
    ).toBe("This promo code has expired");
  });

  it("max redemptions check takes precedence over assignment check", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 5, currentRedemptions: 5 }),
        { memberId: "member-99" },
        now,
        {},
        ["member-1"]
      )
    ).toBe("This promo code has reached its maximum number of uses");
  });
});

// --- Working Bee Scenario ---

describe("working bee scenario - assigned single-use free night", () => {
  const workingBeePromo = makePromoCode({
    maxUsesPerMember: 1,
    maxRedemptionsTotal: null,
  });
  const assignedMembers = ["alice-id", "bob-id", "carol-id"];

  it("alice can use it (0 prior redemptions)", () => {
    expect(
      validatePromoCodeRules(
        workingBeePromo,
        { memberId: "alice-id" },
        now,
        { memberRedemptionCount: 0 },
        assignedMembers
      )
    ).toBeNull();
  });

  it("bob can use it (0 prior redemptions)", () => {
    expect(
      validatePromoCodeRules(
        workingBeePromo,
        { memberId: "bob-id" },
        now,
        { memberRedemptionCount: 0 },
        assignedMembers
      )
    ).toBeNull();
  });

  it("alice cannot use it again (1 prior redemption)", () => {
    expect(
      validatePromoCodeRules(
        workingBeePromo,
        { memberId: "alice-id" },
        now,
        { memberRedemptionCount: 1 },
        assignedMembers
      )
    ).toBe("You have already used this promo code");
  });

  it("dave (not assigned) cannot use it", () => {
    expect(
      validatePromoCodeRules(
        workingBeePromo,
        { memberId: "dave-id" },
        now,
        { memberRedemptionCount: 0 },
        assignedMembers
      )
    ).toBe("This promo code is not assigned to you");
  });
});

// --- Archive behaviour ---

describe("archive behaviour", () => {
  it("archived codes (active=false) are rejected by validation", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ active: false }),
        { memberId: "member-1" },
        now
      )
    ).toBe("This promo code is no longer active");
  });
});
