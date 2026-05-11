/**
 * Tests for Issue 13 & 14: Age tier boundaries and configurable settings
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeAgeTierWithSettings,
  AGE_TIER_DEFAULTS,
  getSeasonStartDate,
  computeAge,
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
  type AgeTierSettingData,
} from "../age-tier";

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

describe("normalizeAgeTierSettings", () => {
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
        xeroAcceptedContactGroups: [],
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 3,
        maxAge: 12,
        label: "Child (3-12)",
        xeroAcceptedContactGroups: [],
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 17,
        label: "Teen (13-17)",
        xeroAcceptedContactGroups: [],
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        xeroAcceptedContactGroups: [],
        sortOrder: 3,
      },
    ];

    expect(normalizeAgeTierSettings(customRows)).toEqual(
      customRows.map((row) => ({
        ...row,
        subscriptionRequiredForBooking: true,
      }))
    );
  });
});

// ---------------------------------------------------------------------------
// Admin API validation logic (unit-testable business rules)
// ---------------------------------------------------------------------------

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
