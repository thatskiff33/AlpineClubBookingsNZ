import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_MODULE_KEYS,
  getEffectiveModuleState,
  loadAdminModuleSettings,
  normalizeAdminModuleSettings,
} from "@/lib/admin-modules";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  DEFAULT_MODULE_SETTINGS,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

const allCapabilitiesOn = Object.fromEntries(
  ADMIN_MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

describe("Admin Modules effective state", () => {
  it("defaults missing module settings to the hardened first-install defaults", () => {
    expect(normalizeAdminModuleSettings(null)).toEqual(DEFAULT_MODULE_SETTINGS);
    expect(ADMIN_MODULE_KEYS).toContain("addressAutocomplete");
    expect(DEFAULT_MODULE_SETTINGS.addressAutocomplete).toBe(false);
  });

  it("reflects admin activation as the effective state", () => {
    expect(
      getEffectiveModuleState({ ...allCapabilitiesOn, waitlist: false })
    ).toEqual({
      ...allCapabilitiesOn,
      waitlist: false,
    });
  });

  it("lets Admin Modules disable a module", () => {
    expect(
      getEffectiveModuleState({
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
      // Persisted row sets the 7 capability keys explicitly; the general-purpose
      // modules are absent and fall back to their defaults (on).
    ).resolves.toEqual({
      ...DEFAULT_MODULE_SETTINGS,
      kiosk: true,
      chores: false,
      financeDashboard: true,
      waitlist: false,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
    // The read uses an explicit column select (derived from MODULE_KEYS) so the
    // generated SELECT never names a retired column; it does not make a DROP
    // safe on its own (INV-OPS-005).
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
  });

  it("falls back to hardened defaults if persisted settings cannot be read", async () => {
    await expect(
      loadAdminModuleSettings({
        clubModuleSettings: {
          findUnique: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
      })
    ).resolves.toEqual(DEFAULT_MODULE_SETTINGS);
  });
});
