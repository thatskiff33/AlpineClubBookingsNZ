/**
 * Tests for Issue 13 & 14: Age tier boundaries and configurable settings
 */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeAgeTierWithSettings,
  AGE_TIER_DEFAULTS,
  getSeasonStartDate,
  computeAge,
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
  validateAgeTierPartition,
  type AgeTierSettingData,
} from "../age-tier";
import type { AgeTier } from "@prisma/client";

// ---------------------------------------------------------------------------
// computeAgeTierWithSettings unit tests
// ---------------------------------------------------------------------------

describe("computeAgeTierWithSettings — TAC default boundaries", () => {
  const ref2026 = getSeasonStartDate(2026); // April 1, 2026

  it("INFANT: age 0-4", () => {
    // Newborn-ish
    expect(
      computeAgeTierWithSettings(new Date("2025-06-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    // Age 4 exactly
    expect(
      computeAgeTierWithSettings(new Date("2021-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
  });

  it("CHILD: age 5-9", () => {
    // Age 5 exactly
    expect(
      computeAgeTierWithSettings(new Date("2021-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
    // Age 9 exactly
    expect(
      computeAgeTierWithSettings(new Date("2016-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("YOUTH: age 10-17", () => {
    // Exactly 10
    expect(
      computeAgeTierWithSettings(new Date("2016-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
    // Age 17 (day before 18th birthday)
    expect(
      computeAgeTierWithSettings(new Date("2008-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("ADULT: age 18+", () => {
    // Exactly 18
    expect(
      computeAgeTierWithSettings(new Date("2008-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
    // Age 40
    expect(
      computeAgeTierWithSettings(new Date("1985-01-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
  });

  it("sets default booking subscription requirement per tier", () => {
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "INFANT")
        ?.subscriptionRequiredForBooking
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "CHILD")
        ?.subscriptionRequiredForBooking
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "YOUTH")
        ?.subscriptionRequiredForBooking
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "ADULT")
        ?.subscriptionRequiredForBooking
    ).toBe(true);
  });

  it("sets default family request member creation policy per tier", () => {
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "INFANT")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "CHILD")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "YOUTH")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "ADULT")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(false);
  });
});

describe("computeAgeTierWithSettings — custom settings", () => {
  const ref = new Date("2026-04-01");

  it("respects custom boundaries", () => {
    const custom: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 12, label: "Child (under 13)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth (13-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
    ];
    // Age 11 on April 1 2026 (Malia DOB 2014-08-28)
    expect(
      computeAgeTierWithSettings(new Date("2014-08-28"), ref, custom)
    ).toBe("CHILD"); // under 13 with old boundaries
  });

  it("falls back to ADULT if no range matches", () => {
    // Weird settings missing ranges — shouldn't happen in prod but defensive
    const weirdSettings: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 5, label: "Child", sortOrder: 1 },
      // gap: 6-17 not covered
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 2 },
    ];
    // Age 10 -> not matched by CHILD (max 5) and not matched by ADULT (min 18)
    // falls back to ADULT
    expect(
      computeAgeTierWithSettings(new Date("2016-01-01"), ref, weirdSettings)
    ).toBe("ADULT");
  });
});

// ---------------------------------------------------------------------------
// Season start date reference (Issue 13 core fix)
// ---------------------------------------------------------------------------

describe("Season start date as reference", () => {
  it("April 1 of season year is used for classification", () => {
    const maliaDOB = new Date("2014-08-28");
    // On April 1 2026 she is 11 (turns 12 in August)
    expect(computeAge(maliaDOB, getSeasonStartDate(2026))).toBe(11);
    expect(
      computeAgeTierWithSettings(maliaDOB, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("someone turning 10 on March 31 is YOUTH for that season", () => {
    // Born March 31 2016: on April 1 2026 they are already 10 (birthday was yesterday)
    const dob = new Date("2016-03-31");
    expect(computeAge(dob, getSeasonStartDate(2026))).toBe(10);
    expect(
      computeAgeTierWithSettings(dob, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("someone born April 2 is still CHILD on April 1 of the 10th-birthday year", () => {
    // Born April 2 2016: on April 1 2026 they are 9 (turns 10 the next day)
    const dob = new Date("2016-04-02");
    expect(computeAge(dob, getSeasonStartDate(2026))).toBe(9);
    expect(
      computeAgeTierWithSettings(dob, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("getSeasonStartDate returns April 1 for any season year", () => {
    [2024, 2025, 2026, 2027].forEach((year) => {
      const d = getSeasonStartDate(year);
      expect(d.getFullYear()).toBe(year);
      expect(d.getMonth()).toBe(3); // April
      expect(d.getDate()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

describe("invalidateAgeTierCache", () => {
  it("can be called without error", () => {
    expect(() => invalidateAgeTierCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getAgeTierSettings fallback
// ---------------------------------------------------------------------------

describe("getAgeTierSettings fallback", () => {
  beforeEach(() => {
    invalidateAgeTierCache();
    vi.resetModules();
  });

  it("falls back to AGE_TIER_DEFAULTS when DB is unavailable", async () => {
    // Mock prisma to throw
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockRejectedValue(new Error("DB unavailable")),
        },
      },
    }));

    const { getAgeTierSettings, AGE_TIER_DEFAULTS: defaults } = await import("../age-tier");
    const result = await getAgeTierSettings();
    expect(result).toEqual(defaults);
  });

  it("selects ONLY the consumed columns, never the dropped xeroContactGroup* columns (#2130)", async () => {
    // Blue/green safety pin: the deployed client stopped naming
    // AgeTierSetting.xeroContactGroupId / xeroContactGroupName in generated SQL
    // one release BEFORE the #2130 STEP 2 contract migration
    // 20260721130000_contract_drop_ismember_and_agetier_xero_columns dropped
    // them, which is what made that drop legal. The columns are gone now, so a
    // no-select findMany would be a hard 42703; the pin stays to stop someone
    // removing the explicit select and reintroducing one. Inspects the mock
    // call args.
    const findMany = vi.fn().mockResolvedValue([
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 4,
        label: "Infant (under 5)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 5,
        maxAge: 9,
        label: "Child (5-9)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 10,
        maxAge: 17,
        label: "Youth (10-17)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 3,
      },
    ]);
    vi.doMock("../prisma", () => ({
      prisma: { ageTierSetting: { findMany } },
    }));

    const { getAgeTierSettings } = await import("../age-tier");
    await getAgeTierSettings();

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as { select?: Record<string, unknown> };
    expect(args.select).toEqual({
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: true,
    });
    expect(args.select).not.toHaveProperty("xeroContactGroupId");
    expect(args.select).not.toHaveProperty("xeroContactGroupName");
  });

  it("normalizes the legacy 3-tier DB rows to the INFANT-aware defaults", async () => {
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockResolvedValue([
            { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
            { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
            { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
          ]),
        },
      },
    }));

    const { getAgeTierSettings, AGE_TIER_DEFAULTS: defaults } = await import("../age-tier");
    const result = await getAgeTierSettings();
    expect(result).toEqual(defaults);
  });
});

// ---------------------------------------------------------------------------
// Hard-coded default net (#1983): DB is the sole runtime source; AGE_TIER_DEFAULTS
// no longer derives from config/club.json. Pin the exact array so the fallback
// can never silently drift with an edited/absent config file.
// ---------------------------------------------------------------------------

describe("AGE_TIER_DEFAULTS — hard-coded 4-tier TAC shape (config-independent)", () => {
  it("equals the post-20260412190000 / club.example.json TAC default, byte-for-byte", () => {
    expect(AGE_TIER_DEFAULTS).toEqual([
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 4,
        label: "Infant (under 5)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 5,
        maxAge: 9,
        label: "Child (5-9)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 10,
        maxAge: 17,
        label: "Youth (10-17)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 3,
      },
    ]);
  });

  it("equals the tiers config/club.example.json resolves (byte-for-byte, catches drift in the canonical repo)", () => {
    // The demotion is only safe if the hard-coded net matches what the CANONICAL
    // config/club.example.json ageTiers resolve to (the seed contract). Pin the
    // assertion to the example file EXPLICITLY — not the effective `clubConfig`
    // singleton — so a fork booting a valid custom config/club.json never gets a
    // false CI failure, while the canonical repo still fails loudly if
    // club.example.json ageTiers ever drift from the hard-coded default.
    const examplePath = path.join(process.cwd(), "config", "club.example.json");
    const exampleConfig = JSON.parse(
      fs.readFileSync(examplePath, "utf8"),
    ) as {
      ageTiers: Array<{
        id: string;
        minAge: number;
        maxAge: number | null;
        label: string;
        subscriptionRequiredForBooking: boolean;
        familyGroupRequestCreateMemberAllowed: boolean;
      }>;
    };
    const exampleDerived = exampleConfig.ageTiers.map((tier, sortOrder) => ({
      tier: tier.id,
      minAge: tier.minAge,
      maxAge: tier.maxAge,
      label: tier.label,
      subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed:
        tier.familyGroupRequestCreateMemberAllowed,
      sortOrder,
    }));
    expect(AGE_TIER_DEFAULTS).toEqual(exampleDerived);
  });

  it("resolves an EMPTY table to the hard-coded default (no config dependency)", () => {
    // An empty AgeTierSetting table (fresh fork before self-heal / seed) must
    // still yield valid tiers so age classification never breaks.
    expect(normalizeAgeTierSettings([])).toEqual(AGE_TIER_DEFAULTS);
  });
});

describe("normalizeAgeTierSettings — populated non-legacy table is byte-identical", () => {
  // The exact tokoroa/TAC-shaped rows a migrated DB holds after
  // 20260412190000. Resolution must return them untouched (no fallback) so
  // pricing is byte-identical before/after the config-fallback removal.
  const postMigrationRows: AgeTierSettingData[] = [
    {
      tier: "INFANT",
      minAge: 0,
      maxAge: 4,
      label: "Infant (under 5)",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 0,
    },
    {
      tier: "CHILD",
      minAge: 5,
      maxAge: 9,
      label: "Child (5-9)",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 1,
    },
    {
      tier: "YOUTH",
      minAge: 10,
      maxAge: 17,
      label: "Youth (10-17)",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 2,
    },
    {
      tier: "ADULT",
      minAge: 18,
      maxAge: null,
      label: "Adult (18+)",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 3,
    },
  ];

  it("returns the DB rows unchanged (not the fallback)", () => {
    expect(normalizeAgeTierSettings(postMigrationRows)).toEqual(postMigrationRows);
  });

  it("a migrated 4-tier DB does NOT match the legacy shape (CHILD is 5-9, not 0-9)", () => {
    // The legacy-3-tier trap: because the migration shifts CHILD to 5-9 and adds
    // INFANT, a migrated DB can never re-enter the legacy fallback branch. Prove
    // it by confirming the rows survive normalization identically.
    const normalized = normalizeAgeTierSettings(postMigrationRows);
    expect(normalized.find((t) => t.tier === "CHILD")?.minAge).toBe(5);
    expect(normalized).not.toBe(AGE_TIER_DEFAULTS); // distinct array (clone)
    expect(normalized).toEqual(postMigrationRows);
  });
});

describe("normalizeAgeTierSettings", () => {
  it("legacy 3-tier DB resolves to the post-20260412190000 TAC values (no silent pricing change)", () => {
    // A genuinely-unmigrated DB in the legacy shape (CHILD 0-9 / YOUTH / ADULT)
    // falls back to the hard-coded default, which equals exactly what the
    // 20260412190000 backfill would have written: INFANT 0-4, CHILD 5-9,
    // YOUTH 10-17, ADULT 18+.
    const legacyRows: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
    ];

    const resolved = normalizeAgeTierSettings(legacyRows);
    expect(resolved).toEqual([
      { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 3 },
    ]);
  });

  it("rewrites the legacy 3-tier settings to the default 4-tier layout", () => {
    const legacyRows: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
    ];

    expect(normalizeAgeTierSettings(legacyRows)).toEqual(AGE_TIER_DEFAULTS);
  });

  it("preserves custom 4-tier settings", () => {
    const customRows: AgeTierSettingData[] = [
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 2,
        label: "Baby (0-2)",
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 3,
        maxAge: 12,
        label: "Child (3-12)",
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 17,
        label: "Teen (13-17)",
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        sortOrder: 3,
      },
    ];

    expect(normalizeAgeTierSettings(customRows)).toEqual(
      customRows.map((row) => ({
        ...row,
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
      }))
    );
  });

  it("preserves explicit family request member creation settings", () => {
    const customRows: AgeTierSettingData[] = [
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 4,
        label: "Infant",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 5,
        maxAge: 9,
        label: "Child",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 1,
      },
    ];

    expect(normalizeAgeTierSettings(customRows)).toEqual(customRows);
  });
});

// ---------------------------------------------------------------------------
// Admin API validation logic (unit-testable business rules)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue #2009 — age-tier SUBSET validity rule (validateAgeTierPartition)
// ---------------------------------------------------------------------------

describe("validateAgeTierPartition — subset validity rule (#2009)", () => {
  type Row = { tier: AgeTier; minAge: number; maxAge: number | null };
  const row = (tier: AgeTier, minAge: number, maxAge: number | null): Row => ({
    tier,
    minAge,
    maxAge,
  });

  describe("accepted sets", () => {
    it("accepts the canonical four-tier TAC install and returns age-ascending order", () => {
      const input: Row[] = [
        row("INFANT", 0, 4),
        row("CHILD", 5, 9),
        row("YOUTH", 10, 17),
        row("ADULT", 18, null),
      ];
      const result = validateAgeTierPartition(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sorted.map((r) => r.tier)).toEqual([
          "INFANT",
          "CHILD",
          "YOUTH",
          "ADULT",
        ]);
      }
    });

    it("accepts CHILD 0-17 + ADULT 18+ (skips INFANT and YOUTH)", () => {
      expect(
        validateAgeTierPartition([row("CHILD", 0, 17), row("ADULT", 18, null)])
          .ok,
      ).toBe(true);
    });

    it("accepts INFANT 0-4 + ADULT 5+", () => {
      expect(
        validateAgeTierPartition([row("INFANT", 0, 4), row("ADULT", 5, null)])
          .ok,
      ).toBe(true);
    });

    it("accepts ADULT-only starting at 0", () => {
      expect(validateAgeTierPartition([row("ADULT", 0, null)]).ok).toBe(true);
    });

    it("accepts YOUTH 0-17 + ADULT 18+", () => {
      expect(
        validateAgeTierPartition([row("YOUTH", 0, 17), row("ADULT", 18, null)])
          .ok,
      ).toBe(true);
    });

    it("accepts rows given out of age order and sorts them ascending", () => {
      const result = validateAgeTierPartition([
        row("ADULT", 18, null),
        row("CHILD", 0, 17),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sorted.map((r) => r.tier)).toEqual(["CHILD", "ADULT"]);
      }
    });
  });

  describe("rejected sets", () => {
    const expectRejected = (rows: Row[], match: RegExp) => {
      const result = validateAgeTierPartition(rows);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(match);
    };

    it("rejects an empty set", () => {
      expectRejected([], /at least one age tier/i);
    });

    it("rejects a set without ADULT", () => {
      expectRejected(
        [row("CHILD", 0, 9), row("YOUTH", 10, 17)],
        /must include the ADULT tier/i,
      );
    });

    it("rejects a duplicate tier slot", () => {
      expectRejected(
        [row("ADULT", 0, null), row("ADULT", 0, null)],
        /at most once/i,
      );
    });

    it("rejects NOT_APPLICABLE in the partition (defense-in-depth)", () => {
      expectRejected(
        [row("NOT_APPLICABLE", 0, 17), row("ADULT", 18, null)],
        /N\/A age tier is not part of the bookable age partition/i,
      );
    });

    it("rejects a non-ADULT tier with no upper limit", () => {
      expectRejected(
        [row("CHILD", 0, null), row("ADULT", 5, null)],
        /Only the ADULT tier can have no upper age limit/i,
      );
    });

    it("rejects a bounded ADULT (ADULT must be the terminal catch-all)", () => {
      expectRejected(
        [row("INFANT", 0, 4), row("ADULT", 5, 10)],
        /ADULT tier must have no upper age limit/i,
      );
    });

    it("rejects a youngest tier that does not start at age 0", () => {
      expectRejected(
        [row("CHILD", 5, 9), row("ADULT", 10, null)],
        /must start at age 0/i,
      );
    });

    it("rejects a gap between tiers", () => {
      expectRejected(
        [row("CHILD", 0, 8), row("ADULT", 10, null)],
        /contiguous/i,
      );
    });

    it("rejects an overlap between tiers", () => {
      expectRejected(
        [row("CHILD", 0, 10), row("ADULT", 10, null)],
        /contiguous/i,
      );
    });
  });
});

describe("computeAgeTierWithSettings — 2-tier subset club (#2009)", () => {
  const ref = getSeasonStartDate(2026); // April 1, 2026
  // CHILD 0-17 + ADULT 18+.
  const subset: AgeTierSettingData[] = [
    { tier: "CHILD", minAge: 0, maxAge: 17, label: "Child (0-17)", sortOrder: 0 },
    { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 1 },
  ];

  it("classifies a newborn into the youngest present tier (CHILD)", () => {
    expect(computeAgeTierWithSettings(new Date("2026-01-01"), ref, subset)).toBe(
      "CHILD",
    );
  });

  it("classifies age 17 (day before 18th birthday) as CHILD", () => {
    expect(computeAgeTierWithSettings(new Date("2008-04-02"), ref, subset)).toBe(
      "CHILD",
    );
  });

  it("classifies age 18 exactly as ADULT", () => {
    expect(computeAgeTierWithSettings(new Date("2008-04-01"), ref, subset)).toBe(
      "ADULT",
    );
  });
});

describe("normalizeAgeTierSettings — deliberate subsets are NOT treated as legacy/empty (#2009)", () => {
  it("passes a 2-tier CHILD+ADULT subset through untouched", () => {
    const subset: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 17, label: "Child (0-17)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
    ];
    expect(normalizeAgeTierSettings(subset)).toEqual(subset);
  });

  it("passes a deliberate 3-tier CHILD/YOUTH/ADULT subset with 0-based sortOrder through untouched (not the legacy 1/2/3 shape)", () => {
    // The relaxed save route re-indexes sortOrder to 0..n-1, so a modern subset
    // never collides with the legacy-3-tier auto-migration shape (pinned to
    // sortOrder 1/2/3). This 0-based CHILD 0-9 / YOUTH / ADULT set must survive
    // normalization intact rather than being rewritten to the 4-tier default.
    const subset: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (0-9)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2 },
    ];
    const result = normalizeAgeTierSettings(subset);
    expect(result).toEqual(subset);
    expect(result.map((r) => r.tier)).toEqual(["CHILD", "YOUTH", "ADULT"]);
  });
});

describe("Age tier contiguity validation rules", () => {
  it("recognises a gap between tiers as invalid", () => {
    // Simulates the validation: minAge of next must equal maxAge of current + 1
    const sorted = [
      { tier: "CHILD", minAge: 0, maxAge: 8 },
      { tier: "YOUTH", minAge: 10, maxAge: 17 }, // gap: 9 is uncovered
      { tier: "ADULT", minAge: 18, maxAge: null },
    ];
    let hasGap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const nxt = sorted[i + 1];
      if (cur.maxAge !== null && cur.maxAge + 1 !== nxt.minAge) {
        hasGap = true;
        break;
      }
    }
    expect(hasGap).toBe(true);
  });

  it("recognises contiguous tiers as valid", () => {
    const sorted = [
      { tier: "CHILD", minAge: 0, maxAge: 9 },
      { tier: "YOUTH", minAge: 10, maxAge: 17 },
      { tier: "ADULT", minAge: 18, maxAge: null },
    ];
    let hasGap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const nxt = sorted[i + 1];
      if (cur.maxAge !== null && cur.maxAge + 1 !== nxt.minAge) {
        hasGap = true;
        break;
      }
    }
    expect(hasGap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAgeTierSettingsStrict — the EVIDENCE reader (#2376)
// ---------------------------------------------------------------------------

describe("getAgeTierSettingsStrict", () => {
  beforeEach(() => {
    invalidateAgeTierCache();
    vi.resetModules();
  });

  it("PROPAGATES a failed read instead of returning the defaults", async () => {
    // The whole reason it exists. `getAgeTierSettings` above answers a failed read
    // with `AGE_TIER_DEFAULTS`, which is right for a booking screen and wrong for
    // evidence: AI Diagnostics reports whether a member's tier owes a season
    // subscription, and on a cold cache a transient failure would make the DEFAULT
    // rule look like the club's own configured one — a confident, wrong, actionable
    // finding with a fresh observed-at beside it.
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockRejectedValue(new Error("DB unavailable")),
        },
      },
    }));
    const { getAgeTierSettingsStrict } = await import("../age-tier");
    await expect(getAgeTierSettingsStrict()).rejects.toThrow("DB unavailable");
  });

  it("returns the documented defaults for a genuinely EMPTY table", async () => {
    // The other half of the distinction, and it is not a fallback: a club that has
    // configured no tiers is governed by the platform's documented defaults, so
    // reporting them is an observation.
    vi.doMock("../prisma", () => ({
      prisma: { ageTierSetting: { findMany: vi.fn().mockResolvedValue([]) } },
    }));
    const { getAgeTierSettingsStrict, AGE_TIER_DEFAULTS: defaults } = await import(
      "../age-tier"
    );
    await expect(getAgeTierSettingsStrict()).resolves.toEqual(defaults);
  });

  it("returns the club's OWN stored rule when there is one", async () => {
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockResolvedValue([
            {
              tier: "CHILD",
              minAge: 0,
              maxAge: 17,
              label: "Child",
              subscriptionRequiredForBooking: false,
              familyGroupRequestCreateMemberAllowed: false,
              sortOrder: 1,
            },
            {
              tier: "ADULT",
              minAge: 18,
              maxAge: null,
              label: "Adult",
              subscriptionRequiredForBooking: true,
              familyGroupRequestCreateMemberAllowed: true,
              sortOrder: 2,
            },
          ]),
        },
      },
    }));
    const { getAgeTierSettingsStrict } = await import("../age-tier");
    const result = await getAgeTierSettingsStrict();
    expect(result.map((row) => row.tier)).toEqual(["CHILD", "ADULT"]);
    expect(
      result.find((row) => row.tier === "CHILD")?.subscriptionRequiredForBooking,
    ).toBe(false);
  });

  it("neither reads nor writes the shared five-minute cache", async () => {
    // Not reading it stops a five-minute-old row being reported as freshly
    // observed; not writing it stops a diagnostics read changing what every other
    // request in the process computes.
    const findMany = vi.fn().mockResolvedValue([]);
    vi.doMock("../prisma", () => ({ prisma: { ageTierSetting: { findMany } } }));
    const { getAgeTierSettingsStrict } = await import("../age-tier");
    await getAgeTierSettingsStrict();
    await getAgeTierSettingsStrict();
    // Twice, not once: a cached second call would be the stale-evidence bug.
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("names ONLY the consumed columns, exactly as the cached reader does (#2130)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    vi.doMock("../prisma", () => ({ prisma: { ageTierSetting: { findMany } } }));
    const { getAgeTierSettingsStrict } = await import("../age-tier");
    await getAgeTierSettingsStrict();
    const select = findMany.mock.calls[0]?.[0]?.select as Record<string, boolean>;
    expect(Object.keys(select).sort()).toEqual([
      "familyGroupRequestCreateMemberAllowed",
      "label",
      "maxAge",
      "minAge",
      "sortOrder",
      "subscriptionRequiredForBooking",
      "tier",
    ]);
    expect(Object.keys(select)).not.toContain("xeroContactGroupId");
    expect(Object.keys(select)).not.toContain("xeroContactGroupName");
  });
});
