import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mocks.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/bed-allocation-admin-contract", () => ({
  BedAllocationAdminError: class BedAllocationAdminError extends Error {},
}));
vi.mock("@/lib/bed-allocation-settings", () => ({
  BedAllocationSettingsValidationError:
    class BedAllocationSettingsValidationError extends Error {},
}));

import { MODULE_DISABLED_ERROR_CODE } from "@/lib/api-error-message";
import {
  requireBedAllocationRead,
  requireBedAllocationWrite,
  requireBedInventoryRead,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";

const session = { user: { id: "admin-1" } };

describe("bed-allocation route permission helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
  });

  it.each([
    ["allocation read", requireBedAllocationRead, "view"],
    ["inventory read", requireBedInventoryRead, "view"],
    ["allocation write", requireBedAllocationWrite, "edit"],
    ["inventory write", requireBedInventoryWrite, "edit"],
  ] as const)("pins %s to its bookings permission", async (_name, guard, level) => {
    await expect(guard()).resolves.toEqual({ ok: true, session });

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level },
    });
    expect(mocks.isEffectiveModuleEnabled).toHaveBeenCalledWith(
      "bedAllocation",
    );
  });

  /**
   * #2931 — a module refusal NAMES itself, so a screen never has to guess it
   * from the status.
   *
   * Every `/api/admin/bed-allocation` address answers 404 while the module is
   * off, and `moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`
   * answers an ANONYMOUS caller on the same path with an identical bare
   * `{ error: "Not found" }`, on purpose. A screen that read 404 as "module
   * off" therefore told an admin whose sign-in had expired to go and switch on
   * a module. The code settles it — and the pair of tests below is what keeps
   * BOTH halves true: the code is present past the permission guard, and the
   * anonymous refusal still carries nothing that would let one unauthenticated
   * probe read which optional modules a club runs.
   */
  it.each([
    ["allocation read", requireBedAllocationRead],
    ["inventory read", requireBedInventoryRead],
    ["allocation write", requireBedAllocationWrite],
    ["inventory write", requireBedInventoryWrite],
  ] as const)("names the switched-off module on %s", async (_name, guard) => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);

    const result = await guard();

    expect(result.ok).toBe(false);
    const response = (result as { response: Response }).response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Not found",
      code: MODULE_DISABLED_ERROR_CODE,
    });
  });

  it("passes an unauthenticated refusal through untouched, code and all", async () => {
    // What a module-gated path really hands an anonymous caller.
    const anonymous = Response.json({ error: "Not found" }, { status: 404 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: anonymous });
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);

    const result = await requireBedAllocationRead();

    expect(result).toEqual({ ok: false, response: anonymous });
    // The module is off AND the caller is anonymous; the guard must still not
    // reveal which, because it never reached the module check.
    expect(mocks.isEffectiveModuleEnabled).not.toHaveBeenCalled();
    expect(await anonymous.json()).toEqual({ error: "Not found" });
  });
});
