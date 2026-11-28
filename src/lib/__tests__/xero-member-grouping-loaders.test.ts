import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
  ruleFindMany: vi.fn(),
  resolveMembershipTypePolicyForMember: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
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
  loadXeroGroupingContext,
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

    // The universe names no season. Resolving the year-end here would put a
    // possible Xero read in front of every cancellation's group removal.
    it("never resolves the club's year-end", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE" });
      await getManagedGroupUniverse();
      expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
    });
  });

  describe("loadXeroGroupingContext", () => {
    // #1934: under NONE the managed-group sync is a total no-op that makes no
    // Xero call. A cold year-end resolution reads the Xero organisation, so
    // NONE must not start one (#5259).
    it("does not resolve the club's year-end under NONE", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "NONE" });
      expect(await loadXeroGroupingContext()).toEqual({ mode: "NONE", activeRules: rules });
      expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
    });

    it("carries the club's resolved year-end under a grouping mode", async () => {
      mocks.settingsFindUnique.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE" });
      mocks.refreshFinancialYearConfig.mockResolvedValue(6);
      expect(await loadXeroGroupingContext()).toEqual({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        activeRules: rules,
        yearEndMonth: 6,
      });
    });
  });

  describe("resolveMemberGroupingForMember", () => {
    it("does not resolve the membership type under NONE", async () => {
      const res = await resolveMemberGroupingForMember({
        memberId: "m1",
        ageTier: "ADULT",
        context: { mode: "NONE", activeRules: rules },
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

    it.each([
      { yearEndMonth: 3, seasonYear: 2026 },
      { yearEndMonth: 6, seasonYear: 2025 },
      { yearEndMonth: 12, seasonYear: 2026 },
    ])(
      "resolves the type in season $seasonYear on 15 June 2026 for a month-$yearEndMonth year-end",
      async ({ yearEndMonth, seasonYear }) => {
        mocks.resolveMembershipTypePolicyForMember.mockResolvedValue({
          membershipType: { id: "life" },
        });
        await resolveMemberGroupingForMember({
          memberId: "m1",
          ageTier: "ADULT",
          context: { yearEndMonth, mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: rules },
          now: new Date("2026-06-15T00:00:00.000Z"),
        });
        expect(mocks.resolveMembershipTypePolicyForMember).toHaveBeenCalledWith(
          expect.anything(),
          { memberId: "m1", seasonYear },
        );
      },
    );

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
