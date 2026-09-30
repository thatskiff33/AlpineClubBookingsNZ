import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claimAlertCooldown: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/alert-cooldown", () => ({
  claimAlertCooldown: (...a: unknown[]) => mocks.claimAlertCooldown(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mocks.error, debug: vi.fn() },
}));

import { claimAlertCooldownFailOpen } from "@/lib/alert-cooldown-fail-open";

/**
 * #3635: the one fail-open windowed claim the settlement-money alerts share.
 * A claim that cannot be READ sends anyway; a claim someone else holds does not.
 */
describe("claimAlertCooldownFailOpen", () => {
  const claim = () =>
    claimAlertCooldownFailOpen({
      key: "manual-settlement-conflict:pay_1:inv_1",
      windowMs: 86_400_000,
      now: new Date("2026-07-01T00:00:00.000Z"),
      context: { paymentId: "pay_1" },
      logMessage: "sending anyway",
    });

  beforeEach(() => vi.clearAllMocks());

  it("passes the caller's key, window and stamp through, and answers the claim", async () => {
    mocks.claimAlertCooldown.mockResolvedValue(true);
    await expect(claim()).resolves.toBe(true);
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith({
      key: "manual-settlement-conflict:pay_1:inv_1",
      windowMs: 86_400_000,
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    mocks.claimAlertCooldown.mockResolvedValue(false);
    await expect(claim()).resolves.toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("sends anyway, and says so, when the claim itself fails", async () => {
    mocks.claimAlertCooldown.mockRejectedValue(new Error("db down"));
    await expect(claim()).resolves.toBe(true);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: "manual-settlement-conflict:pay_1:inv_1", paymentId: "pay_1" }),
      "sending anyway",
    );
  });
});
