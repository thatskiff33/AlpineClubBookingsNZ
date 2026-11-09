import { describe, expect, it } from "vitest";
import {
  allHutFeeCellKeys,
  filterHutFeeRateTypes,
  HUT_FEE_FLAT_KEY,
  hutFeeCellKey,
  hutFeeCellsForType,
} from "@/app/(admin)/admin/finance/xero/_components/hut-fee-grid";

const TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT"] as const;

const full = {
  id: "type-full",
  key: "FULL",
  name: "Full Member",
  bookingBehavior: "MEMBER_RATE" as const,
  ageGroupsApply: true,
  isActive: true,
};
const nonMember = {
  id: "type-nonmember",
  key: "NON_MEMBER",
  name: "Non-Member",
  bookingBehavior: "NON_MEMBER_RATE" as const,
  ageGroupsApply: true,
  isActive: true,
};
const schoolFlat = {
  id: "type-school",
  key: "SCHOOL_GROUP",
  name: "School Group",
  bookingBehavior: "MEMBER_RATE" as const,
  ageGroupsApply: false,
  isActive: true,
};
const blocked = {
  id: "type-blocked",
  key: "SOCIAL",
  name: "Social",
  bookingBehavior: "BLOCK_BOOKING" as const,
  ageGroupsApply: true,
  isActive: true,
};
const forced = {
  id: "type-forced",
  key: "ASSOCIATE",
  name: "Associate",
  bookingBehavior: "NON_MEMBER_RATE" as const,
  ageGroupsApply: true,
  isActive: true,
};
const archived = { ...full, id: "type-archived", key: "OLD", isActive: false };

describe("hut-fee item-code grid model (#1930, E4)", () => {
  it("shows only active rate-bearing types: MEMBER_RATE plus the built-in NON_MEMBER (D2)", () => {
    const rows = filterHutFeeRateTypes([full, nonMember, schoolFlat, blocked, forced, archived]);
    expect(rows.map((t) => t.id)).toEqual([full.id, nonMember.id, schoolFlat.id]);
  });

  it("an age-keyed type gets one cell per tier; a flat type gets the single FLAT cell", () => {
    expect(hutFeeCellsForType(full, TIERS)).toEqual([...TIERS]);
    expect(hutFeeCellsForType(schoolFlat, TIERS)).toEqual([HUT_FEE_FLAT_KEY]);
  });

  it("cell keys use the route's composite `${membershipTypeId}_${seasonType}_${ageTier|FLAT}` shape", () => {
    expect(hutFeeCellKey(full.id, "WINTER", "ADULT")).toBe("type-full_WINTER_ADULT");
    expect(hutFeeCellKey(schoolFlat.id, "SUMMER", HUT_FEE_FLAT_KEY)).toBe("type-school_SUMMER_FLAT");
  });

  it("copy-to-all enumerates every cell across seasons, tiers, and flat types", () => {
    const keys = allHutFeeCellKeys([full, schoolFlat], TIERS);
    // full: 2 seasons x 4 tiers; schoolFlat: 2 seasons x 1 flat cell.
    expect(keys).toHaveLength(10);
    expect(keys).toContain("type-full_WINTER_INFANT");
    expect(keys).toContain("type-full_SUMMER_ADULT");
    expect(keys).toContain("type-school_WINTER_FLAT");
    expect(keys).toContain("type-school_SUMMER_FLAT");
    expect(new Set(keys).size).toBe(keys.length);
  });
});
