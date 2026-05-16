import { describe, expect, it } from "vitest";
import { loadFeatureFlags } from "@/config/features";

describe("loadFeatureFlags", () => {
  it("defaults every flag to false when no env vars are set", () => {
    expect(loadFeatureFlags({})).toEqual({
      kiosk: false,
      chores: false,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
    });
  });

  it("enables a flag when its env var is exactly 'true'", () => {
    const flags = loadFeatureFlags({ FEATURE_KIOSK: "true" });
    expect(flags.kiosk).toBe(true);
  });

  it("accepts 'true' case-insensitively and with surrounding whitespace", () => {
    expect(loadFeatureFlags({ FEATURE_KIOSK: "TRUE" }).kiosk).toBe(true);
    expect(loadFeatureFlags({ FEATURE_KIOSK: "True" }).kiosk).toBe(true);
    expect(loadFeatureFlags({ FEATURE_KIOSK: "  true  " }).kiosk).toBe(true);
  });

  it("treats anything other than 'true' as false (fail-safe)", () => {
    for (const v of ["", "false", "1", "0", "yes", "no", "on", "off", "True!"]) {
      expect(loadFeatureFlags({ FEATURE_KIOSK: v }).kiosk).toBe(false);
    }
  });

  it("maps each flag to its dedicated env var", () => {
    const flags = loadFeatureFlags({
      FEATURE_KIOSK: "true",
      FEATURE_CHORES: "true",
      FEATURE_FINANCE_DASHBOARD: "true",
      FEATURE_WAITLIST: "true",
      FEATURE_XERO_INTEGRATION: "true",
    });
    expect(flags).toEqual({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
    });
  });

  it("ignores unrelated env vars", () => {
    const flags = loadFeatureFlags({
      FEATURE_UNKNOWN: "true",
      NODE_ENV: "test",
    });
    expect(flags.kiosk).toBe(false);
  });
});
