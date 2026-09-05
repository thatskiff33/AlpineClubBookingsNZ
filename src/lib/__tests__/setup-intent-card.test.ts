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
  classifySucceededSetupIntentCard,
  setupIntentCardStillAttached,
} from "@/lib/setup-intent-card";

// #3266 / INV-PAY-052 — the provider, not a local guess, decides whether a
// succeeded SetupIntent's card may be re-adopted onto a row that does not
// already carry it.
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

// The one rule the route's alreadySaved arm and the setup_intent.succeeded
// webhook share (INV-SSOT-001): the fast path is only "the row already carries
// THIS intent's card"; everything else is the provider's call.
describe("classifySucceededSetupIntentCard", () => {
  const classify = (
    row: { stripePaymentMethodId: string | null; stripeCustomerId: string | null },
    setupIntent: {
      id: string;
      payment_method: string | { id: string } | null;
      customer: string | { id: string } | null;
    } = { id: "seti_1", payment_method: "pm_new", customer: "cus_123" },
  ) =>
    classifySucceededSetupIntentCard({
      bookingId: "booking-1",
      setupIntent: setupIntent as never,
      row,
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an intent naming no payment method has nothing to adopt, and Stripe is not asked", async () => {
    await expect(
      classify(
        { stripePaymentMethodId: null, stripeCustomerId: "cus_123" },
        { id: "seti_1", payment_method: null, customer: "cus_123" },
      ),
    ).resolves.toEqual({ outcome: "no_payment_method" });
    expect(mockGetPaymentMethod).not.toHaveBeenCalled();
  });

  it("a row already carrying exactly this intent's card is the ONLY fast path", async () => {
    await expect(
      classify({ stripePaymentMethodId: "pm_new", stripeCustomerId: "cus_123" }),
    ).resolves.toEqual({ outcome: "already_on_row", paymentMethodId: "pm_new" });
    expect(mockGetPaymentMethod).not.toHaveBeenCalled();
  });

  it("a row with no card asks Stripe: attached when the card still names the row's customer", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: "cus_123" });
    await expect(
      classify({ stripePaymentMethodId: null, stripeCustomerId: "cus_123" }),
    ).resolves.toEqual({ outcome: "attached", paymentMethodId: "pm_new" });
    expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_new");
  });

  it("a row carrying a DIFFERENT card is not evidence about this one: Stripe is asked", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: "cus_123" });
    await expect(
      classify({ stripePaymentMethodId: "pm_other", stripeCustomerId: "cus_123" }),
    ).resolves.toEqual({ outcome: "attached", paymentMethodId: "pm_new" });
    expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_new");
  });

  it("a detached card is 'detached' whatever the row carries", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: null });
    await expect(
      classify({ stripePaymentMethodId: "pm_other", stripeCustomerId: "cus_123" }),
    ).resolves.toEqual({ outcome: "detached", paymentMethodId: "pm_new" });
  });

  it("compares against the row's customer first, falling back to the intent's when the row has none", async () => {
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: "cus_from_intent" });
    await expect(
      classify(
        { stripePaymentMethodId: null, stripeCustomerId: null },
        { id: "seti_1", payment_method: "pm_new", customer: { id: "cus_from_intent" } },
      ),
    ).resolves.toEqual({ outcome: "attached", paymentMethodId: "pm_new" });

    // A row customer that disagrees with where the card is attached wins over
    // the intent's customer: the row is what the charge paths run against.
    mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: "cus_from_intent" });
    await expect(
      classify(
        { stripePaymentMethodId: null, stripeCustomerId: "cus_row" },
        { id: "seti_1", payment_method: "pm_new", customer: "cus_from_intent" },
      ),
    ).resolves.toEqual({ outcome: "detached", paymentMethodId: "pm_new" });
  });

  it("resource_missing is 'detached'; any other Stripe failure propagates", async () => {
    mockGetPaymentMethod.mockRejectedValue(
      Object.assign(new Error("No such PaymentMethod"), { code: "resource_missing" }),
    );
    await expect(
      classify({ stripePaymentMethodId: null, stripeCustomerId: "cus_123" }),
    ).resolves.toEqual({ outcome: "detached", paymentMethodId: "pm_new" });

    const outage = Object.assign(new Error("Stripe is unavailable"), { statusCode: 503 });
    mockGetPaymentMethod.mockRejectedValue(outage);
    await expect(
      classify({ stripePaymentMethodId: null, stripeCustomerId: "cus_123" }),
    ).rejects.toBe(outage);
  });
});
