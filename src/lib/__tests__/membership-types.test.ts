import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_MEMBERSHIP_TYPES,
  DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS,
  MEMBERSHIP_TYPE_AGE_TIERS,
  backfillCurrentSeasonMembershipAssignments,
  canonicalMembershipTypeKey,
  defaultMembershipTypeKeyForRole,
  effectiveSubscriptionBehavior,
  ensureBuiltInMembershipTypes,
  isSubscriptionNotRequiredForMembershipType,
  membershipTypeAgeExemption,
  membershipTypeForcedEditOffendingTiers,
  normalizeMembershipTypeAgeTiers,
  normalizeMembershipTypeKey,
  validateMembershipTypeRuleConfiguration,
} from "@/lib/membership-types";
import { ROLE_VALUES } from "@/lib/member-roles";

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function makeDb() {
  return {
    membershipType: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL" },
        { id: "type-associate", key: "ASSOCIATE" },
        { id: "type-life", key: "LIFE" },
        { id: "type-school", key: "SCHOOL" },
        { id: "type-non-member", key: "NON_MEMBER" },
        { id: "type-family", key: "FAMILY" },
        { id: "type-admin", key: "ADMIN" },
        { id: "type-lodge", key: "LODGE" },
      ]),
    },
    membershipTypeAgeTier: {
      createMany: vi.fn().mockResolvedValue({ count: 17 }),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        { id: "member-1", role: "USER" },
        { id: "admin-1", role: "ADMIN" },
        { id: "lodge-1", role: "LODGE" },
        { id: "associate-1", role: "ASSOCIATE" },
        { id: "life-1", role: "LIFE" },
        { id: "school-1", role: "SCHOOL" },
        { id: "non-member-1", role: "NON_MEMBER" },
      ]),
    },
    seasonalMembershipAssignment: {
      createMany: vi.fn().mockResolvedValue({ count: 7 }),
    },
  };
}

describe("seasonal membership type schema contract", () => {
  it("keeps durable membership types separate from the access-role enum", () => {
    const schema = readRepoFile("prisma/schema.prisma");

    expect(schema).toContain("enum MembershipTypeBookingBehavior");
    expect(schema).toContain("MEMBER_RATE");
    expect(schema).toContain("NON_MEMBER_RATE");
    expect(schema).toContain("BLOCK_BOOKING");
    expect(schema).toContain("enum MembershipTypeSubscriptionBehavior");
    expect(schema).toContain("model MembershipType");
    expect(schema).toContain("key                  String");
    expect(schema).toContain("model SeasonalMembershipAssignment");
    expect(schema).toContain("applyFrom          DateTime?                  @db.Date");
    expect(schema).toContain("model MembershipTypeAgeTier");
    expect(schema).toContain("model XeroContactGroupRule");
    expect(schema).toContain("@@unique([memberId, seasonYear])");
    expect(ROLE_VALUES).toEqual([
      "USER",
      "ADMIN",
      "LODGE",
      "NON_MEMBER",
      "SCHOOL",
    ]);
    expect(ROLE_VALUES).not.toContain("COMMITTEE");
  });

  it("documents an expand-safe migration with built-in seeding and idempotent backfill", () => {
    const migration = readRepoFile(
      "prisma/migrations/20260628170000_add_seasonal_membership_types/migration.sql",
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "MembershipType"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "SeasonalMembershipAssignment"',
    );
    expect(migration).toContain("ON CONFLICT (\"key\") DO UPDATE");
    expect(migration).toContain(
      'ON CONFLICT ("memberId", "seasonYear") DO NOTHING',
    );
    expect(migration).toContain("WHEN 'ASSOCIATE' THEN 'ASSOCIATE'");
    expect(migration).toContain("WHEN 'LIFE' THEN 'LIFE'");
    expect(migration).not.toContain("COMMITTEE");
  });
});

describe("built-in membership type seed helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates required built-ins idempotently", async () => {
    const db = makeDb();

    await ensureBuiltInMembershipTypes(db);
    await ensureBuiltInMembershipTypes(db);

    expect(db.membershipType.upsert).toHaveBeenCalledTimes(
      BUILT_IN_MEMBERSHIP_TYPES.length * 2,
    );
    for (const type of BUILT_IN_MEMBERSHIP_TYPES) {
      expect(db.membershipType.upsert).toHaveBeenCalledWith({
        where: { key: type.key },
        update: {},
        create: expect.objectContaining({
          key: type.key,
          name: type.name,
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: type.bookingBehavior,
          subscriptionBehavior: type.subscriptionBehavior,
        }),
      });
    }
    expect(BUILT_IN_MEMBERSHIP_TYPES.map((type) => type.key)).toEqual([
      "FULL",
      "ASSOCIATE",
      "LIFE",
      "SCHOOL",
      "NON_MEMBER",
      "FAMILY",
      // #2149: operational fallback types so the dropped role-based subscription
      // exemption has DB-backed NOT_REQUIRED types for bare ADMIN/LODGE accounts.
      "ADMIN",
      "LODGE",
    ]);
    expect(BUILT_IN_MEMBERSHIP_TYPES.map((type) => type.key)).not.toContain(
      "RESERVE",
    );
    expect(db.membershipTypeAgeTier.createMany).toHaveBeenCalledTimes(2);
  });

  it("maps existing roles to current-season membership assignments without overwriting", async () => {
    const db = makeDb();

    const result = await backfillCurrentSeasonMembershipAssignments(db, 2026);

    expect(result).toEqual({ createdCount: 7, seasonYear: 2026 });
    expect(db.seasonalMembershipAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { memberId: "member-1", seasonYear: 2026, membershipTypeId: "type-full" },
        // #2149: bare ADMIN/LODGE accounts now default to their own operational
        // NOT_REQUIRED types rather than the billable FULL type.
        { memberId: "admin-1", seasonYear: 2026, membershipTypeId: "type-admin" },
        { memberId: "lodge-1", seasonYear: 2026, membershipTypeId: "type-lodge" },
        {
          memberId: "associate-1",
          seasonYear: 2026,
          membershipTypeId: "type-associate",
        },
        { memberId: "life-1", seasonYear: 2026, membershipTypeId: "type-life" },
        {
          memberId: "school-1",
          seasonYear: 2026,
          membershipTypeId: "type-school",
        },
        {
          memberId: "non-member-1",
          seasonYear: 2026,
          membershipTypeId: "type-non-member",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("keeps role-to-type defaults separate from access role semantics", () => {
    expect(defaultMembershipTypeKeyForRole("USER")).toBe("FULL");
    expect(defaultMembershipTypeKeyForRole("MEMBER")).toBe("FULL");
    // #2149: operational roles fall back to their own NOT_REQUIRED types.
    expect(defaultMembershipTypeKeyForRole("ADMIN")).toBe("ADMIN");
    expect(defaultMembershipTypeKeyForRole("LODGE")).toBe("LODGE");
    expect(defaultMembershipTypeKeyForRole("ASSOCIATE")).toBe("ASSOCIATE");
    expect(defaultMembershipTypeKeyForRole("RESERVE")).toBe("ASSOCIATE");
    expect(defaultMembershipTypeKeyForRole("LIFE")).toBe("LIFE");
    expect(defaultMembershipTypeKeyForRole("SCHOOL")).toBe("SCHOOL");
    expect(defaultMembershipTypeKeyForRole("NON_MEMBER")).toBe("NON_MEMBER");
    expect(canonicalMembershipTypeKey("RESERVE")).toBe("ASSOCIATE");
  });

  describe("shared subscription-required derivation (#2149)", () => {
    const noExemptTiers = new Set<string>();

    it("resolves the effective behaviour from the assignment, else the role default", () => {
      // Assignment wins.
      expect(effectiveSubscriptionBehavior("REQUIRED", "ADMIN")).toBe("REQUIRED");
      // No assignment: operational roles fall back to their NOT_REQUIRED types.
      expect(effectiveSubscriptionBehavior(null, "ADMIN")).toBe("NOT_REQUIRED");
      expect(effectiveSubscriptionBehavior(undefined, "LODGE")).toBe("NOT_REQUIRED");
      expect(effectiveSubscriptionBehavior(null, "SCHOOL")).toBe("NOT_REQUIRED");
      expect(effectiveSubscriptionBehavior(null, "NON_MEMBER")).toBe("NOT_REQUIRED");
      // Ordinary members fall back to FULL (billable).
      expect(effectiveSubscriptionBehavior(null, "USER")).toBe("REQUIRED");
    });

    it("treats a fee-paying admin (REQUIRED assignment) as owing", () => {
      expect(
        isSubscriptionNotRequiredForMembershipType({
          subscriptionBehavior: effectiveSubscriptionBehavior("REQUIRED", "ADMIN"),
          ageTier: "ADULT",
          notRequiredAgeTiers: noExemptTiers,
          hasNotRequiredSeasonRow: false,
        }),
      ).toBe(false);
    });

    it("treats a bare ADMIN/LODGE account (no assignment) as not required", () => {
      for (const role of ["ADMIN", "LODGE"] as const) {
        expect(
          isSubscriptionNotRequiredForMembershipType({
            subscriptionBehavior: effectiveSubscriptionBehavior(null, role),
            ageTier: "ADULT",
            notRequiredAgeTiers: noExemptTiers,
            hasNotRequiredSeasonRow: false,
          }),
        ).toBe(true);
      }
    });

    it("exempts an age-tier-exempt member regardless of type, and honours a BASED_ON_AGE_TIER NOT_REQUIRED row", () => {
      // Age-tier exemption applies even to a REQUIRED type.
      expect(
        isSubscriptionNotRequiredForMembershipType({
          subscriptionBehavior: "REQUIRED",
          ageTier: "CHILD",
          notRequiredAgeTiers: new Set(["CHILD"]),
          hasNotRequiredSeasonRow: false,
        }),
      ).toBe(true);
      // BASED_ON_AGE_TIER + NOT_REQUIRED row dominates a promoted stored tier.
      expect(
        isSubscriptionNotRequiredForMembershipType({
          subscriptionBehavior: "BASED_ON_AGE_TIER",
          ageTier: "YOUTH",
          notRequiredAgeTiers: noExemptTiers,
          hasNotRequiredSeasonRow: true,
        }),
      ).toBe(true);
      // BASED_ON_AGE_TIER without a row defers to the tier (here liable).
      expect(
        isSubscriptionNotRequiredForMembershipType({
          subscriptionBehavior: "BASED_ON_AGE_TIER",
          ageTier: "YOUTH",
          notRequiredAgeTiers: noExemptTiers,
          hasNotRequiredSeasonRow: false,
        }),
      ).toBe(false);
    });
  });

  it("derives stable custom keys without relying on display words for policy", () => {
    expect(normalizeMembershipTypeKey(" Social member ")).toBe("SOCIAL_MEMBER");
    expect(normalizeMembershipTypeKey("")).toBe("CUSTOM");
  });

  it("validates age-tier eligibility (Xero grouping moved to the grouping surface, #1934)", () => {
    expect(
      validateMembershipTypeRuleConfiguration({ allowedAgeTiers: [] }),
    ).toBe("Select at least one allowed age tier.");

    expect(
      validateMembershipTypeRuleConfiguration({ allowedAgeTiers: ["YOUTH", "ADULT"] }),
    ).toBeNull();
  });

  it("offers N/A (no age) as a selectable tier but keeps it out of the new-type default (#2069)", () => {
    // N/A is selectable and sorts last...
    expect(MEMBERSHIP_TYPE_AGE_TIERS).toEqual([
      "INFANT",
      "CHILD",
      "YOUTH",
      "ADULT",
      "NOT_APPLICABLE",
    ]);
    // ...but the omitted-input default is the four real age tiers only.
    expect(DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS).toEqual([
      "INFANT",
      "CHILD",
      "YOUTH",
      "ADULT",
    ]);
  });

  it("normalizes an N/A-only selection and treats it as a valid configuration (#2069)", () => {
    expect(normalizeMembershipTypeAgeTiers(["NOT_APPLICABLE"])).toEqual([
      "NOT_APPLICABLE",
    ]);
    // N/A sorts after real tiers regardless of input order.
    expect(
      normalizeMembershipTypeAgeTiers(["NOT_APPLICABLE", "ADULT"]),
    ).toEqual(["ADULT", "NOT_APPLICABLE"]);
    expect(
      validateMembershipTypeRuleConfiguration({
        allowedAgeTiers: ["NOT_APPLICABLE"],
      }),
    ).toBeNull();
  });
});

describe("#2106 — membershipTypeAgeExemption classification", () => {
  it("classifies an N/A-only set as FORCED", () => {
    expect(membershipTypeAgeExemption(["NOT_APPLICABLE"])).toBe("FORCED");
  });

  it("classifies N/A alongside person tiers as ALLOWED", () => {
    expect(membershipTypeAgeExemption(["ADULT", "NOT_APPLICABLE"])).toBe(
      "ALLOWED",
    );
    expect(
      membershipTypeAgeExemption(["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"]),
    ).toBe("ALLOWED");
  });

  it("classifies a person-only set (or an empty/undefined set) as DISALLOWED", () => {
    expect(membershipTypeAgeExemption(["INFANT", "CHILD", "YOUTH", "ADULT"])).toBe(
      "DISALLOWED",
    );
    expect(membershipTypeAgeExemption([])).toBe("DISALLOWED");
    expect(membershipTypeAgeExemption(undefined)).toBe("DISALLOWED");
  });
});

describe("#2106 — subscription-behaviour restriction on age-exempt config", () => {
  it("rejects N/A in the allowed tiers when subscription behaviour is not NOT_REQUIRED", () => {
    expect(
      validateMembershipTypeRuleConfiguration({
        allowedAgeTiers: ["NOT_APPLICABLE"],
        subscriptionBehavior: "REQUIRED",
      }),
    ).toMatch(/not required/i);
    expect(
      validateMembershipTypeRuleConfiguration({
        allowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
        subscriptionBehavior: "BASED_ON_AGE_TIER",
      }),
    ).toMatch(/not required/i);
  });

  it("accepts N/A when subscription behaviour is NOT_REQUIRED", () => {
    expect(
      validateMembershipTypeRuleConfiguration({
        allowedAgeTiers: ["NOT_APPLICABLE"],
        subscriptionBehavior: "NOT_REQUIRED",
      }),
    ).toBeNull();
  });

  it("does not gate person-only sets on subscription behaviour", () => {
    expect(
      validateMembershipTypeRuleConfiguration({
        allowedAgeTiers: ["ADULT"],
        subscriptionBehavior: "REQUIRED",
      }),
    ).toBeNull();
  });
});

describe("#2106 — allowed-tiers edit stranding guard", () => {
  it("blocks becoming FORCED while a person-tier member is assigned", () => {
    const offending = membershipTypeForcedEditOffendingTiers({
      previousAllowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
      nextAllowedAgeTiers: ["NOT_APPLICABLE"],
      affectedMembers: [
        { ageTier: "ADULT", isOrganisation: false },
        { ageTier: "NOT_APPLICABLE", isOrganisation: false },
      ],
    });
    expect(offending).toEqual(["ADULT"]);
  });

  it("blocks leaving FORCED (dropping N/A) while a non-org N/A member is assigned", () => {
    const offending = membershipTypeForcedEditOffendingTiers({
      previousAllowedAgeTiers: ["NOT_APPLICABLE"],
      nextAllowedAgeTiers: ["ADULT"],
      affectedMembers: [{ ageTier: "NOT_APPLICABLE", isOrganisation: false }],
    });
    expect(offending).toEqual(["NOT_APPLICABLE"]);
  });

  it("allows a FORCED transition when every affected member is covered", () => {
    expect(
      membershipTypeForcedEditOffendingTiers({
        previousAllowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
        nextAllowedAgeTiers: ["NOT_APPLICABLE"],
        affectedMembers: [{ ageTier: "NOT_APPLICABLE", isOrganisation: false }],
      }),
    ).toEqual([]);
  });

  it("allows FORCED -> ALLOWED (N/A retained), stranding nobody", () => {
    expect(
      membershipTypeForcedEditOffendingTiers({
        previousAllowedAgeTiers: ["NOT_APPLICABLE"],
        nextAllowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
        affectedMembers: [{ ageTier: "NOT_APPLICABLE", isOrganisation: false }],
      }),
    ).toEqual([]);
  });

  // MAJOR-1(b): ALLOWED -> DISALLOWED (removing N/A) now strands non-org N/A
  // holders — this guard is no longer limited to FORCED transitions.
  it("blocks ALLOWED -> DISALLOWED while a non-org N/A member is assigned", () => {
    expect(
      membershipTypeForcedEditOffendingTiers({
        previousAllowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
        nextAllowedAgeTiers: ["ADULT"],
        affectedMembers: [{ ageTier: "NOT_APPLICABLE", isOrganisation: false }],
      }),
    ).toEqual(["NOT_APPLICABLE"]);
  });

  it("exempts org members from the N/A-removal block (global org force keeps them N/A)", () => {
    expect(
      membershipTypeForcedEditOffendingTiers({
        previousAllowedAgeTiers: ["ADULT", "NOT_APPLICABLE"],
        nextAllowedAgeTiers: ["ADULT"],
        affectedMembers: [
          { ageTier: "NOT_APPLICABLE", isOrganisation: true },
          { ageTier: "ADULT", isOrganisation: false },
        ],
      }),
    ).toEqual([]);
  });

  it("ignores an ordinary person-tier narrowing that neither creates FORCED nor removes N/A", () => {
    expect(
      membershipTypeForcedEditOffendingTiers({
        previousAllowedAgeTiers: ["YOUTH", "ADULT"],
        nextAllowedAgeTiers: ["ADULT"],
        affectedMembers: [{ ageTier: "YOUTH", isOrganisation: false }],
      }),
    ).toEqual([]);
  });
});
