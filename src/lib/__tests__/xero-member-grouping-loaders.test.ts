import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
  ruleFindMany: vi.fn(),
  resolveMembershipTypePolicyForMember: vi.fn(),
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: vi.fn().mockResolvedValue(3),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroGroupingSettings: { findUnique: mocks.settingsFindUnique },
    xeroContactGroupRule: { findMany: mocks.ruleFindMany },
  },
}));

vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePolicyForMember: mocks.resolveMembershipTypePolicyForMember,
}));

import {
  getXeroGroupingMode,
  getManagedGroupUniverse,
  resolveMemberGroupingForMember,
  type XeroGroupingRule,
} from "@/lib/xero-member-grouping";

const rules: XeroGroupingRule[] = [
  { membershipTypeId: null, ageTiers: ["ADULT"], kind: "MANAGED", groupId: "g-adult", groupName: "Adults", sortOrder: 0 },
  { membershipTypeId: null, ageTiers: ["YOUTH"], kind: "MANAGED", groupId: "g-youth", groupName: "Youth", sortOrder: 1 },
  { membershipTypeId: "life", ageTiers: [], kind: "MANAGED", groupId: "g-life", groupName: "Life", sortOrder: 2 },
];

function dbRule(rule: XeroGroupingRule) {
  return {
    membershipTypeId: rule.membershipTypeId,
    ageTiers: rule.ageTiers,
    mode: rule.kind,
    groupId: rule.groupId,
    groupName: rule.groupName,
    sortOrder: rule.sortOrder,
  };
}

describe("xero-member-grouping DB loaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ruleFindMany.mockResolvedValue(rules.map(dbRule));
  });

  describe("getXeroGroupingMode", () => {
    it("returns the stored mode", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE" });
      expect(await getXeroGroupingMode()).toBe("MEMBERSHIP_TYPE_AND_AGE");
    });

    it("defaults to NONE when unset", async () => {
      mocks.settingsFindUnique.mockResolvedValue(null);
      expect(await getXeroGroupingMode()).toBe("NONE");
    });
  });

  describe("getManagedGroupUniverse", () => {
    it("is empty under NONE (no managed removals)", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "NONE" });
      expect(await getManagedGroupUniverse()).toEqual([]);
    });

    it("spans all active rule groups under MEMBERSHIP_TYPE_AND_AGE", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE" });
      expect((await getManagedGroupUniverse()).sort()).toEqual(["g-adult", "g-life", "g-youth"]);
    });

    it("excludes tier-bearing rule groups under MEMBERSHIP_TYPE", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "MEMBERSHIP_TYPE" });
      expect(await getManagedGroupUniverse()).toEqual(["g-life"]);
    });
  });

  describe("resolveMemberGroupingForMember", () => {
    it("does not resolve the membership type under NONE", async () => {
      const res = await resolveMemberGroupingForMember({
        memberId: "m1",
        ageTier: "ADULT",
        context: { yearEndMonth: 3, mode: "NONE", activeRules: rules },
      });
      expect(res.skippedReason).toBe("grouping_mode_none");
      expect(mocks.resolveMembershipTypePolicyForMember).not.toHaveBeenCalled();
    });

    it("resolves the effective membership type and matches type rules", async () => {
      mocks.resolveMembershipTypePolicyForMember.mockResolvedValue({
        membershipType: { id: "life" },
      });
      const res = await resolveMemberGroupingForMember({
        memberId: "m1",
        ageTier: "ADULT",
        context: { yearEndMonth: 3, mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: rules },
      });
      // type+null(2) beats tier-only ADULT(1) -> g-life wins
      expect(res.managedGroup?.id).toBe("g-life");
      expect(mocks.resolveMembershipTypePolicyForMember).toHaveBeenCalled();
    });

    it("falls back to tier-only rule when the effective type has no DB row", async () => {
      mocks.resolveMembershipTypePolicyForMember.mockResolvedValue({
        membershipType: { id: null },
      });
      const res = await resolveMemberGroupingForMember({
        memberId: "m1",
        ageTier: "ADULT",
        context: { yearEndMonth: 3, mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: rules },
      });
      expect(res.managedGroup?.id).toBe("g-adult");
    });
  });
});
