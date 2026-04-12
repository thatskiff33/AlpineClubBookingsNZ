/**
 * Tests for Phase 3: INFANT age tier and dynamic validation
 */
import { describe, it, expect } from "vitest";
import {
  computeAgeTierWithSettings,
  AGE_TIER_DEFAULTS,
  getSeasonStartDate,
  computeAge,
  type AgeTierSettingData,
} from "../age-tier";
import { ageTierEnum } from "../age-tier-schema";
import { AgeTier } from "@prisma/client";

// ---------------------------------------------------------------------------
// INFANT tier in updated defaults
// ---------------------------------------------------------------------------

describe("AGE_TIER_DEFAULTS includes INFANT", () => {
  it("has 4 tiers: INFANT, CHILD, YOUTH, ADULT", () => {
    expect(AGE_TIER_DEFAULTS).toHaveLength(4);
    const tiers = AGE_TIER_DEFAULTS.map((d) => d.tier);
    expect(tiers).toContain("INFANT");
    expect(tiers).toContain("CHILD");
    expect(tiers).toContain("YOUTH");
    expect(tiers).toContain("ADULT");
  });

  it("INFANT covers 0-4, CHILD covers 5-9", () => {
    const infant = AGE_TIER_DEFAULTS.find((d) => d.tier === "INFANT")!;
    const child = AGE_TIER_DEFAULTS.find((d) => d.tier === "CHILD")!;

    expect(infant.minAge).toBe(0);
    expect(infant.maxAge).toBe(4);
    expect(child.minAge).toBe(5);
    expect(child.maxAge).toBe(9);
  });

  it("tiers are contiguous (no gaps)", () => {
    const sorted = [...AGE_TIER_DEFAULTS].sort((a, b) => a.sortOrder - b.sortOrder);
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      expect(cur.maxAge).not.toBeNull();
      expect(cur.maxAge! + 1).toBe(next.minAge);
    }
    // Last tier (ADULT) has no upper limit
    expect(sorted[sorted.length - 1].maxAge).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeAgeTierWithSettings with INFANT tier
// ---------------------------------------------------------------------------

describe("computeAgeTierWithSettings — with INFANT tier", () => {
  const ref2026 = getSeasonStartDate(2026); // April 1, 2026

  it("INFANT: age 0-4", () => {
    // Age 0 (born late 2025)
    expect(
      computeAgeTierWithSettings(new Date("2025-12-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    // Age 4 (turns 5 later in 2026)
    expect(
      computeAgeTierWithSettings(new Date("2021-08-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    // Age 4 exactly on April 1 (born April 1, 2022)
    expect(
      computeAgeTierWithSettings(new Date("2022-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
  });

  it("boundary: age 4 on April 1 is INFANT, age 5 on April 1 is CHILD", () => {
    // Born April 2, 2021 → age 4 on April 1, 2026 → INFANT
    expect(
      computeAgeTierWithSettings(new Date("2021-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    // Born April 1, 2021 → age 5 on April 1, 2026 → CHILD
    expect(
      computeAgeTierWithSettings(new Date("2021-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("CHILD: age 5-9 with new boundaries", () => {
    // Age 5 (born March 31, 2021 → age 5 on April 1, 2026)
    expect(
      computeAgeTierWithSettings(new Date("2021-03-31"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
    // Age 9 (born April 2, 2016 → age 9 on April 1, 2026)
    expect(
      computeAgeTierWithSettings(new Date("2016-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("YOUTH: age 10-17 (unchanged)", () => {
    expect(
      computeAgeTierWithSettings(new Date("2016-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("ADULT: age 18+ (unchanged)", () => {
    expect(
      computeAgeTierWithSettings(new Date("2008-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
  });
});

// ---------------------------------------------------------------------------
// Custom 4-tier settings
// ---------------------------------------------------------------------------

describe("computeAgeTierWithSettings — custom 4-tier settings", () => {
  const ref = new Date("2026-04-01");

  const customSettings: AgeTierSettingData[] = [
    { tier: "INFANT" as AgeTier, minAge: 0, maxAge: 2, label: "Baby (0-2)", sortOrder: 0 },
    { tier: "CHILD" as AgeTier, minAge: 3, maxAge: 12, label: "Child (3-12)", sortOrder: 1 },
    { tier: "YOUTH" as AgeTier, minAge: 13, maxAge: 17, label: "Teen (13-17)", sortOrder: 2 },
    { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
  ];

  it("respects custom INFANT boundary", () => {
    // Age 2
    expect(
      computeAgeTierWithSettings(new Date("2024-01-01"), ref, customSettings)
    ).toBe("INFANT");
    // Age 3 → CHILD with custom boundaries
    expect(
      computeAgeTierWithSettings(new Date("2023-01-01"), ref, customSettings)
    ).toBe("CHILD");
  });
});

// ---------------------------------------------------------------------------
// Shared Zod validator from Prisma enum
// ---------------------------------------------------------------------------

describe("ageTierEnum (shared Zod validator)", () => {
  it("accepts INFANT", () => {
    expect(ageTierEnum.safeParse("INFANT").success).toBe(true);
  });

  it("accepts all AgeTier values", () => {
    for (const tier of Object.values(AgeTier)) {
      expect(ageTierEnum.safeParse(tier).success).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(ageTierEnum.safeParse("TODDLER").success).toBe(false);
    expect(ageTierEnum.safeParse("").success).toBe(false);
    expect(ageTierEnum.safeParse(123).success).toBe(false);
  });

  it("includes exactly the Prisma AgeTier values", () => {
    const prismaValues = Object.values(AgeTier);
    expect(prismaValues).toContain("INFANT");
    expect(prismaValues).toContain("CHILD");
    expect(prismaValues).toContain("YOUTH");
    expect(prismaValues).toContain("ADULT");
    expect(prismaValues).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// getAgeTierOptionsFromSettings (use-age-tier-options)
// ---------------------------------------------------------------------------

describe("getAgeTierOptionsFromSettings — dynamic ordering", () => {
  it("sorts by sortOrder from DB, not hardcoded order", async () => {
    const { getAgeTierOptionsFromSettings } = await import("../use-age-tier-options");

    const settings = [
      { tier: "ADULT" as AgeTier, label: "Adult", sortOrder: 3 },
      { tier: "INFANT" as AgeTier, label: "Infant", sortOrder: 0 },
      { tier: "CHILD" as AgeTier, label: "Child", sortOrder: 1 },
      { tier: "YOUTH" as AgeTier, label: "Youth", sortOrder: 2 },
    ];

    const options = getAgeTierOptionsFromSettings(settings);
    expect(options.map((o) => o.tier)).toEqual(["INFANT", "CHILD", "YOUTH", "ADULT"]);
  });

  it("falls back to defaults when no settings provided", async () => {
    const { getAgeTierOptionsFromSettings } = await import("../use-age-tier-options");
    const options = getAgeTierOptionsFromSettings(undefined);
    expect(options).toHaveLength(4);
    expect(options[0].tier).toBe("INFANT");
  });
});
