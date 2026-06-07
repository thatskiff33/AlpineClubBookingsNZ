import { describe, expect, it } from "vitest";
import { getOptionalCronRegistrationState } from "@/instrumentation.node";
import type { FeatureFlags } from "@/config/schema";

describe("feature-aware cron registration", () => {
  it("skips optional cron groups when their feature flags are off", () => {
    const flags: FeatureFlags = {
      kiosk: true,
      chores: true,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
      bedAllocation: false,
      internetBankingPayments: false,
    };

    expect(getOptionalCronRegistrationState(flags)).toEqual({
      financeDailySync: false,
      waitlistProcessor: false,
      xeroIntegration: false,
    });
  });

  it("registers optional cron groups when their feature flags are on", () => {
    const flags: FeatureFlags = {
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    };

    expect(getOptionalCronRegistrationState(flags)).toEqual({
      financeDailySync: true,
      waitlistProcessor: true,
      xeroIntegration: true,
    });
  });
});
