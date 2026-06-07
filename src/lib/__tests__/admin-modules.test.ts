import { describe, expect, it, vi } from "vitest";
import {
  getEffectiveModuleState,
  loadAdminModuleSettings,
  normalizeAdminModuleSettings,
} from "@/lib/admin-modules";
import type { FeatureFlags } from "@/config/schema";

const allCapabilitiesOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
};

describe("Admin Modules effective state", () => {
  it("defaults missing module settings to active for upgrade-safe fallback", () => {
    expect(normalizeAdminModuleSettings(null)).toEqual({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
  });

  it("keeps env capability as the upper bound", () => {
    expect(
      getEffectiveModuleState(
        { ...allCapabilitiesOn, waitlist: false },
        { ...allCapabilitiesOn, waitlist: true },
      )
    ).toEqual({
      ...allCapabilitiesOn,
      waitlist: false,
    });
  });

  it("lets Admin Modules disable an env-capable module", () => {
    expect(
      getEffectiveModuleState(allCapabilitiesOn, {
        ...allCapabilitiesOn,
        xeroIntegration: false,
      })
    ).toEqual({
      ...allCapabilitiesOn,
      xeroIntegration: false,
    });
  });

  it("loads persisted module settings through the default row", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      kiosk: true,
      chores: false,
      financeDashboard: true,
      waitlist: false,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });

    await expect(
      loadAdminModuleSettings({
        clubModuleSettings: {
          findUnique,
        },
      })
    ).resolves.toEqual({
      kiosk: true,
      chores: false,
      financeDashboard: true,
      waitlist: false,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
    });
  });

  it("falls back to active defaults if persisted settings cannot be read", async () => {
    await expect(
      loadAdminModuleSettings({
        clubModuleSettings: {
          findUnique: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
      })
    ).resolves.toEqual({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
  });
});
