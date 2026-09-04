import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetPaymentMethod, mockLoggerInfo } = vi.hoisted(() => ({
  mockGetPaymentMethod: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getPaymentMethod: (...args: unknown[]) => mockGetPaymentMethod(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  setupIntentCardStillAttached,
  stripeReferenceId,
} from "@/lib/setup-intent-card";

// #3266 / INV-PAY-054 — the provider, not a local guess, decides whether a
// succeeded SetupIntent's card may be re-adopted onto a row that carries none.
describe("stripeReferenceId", () => {
  it("reads a bare id, an expanded object, and nothing", () => {
    expect(stripeReferenceId("cus_1")).toBe("cus_1");
    expect(stripeReferenceId({ id: "cus_2" })).toBe("cus_2");
    expect(stripeReferenceId(null)).toBeNull();
    expect(stripeReferenceId(undefined)).toBeNull();
  });
});

describe("setupIntentCardStillAttached", () => {
  const ask = (customerId: string | null = "cus_123") =>
    setupIntentCardStillAttached({
      bookingId: "booking-1",
      setupIntentId: "seti_1",
      paymentMethodId: "pm_1",
      customerId,
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is attached when the payment method names the booking's customer (bare id)", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: "cus_123" });
    await expect(ask()).resolves.toBe(true);
    expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_1");
  });

  it("is attached when the customer arrives expanded as an object", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: { id: "cus_123" } });
    await expect(ask()).resolves.toBe(true);
  });

  it("is NOT attached when the payment method has been detached (customer null)", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: null });
    await expect(ask()).resolves.toBe(false);
  });

  it("is NOT attached when the payment method belongs to another customer", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: "cus_other" });
    await expect(ask()).resolves.toBe(false);
  });

  it("is NOT attached when this booking has no customer to compare against", async () => {
    // Without a customer there is nothing a charge could run against, so an
    // attached card is no use to this row; the mint path creates the customer.
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: "cus_123" });
    await expect(ask(null)).resolves.toBe(false);
  });

  it("reads resource_missing as 'gone' and says so in the log, ids only", async () => {
    mockGetPaymentMethod.mockRejectedValue(
      Object.assign(new Error("No such PaymentMethod: 'pm_1'"), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 404,
      }),
    );
    await expect(ask()).resolves.toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { bookingId: "booking-1", setupIntentId: "seti_1", paymentMethodId: "pm_1" },
      expect.stringContaining("no longer exists at Stripe"),
    );
  });

  it("rethrows any other failure rather than guessing", async () => {
    const outage = Object.assign(new Error("Stripe is unavailable"), {
      type: "StripeAPIError",
      statusCode: 503,
    });
    mockGetPaymentMethod.mockRejectedValue(outage);
    await expect(ask()).rejects.toBe(outage);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
