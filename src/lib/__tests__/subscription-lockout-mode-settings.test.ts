import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The three-way subscription-lockout SETTING (#2543): how it is stored, and how
 * the club-wide mode is derived from it.
 *
 * `mode` IS MANDATORY. The owner directive on #2561 completed this change in one
 * release: the migration backfilled `mode` from the legacy `enabled` boolean
 * (`true -> HARD_BLOCK`, `false -> NO_BLOCK`) and dropped that column in the same
 * maintenance window, so there is no dual-read path left and no null to resolve
 * except "no settings row exists at all".
 *
 * That the OLD boolean's meaning survived the drop is proven where it can
 * actually be proven — against real rows, by
 * `prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts`,
 * whose mutants cover the inverted mapping and the unconditional HARD_BLOCK. It
 * is deliberately NOT re-asserted here: this module can no longer see the column,
 * so a unit test claiming to check the mapping would be checking a fixture of its
 * own making.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { membershipLockoutSettings: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
}));

import {
  SUBSCRIPTION_LOCKOUT_MODES,
  isSubscriptionLockoutMode,
  loadMembershipLockoutSettings,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import {
  isSubscriptionEnforcementActive,
  peekSubscriptionLockoutMode,
  resolveSubscriptionLockoutMode,
} from "@/lib/member-subscription-eligibility";

/** A settings row as it exists post-#2561: `mode` stored, no legacy boolean. */
function storedRow(mode: (typeof SUBSCRIPTION_LOCKOUT_MODES)[number]) {
  return {
    id: "default",
    mode,
    financialYearEndMonthOverride: null,
    textFallbackEnabled: true,
    useFeeScheduleItemCodes: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
  mocks.refreshFinancialYearConfig.mockResolvedValue(3);
  mocks.findUnique.mockResolvedValue(null);
});

describe("the three-way vocabulary is closed (#2543)", () => {
  it("is exactly three mutually exclusive answers", () => {
    expect(SUBSCRIPTION_LOCKOUT_MODES).toEqual([
      "NO_BLOCK",
      "HARD_BLOCK",
      "NON_MEMBER_PRICING",
    ]);
    expect(new Set(SUBSCRIPTION_LOCKOUT_MODES).size).toBe(3);
  });

  it("recognises only those three", () => {
    for (const mode of SUBSCRIPTION_LOCKOUT_MODES) {
      expect(isSubscriptionLockoutMode(mode)).toBe(true);
    }
    for (const notAMode of [
      "MAYBE_BLOCK",
      "hard_block",
      "",
      null,
      undefined,
      true,
      1,
      {},
    ]) {
      expect(isSubscriptionLockoutMode(notAMode)).toBe(false);
    }
  });
});

describe("normalizeMembershipLockoutSettings resolves the stored mode (#2543)", () => {
  it("a chosen mode wins", () => {
    expect(
      normalizeMembershipLockoutSettings({ mode: "NON_MEMBER_PRICING" }).mode,
    ).toBe("NON_MEMBER_PRICING");
  });

  it.each(SUBSCRIPTION_LOCKOUT_MODES)(
    "reads a stored %s back unchanged",
    (mode) => {
      expect(normalizeMembershipLockoutSettings(storedRow(mode)).mode).toBe(mode);
    },
  );

  it("an unrecognised mode string is not trusted; it falls back to HARD_BLOCK", () => {
    // A config bundle is a file an operator can hand-edit, and a fourth policy
    // invented there would be read by every booking gate. Falling back to
    // HARD_BLOCK refuses rather than relaxes, so a malformed value cannot quietly
    // open the gate.
    expect(normalizeMembershipLockoutSettings({ mode: "SOMETIMES" }).mode).toBe(
      "HARD_BLOCK",
    );
  });

  it("no row at all is HARD_BLOCK — a fresh install starts where clubs already were", () => {
    // The ONLY remaining null case, now that the column is NOT NULL: no settings
    // row exists yet.
    expect(normalizeMembershipLockoutSettings(null).mode).toBe("HARD_BLOCK");
    expect(normalizeMembershipLockoutSettings(undefined).mode).toBe("HARD_BLOCK");
    expect(normalizeMembershipLockoutSettings({}).mode).toBe("HARD_BLOCK");
    expect(normalizeMembershipLockoutSettings({ mode: null }).mode).toBe(
      "HARD_BLOCK",
    );
  });

  it("matches the database default, so a fresh row and a missing row agree", () => {
    // The migration set DEFAULT 'HARD_BLOCK' on the column. If the two ever
    // disagreed, a club's policy would change the first time any row was written.
    const schema = readFileSync(
      path.resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toContain(
      "mode                          SubscriptionLockoutMode @default(HARD_BLOCK)",
    );
    expect(normalizeMembershipLockoutSettings(null).mode).toBe("HARD_BLOCK");
  });

  it("no longer accepts or resolves a legacy boolean (#2561)", () => {
    // The dual-read path is GONE, not merely unused. Passing the dropped column's
    // name must not resurrect it as a second source of truth: an old bundle's
    // boolean is mapped by config-transfer's reconcile hook, on the way in, and
    // nowhere else.
    const withStrayKey = { enabled: false } as Parameters<
      typeof normalizeMembershipLockoutSettings
    >[0];
    expect(normalizeMembershipLockoutSettings(withStrayKey).mode).toBe(
      "HARD_BLOCK",
    );
    expect(normalizeMembershipLockoutSettings(storedRow("NO_BLOCK"))).not.toHaveProperty(
      "enabled",
    );
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/membership-lockout-settings.ts"),
      "utf8",
    );
    expect(source).not.toContain("legacyEnabledForLockoutMode");
    expect(source).not.toContain("persisted?.enabled");
  });
});

describe("resolveSubscriptionLockoutMode (#2543)", () => {
  it.each(SUBSCRIPTION_LOCKOUT_MODES)("returns the stored %s", async (mode) => {
    mocks.findUnique.mockResolvedValue({ ...storedRow("HARD_BLOCK"), mode });
    await expect(resolveSubscriptionLockoutMode()).resolves.toBe(mode);
  });

  it("resolves NO_BLOCK whenever the Xero module is effectively off", async () => {
    // Subscriptions are invoiced through Xero, so with the module off nobody can
    // ever reach PAID. Neither refusing them nor repricing them would be honest.
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });
    mocks.findUnique.mockResolvedValue({
      ...storedRow("HARD_BLOCK"),
      mode: "NON_MEMBER_PRICING",
    });

    await expect(resolveSubscriptionLockoutMode()).resolves.toBe("NO_BLOCK");
    // Not even read: the module flag short-circuits first.
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  /**
   * THE RESEED IS GATED ON THE XERO MODULE, NOT ON THE MODE, and that is the
   * pre-#2543 condition restored. Every request-path reseeder in the tree routes
   * through this function (the booking write paths, `findUnpaidMemberGuests`, the
   * member notice builder), so gating it on `mode !== "NO_BLOCK"` left a club that
   * has deliberately switched the lockout OFF — with Xero still on — without a
   * request-path reseed at all. After a container restart, the season helpers and
   * `computeAgeTier` then resolve against the module-level March default instead of
   * the club's real year-end month, and the rate resolved for a booking can differ
   * from the correct one. `NO_BLOCK` is exactly what the #2561 migration
   * backfilled for every existing club that had `enabled = false`, so this is the
   * ordinary case, not an exotic one.
   */
  it.each(["HARD_BLOCK", "NON_MEMBER_PRICING", "NO_BLOCK"] as const)(
    "reseeds the financial-year cache with Xero on, in %s",
    async (mode) => {
      mocks.findUnique.mockResolvedValue({ ...storedRow("HARD_BLOCK"), mode });
      await resolveSubscriptionLockoutMode();
      expect(mocks.refreshFinancialYearConfig).toHaveBeenCalledTimes(1);
    },
  );

  it("reseeds for a club that has switched the lockout OFF", async () => {
    // The case the narrowed gate silently dropped. Post-#2561 this club stores
    // NO_BLOCK outright — the migration backfilled it from their `enabled = false`
    // — rather than resolving it through a fallback.
    mocks.findUnique.mockResolvedValue(storedRow("NO_BLOCK"));
    await expect(resolveSubscriptionLockoutMode()).resolves.toBe("NO_BLOCK");
    expect(mocks.refreshFinancialYearConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT reseed when the Xero module is off", async () => {
    // Nothing to reseed from: the financial year follows the connected Xero org
    // unless an admin overrides it, and with the module off there is no gate either.
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });
    await resolveSubscriptionLockoutMode();
    expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
  });
});

describe("peekSubscriptionLockoutMode is the in-transaction reader (#2543)", () => {
  // The distinction is not micro-optimisation. `refreshFinancialYearConfig` can
  // reach Xero for the organisation's accounting year, and the pricing gate that
  // calls `peek` runs inside booking transactions holding the per-lodge capacity
  // lock. A provider call in there is the one thing the booking rules forbid
  // outright, so the in-transaction reader must not be able to make one.
  it("never reseeds the financial-year cache", async () => {
    mocks.findUnique.mockResolvedValue({
      ...storedRow("HARD_BLOCK"),
      mode: "NON_MEMBER_PRICING",
    });

    await expect(peekSubscriptionLockoutMode()).resolves.toBe(
      "NON_MEMBER_PRICING",
    );
    expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
  });

  it("agrees with resolveSubscriptionLockoutMode on every input", async () => {
    for (const mode of SUBSCRIPTION_LOCKOUT_MODES) {
      mocks.findUnique.mockResolvedValue({ ...storedRow("HARD_BLOCK"), mode });
      expect(await peekSubscriptionLockoutMode()).toBe(
        await resolveSubscriptionLockoutMode(),
      );
    }
  });
});

describe("isSubscriptionEnforcementActive spans both enforcing modes (#2543)", () => {
  // Kept mode-blind on purpose: HARD_BLOCK and NON_MEMBER_PRICING need the same
  // underlying fact ("this member owes a paid subscription"), and differ only in
  // what they do with it. That is what lets one gate compute both regimes.
  it.each([
    ["NO_BLOCK", false],
    ["HARD_BLOCK", true],
    ["NON_MEMBER_PRICING", true],
  ] as const)("%s -> %s", async (mode, expected) => {
    mocks.findUnique.mockResolvedValue({ ...storedRow("HARD_BLOCK"), mode });
    await expect(isSubscriptionEnforcementActive()).resolves.toBe(expected);
  });
});

describe("loadMembershipLockoutSettings tolerates a missing table", () => {
  it("falls back to defaults rather than failing a booking request", async () => {
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    await expect(loadMembershipLockoutSettings()).resolves.toMatchObject({
      mode: "HARD_BLOCK",
    });
  });
});
