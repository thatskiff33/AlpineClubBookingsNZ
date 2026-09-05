import { describe, expect, it } from "vitest";

import { getStripePaymentMethodId } from "@/lib/payment-recovery";
import { stripeReferenceId } from "@/lib/stripe-references";

// #3266 / INV-SSOT-001 — the one home for "the id behind a Stripe expandable
// reference", which the SDK types as either a bare id or an expanded object.
describe("stripeReferenceId", () => {
  it("reads a bare id, an expanded object, and nothing", () => {
    expect(stripeReferenceId("cus_1")).toBe("cus_1");
    expect(stripeReferenceId({ id: "cus_2" })).toBe("cus_2");
    expect(stripeReferenceId(null)).toBeNull();
    expect(stripeReferenceId(undefined)).toBeNull();
  });

  it("reads an expanded object with no usable id as nothing", () => {
    expect(stripeReferenceId({})).toBeNull();
    expect(stripeReferenceId({ id: null })).toBeNull();
  });
});

describe("getStripePaymentMethodId", () => {
  it("is the same fold over a PaymentIntent's payment_method, not a second definition", () => {
    expect(getStripePaymentMethodId({ payment_method: "pm_1" })).toBe("pm_1");
    expect(
      getStripePaymentMethodId({
        payment_method: { id: "pm_2" } as unknown as { id: string } & Record<string, never>,
      } as never),
    ).toBe("pm_2");
    expect(getStripePaymentMethodId({ payment_method: null })).toBeNull();
  });
});
