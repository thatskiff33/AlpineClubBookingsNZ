import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4300 (`INV-PAY-138`): the just-paid intent the pointer moved past, and the
 * hand-off a saved-card door makes after refusing to charge beside a superseded
 * capture whose refund has not started.
 */
const mocks = vi.hoisted(() => ({ getPaymentIntent: vi.fn(), queueSuperseded: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getPaymentIntent: mocks.getPaymentIntent }));
vi.mock("@/lib/payment-recovery", () => ({ queueSupersededPaymentIntentRefundRecovery: mocks.queueSuperseded }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { handOffSupersededCaptureAfterRefusal, isSupersededCaptureOfBooking } from "@/lib/superseded-paid-intent";

const intent = (overrides: Record<string, unknown> = {}) => ({ id: "pi_1", status: "succeeded", amount: 100, payment_method: "pm_1", metadata: { bookingId: "b1" }, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queueSuperseded.mockResolvedValue(true);
});

describe("isSupersededCaptureOfBooking", () => {
  it("asks the doors' check of this booking's own captured intent", async () => {
    mocks.getPaymentIntent.mockResolvedValue(intent());
    await expect(isSupersededCaptureOfBooking("pi_1", "b1")).resolves.toBe(true);
    expect(mocks.queueSuperseded).toHaveBeenCalledWith(intent());
  });

  it.each([
    ["another booking's intent", intent({ metadata: { bookingId: "b2" } })],
    ["an intent that never captured", intent({ status: "requires_payment_method" })],
  ])("never looks into %s", async (_label, value) => {
    mocks.getPaymentIntent.mockResolvedValue(value);
    await expect(isSupersededCaptureOfBooking("pi_1", "b1")).resolves.toBe(false);
    expect(mocks.queueSuperseded).not.toHaveBeenCalled();
  });
});

describe("handOffSupersededCaptureAfterRefusal", () => {
  const refusal = (why: "captured_primary_exists" | "superseded_capture_returning" | "superseded_refund_stopped", ids: string[]) => ({
    why,
    bookingId: "b1",
    supersededIntentsToHandOff: ids,
  });

  it("hands every waiting superseded capture to the doors' check, whichever refusal won", async () => {
    mocks.getPaymentIntent.mockImplementation(async (id: string) => intent({ id }));
    await handOffSupersededCaptureAfterRefusal(refusal("captured_primary_exists", ["pi_1", "pi_2"]));
    expect(mocks.queueSuperseded.mock.calls.map(([arg]) => (arg as { id: string }).id)).toEqual(["pi_1", "pi_2"]);
  });

  it("hands off nothing when nothing is waiting", async () => {
    await handOffSupersededCaptureAfterRefusal(refusal("superseded_refund_stopped", []));
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
  });

  it("one failure does not stop the rest, and it never throws", async () => {
    mocks.getPaymentIntent.mockRejectedValueOnce(new Error("stripe down")).mockImplementation(async (id: string) => intent({ id }));
    await expect(handOffSupersededCaptureAfterRefusal(refusal("superseded_capture_returning", ["pi_1", "pi_2"]))).resolves.toBeUndefined();
    expect(mocks.queueSuperseded.mock.calls.map(([arg]) => (arg as { id: string }).id)).toEqual(["pi_2"]);
  });
});
