import { describe, it, expect } from "vitest";
import { validateMembershipTypeSeasonRates } from "@/lib/season-rate-editor";

// The season rate editor may only write rows for rate-bearing membership types:
// every MEMBER_RATE type plus the built-in NON_MEMBER type (#1930, E4, D2).

const TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE" },
  { id: "mt-life", key: "LIFE", bookingBehavior: "MEMBER_RATE" },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE" },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE" },
  { id: "mt-block", key: "BLOCKED", bookingBehavior: "BLOCK_BOOKING" },
  // The built-in FULL after an officer picked a different booking behaviour for
  // it. The route's built-in guard covers deletion only, and the
  // membership-types screen offers the selector for every type.
  { id: "mt-full-rebehaved", key: "FULL", bookingBehavior: "NON_MEMBER_RATE" },
];

function makeDb() {
  return {
    membershipType: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        TYPES.filter((t) => args.where.id.in.includes(t.id)),
    },
  };
}

describe("validateMembershipTypeSeasonRates (#1930, E4)", () => {
  it("accepts MEMBER_RATE types and the built-in NON_MEMBER type", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1000 },
      { membershipTypeId: "mt-life", ageTier: null, pricePerNightCents: 900 },
      { membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 2400 },
    ]);
    expect(error).toBeNull();
  });

  it("rejects a NON_MEMBER_RATE type that is not NON_MEMBER (D2 zero-own-rows)", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-associate", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/does not carry its own hut rates/);
  });

  it("rejects a BLOCK_BOOKING type", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-block", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/does not carry its own hut rates/);
  });

  it("accepts a key-resolved built-in whose booking behaviour was edited", async () => {
    /*
      `FULL` is resolved BY KEY for an unplaceable member and for every
      other-lodge guest, so its rows are read whatever its own row says — and
      the Hut Fees panel now names it as missing a rate on exactly that
      footing. If this validator still asked the behaviour question alone, the
      officer who followed that warning would have the WHOLE season save
      refused, told that a type the engine is at that moment pricing from
      "does not carry its own hut rates".

      Not a hypothetical shape: the same edit is one click on the
      membership-types screen, whose labels ("Member rate", "Non-member rate")
      read like a pricing preference.
    */
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      {
        membershipTypeId: "mt-full-rebehaved",
        ageTier: "ADULT",
        pricePerNightCents: 1000,
      },
    ]);
    expect(error).toBeNull();
  });

  it("rejects an unknown membership type id", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-ghost", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/Unknown membership type/);
  });

  it("rejects a duplicate (membershipType, ageTier) row", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1000 },
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1100 },
    ]);
    expect(error).toMatch(/Duplicate rate/);
  });
});
