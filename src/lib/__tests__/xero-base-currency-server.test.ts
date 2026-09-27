import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  getXeroConnectionStatus: vi.fn(),
  getXeroConnectedOrganisation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroConnectionStatus: mocks.getXeroConnectionStatus,
}));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroConnectedOrganisation: mocks.getXeroConnectedOrganisation,
}));

import {
  emptyAdminPermissionMatrix,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import { readXeroBaseCurrencyForViewer } from "@/lib/xero-base-currency-server";

function viewerWithFinance(level: AdminPermissionLevel) {
  return {
    canLogin: true,
    accessRoles: [],
    adminPermissionMatrix: {
      ...emptyAdminPermissionMatrix(),
      support: "view" as const,
      finance: level,
    },
  };
}

/**
 * The server half of the Xero base-currency warning (#3633): who gets the base
 * currency at all. The summary is finance-only (#2314), and the two server
 * surfaces showing the warning are wider than that, so everyone outside the
 * audience must get null — which the comparison reads as "no warning".
 */
describe("readXeroBaseCurrencyForViewer (#3633)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
    mocks.getXeroConnectionStatus.mockResolvedValue({ connected: true });
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: "Alpine Club",
      financialYearEndMonth: 3,
      shortCode: "!aBc12",
      baseCurrency: "AUD",
      readFailure: null,
    });
  });

  it.each(["view", "edit"] as const)(
    "returns the base currency to a finance %s admin",
    async (level) => {
      await expect(
        readXeroBaseCurrencyForViewer(viewerWithFinance(level)),
      ).resolves.toBe("AUD");
    },
  );

  it("gives an admin without finance access nothing, and asks nobody", async () => {
    await expect(
      readXeroBaseCurrencyForViewer(viewerWithFinance("none")),
    ).resolves.toBeNull();
    await expect(readXeroBaseCurrencyForViewer(null)).resolves.toBeNull();
    expect(mocks.getXeroConnectionStatus).not.toHaveBeenCalled();
    expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
  });

  it("does not read the organisation while the Xero module is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });
    await expect(
      readXeroBaseCurrencyForViewer(viewerWithFinance("view")),
    ).resolves.toBeNull();
    expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
  });

  it("does not read the organisation while Xero is not connected", async () => {
    mocks.getXeroConnectionStatus.mockResolvedValue({ connected: false });
    await expect(
      readXeroBaseCurrencyForViewer(viewerWithFinance("view")),
    ).resolves.toBeNull();
    expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
  });

  it("fails closed to null when the connection check itself fails", async () => {
    mocks.getXeroConnectionStatus.mockRejectedValue(new Error("db down"));
    await expect(
      readXeroBaseCurrencyForViewer(viewerWithFinance("view")),
    ).resolves.toBeNull();
  });

  it("passes on an unknown base currency as null", async () => {
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: null,
      financialYearEndMonth: null,
      shortCode: null,
      baseCurrency: null,
      readFailure: { kind: "unavailable", rateLimit: null, retryAfterSeconds: null },
    });
    await expect(
      readXeroBaseCurrencyForViewer(viewerWithFinance("view")),
    ).resolves.toBeNull();
  });
});
