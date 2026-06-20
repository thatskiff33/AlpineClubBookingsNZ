import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: {
      count: mocks.count,
    },
  },
}));

import { countExhaustedPaymentRecoveryOperations } from "@/lib/payment-recovery-health";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

describe("countExhaustedPaymentRecoveryOperations (issue #821)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts FAILED operations that have reached the retry ceiling", async () => {
    mocks.count.mockResolvedValue(2);

    const result = await countExhaustedPaymentRecoveryOperations();

    expect(result).toBe(2);
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        status: "FAILED",
        attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      },
    });
  });

  it("returns zero when nothing is exhausted", async () => {
    mocks.count.mockResolvedValue(0);
    await expect(countExhaustedPaymentRecoveryOperations()).resolves.toBe(0);
  });
});
