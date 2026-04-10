import { describe, it, expect } from "vitest";
import { validatePromoCodeRules } from "../promo";

// --- Test helpers ---

function makePromoCode(overrides: Partial<{
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  maxRedemptions: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  singleUse: boolean;
}> = {}) {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    currentRedemptions: 0,
    membersOnly: false,
    singleUse: false,
    ...overrides,
  };
}

const now = new Date("2026-07-15T12:00:00Z");

// --- Member Assignment Validation Tests ---

describe("validatePromoCodeRules - member assignments", () => {
  it("allows any member when no assignments (null)", () => {
    const result = validatePromoCodeRules(
      makePromoCode(),
      { memberId: "member-1" },
      now,
      0,
      null
    );
    expect(result).toBeNull();
  });

  it("allows any member when assignments array is empty", () => {
    const result = validatePromoCodeRules(
      makePromoCode(),
      { memberId: "member-1" },
      now,
      0,
      []
    );
    expect(result).toBeNull();
  });

  it("allows an assigned member to use the code", () => {
    const result = validatePromoCodeRules(
      makePromoCode(),
      { memberId: "member-1" },
      now,
      0,
      ["member-1", "member-2", "member-3"]
    );
    expect(result).toBeNull();
  });

  it("rejects a member not in the assignment list", () => {
    const result = validatePromoCodeRules(
      makePromoCode(),
      { memberId: "member-99" },
      now,
      0,
      ["member-1", "member-2", "member-3"]
    );
    expect(result).toBe("This promo code is not assigned to you");
  });

  it("rejects when memberId is empty and assignments exist", () => {
    const result = validatePromoCodeRules(
      makePromoCode(),
      { memberId: "" },
      now,
      0,
      ["member-1"]
    );
    expect(result).toBe("This promo code is not assigned to you");
  });

  it("checks assignment before single-use", () => {
    // Member is not assigned but has also used it - assignment check comes first
    const result = validatePromoCodeRules(
      makePromoCode({ singleUse: true }),
      { memberId: "member-99" },
      now,
      1,
      ["member-1"]
    );
    expect(result).toBe("This promo code is not assigned to you");
  });

  it("assigned member blocked by single-use if already redeemed", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ singleUse: true }),
      { memberId: "member-1" },
      now,
      1,
      ["member-1", "member-2"]
    );
    expect(result).toBe("You have already used this promo code");
  });

  it("assigned member allowed when single-use not yet redeemed", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ singleUse: true }),
      { memberId: "member-2" },
      now,
      0,
      ["member-1", "member-2"]
    );
    expect(result).toBeNull();
  });

  it("inactive code check takes precedence over assignment check", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ active: false }),
      { memberId: "member-99" },
      now,
      0,
      ["member-1"]
    );
    expect(result).toBe("This promo code is no longer active");
  });

  it("expired code check takes precedence over assignment check", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ validUntil: new Date("2026-01-01") }),
      { memberId: "member-99" },
      now,
      0,
      ["member-1"]
    );
    expect(result).toBe("This promo code has expired");
  });

  it("max redemptions check takes precedence over assignment check", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ maxRedemptions: 5, currentRedemptions: 5 }),
      { memberId: "member-99" },
      now,
      0,
      ["member-1"]
    );
    expect(result).toBe("This promo code has reached its maximum number of uses");
  });
});

// --- Working Bee Scenario Test ---

describe("working bee scenario - assigned single-use free night", () => {
  const workingBeePromo = makePromoCode({
    singleUse: true,
    maxRedemptions: null, // No global limit; each assigned member gets 1 use
  });
  const assignedMembers = ["alice-id", "bob-id", "carol-id"];

  it("alice can use it (0 prior redemptions)", () => {
    const result = validatePromoCodeRules(
      workingBeePromo,
      { memberId: "alice-id" },
      now,
      0,
      assignedMembers
    );
    expect(result).toBeNull();
  });

  it("bob can use it (0 prior redemptions)", () => {
    const result = validatePromoCodeRules(
      workingBeePromo,
      { memberId: "bob-id" },
      now,
      0,
      assignedMembers
    );
    expect(result).toBeNull();
  });

  it("alice cannot use it again (1 prior redemption)", () => {
    const result = validatePromoCodeRules(
      workingBeePromo,
      { memberId: "alice-id" },
      now,
      1,
      assignedMembers
    );
    expect(result).toBe("You have already used this promo code");
  });

  it("dave (not assigned) cannot use it", () => {
    const result = validatePromoCodeRules(
      workingBeePromo,
      { memberId: "dave-id" },
      now,
      0,
      assignedMembers
    );
    expect(result).toBe("This promo code is not assigned to you");
  });
});

// --- Archive Behaviour Tests (API contract, no DB) ---

describe("archive behaviour", () => {
  it("archived codes (active=false) are rejected by validation", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ active: false }),
      { memberId: "member-1" },
      now
    );
    expect(result).toBe("This promo code is no longer active");
  });
});
