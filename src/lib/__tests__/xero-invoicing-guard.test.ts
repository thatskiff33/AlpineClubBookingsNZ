import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isEffectiveModuleEnabled: vi.fn() }));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mocks.isEffectiveModuleEnabled,
}));

import {
  assertSubscriptionInvoicingEnabled,
  isXeroInvoicingEnabled,
} from "@/lib/xero-invoicing-guard";
import {
  SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE,
  XeroInvoicingOffError,
} from "@/lib/xero-invoicing-off";

// #4986 (INV-INT-038): the suites that drive the writers replace this guard; this
// pins that the real one asks the effective xeroIntegration module state.
describe("xero invoicing guard (#4986)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the effective xeroIntegration module state", async () => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
    await expect(isXeroInvoicingEnabled()).resolves.toBe(true);
    expect(mocks.isEffectiveModuleEnabled).toHaveBeenCalledWith("xeroIntegration");

    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);
    await expect(isXeroInvoicingEnabled()).resolves.toBe(false);
  });

  it("refuses with a 409 and the plain message while Xero is off, and passes while it is on", async () => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);
    const refusal = await assertSubscriptionInvoicingEnabled().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(XeroInvoicingOffError);
    expect(refusal).toMatchObject({ status: 409, message: SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE });

    mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
    await expect(assertSubscriptionInvoicingEnabled()).resolves.toBeUndefined();
  });
});
