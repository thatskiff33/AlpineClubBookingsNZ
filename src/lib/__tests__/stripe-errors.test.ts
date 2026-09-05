import { describe, expect, it } from "vitest";
import { isStripeResourceMissingError } from "@/lib/stripe-errors";

// #3266 — the one Stripe failure that means "the object is gone", read
// structurally so it holds across module boundaries and test doubles alike.
describe("isStripeResourceMissingError", () => {
  it("recognises the SDK's resource_missing error", () => {
    const error = Object.assign(new Error("No such PaymentMethod: 'pm_x'"), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
    });
    expect(isStripeResourceMissingError(error)).toBe(true);
  });

  it("does not read any other Stripe failure as 'gone'", () => {
    // An outage, a bad key and a rate limit all say nothing about the object.
    expect(
      isStripeResourceMissingError(
        Object.assign(new Error("unavailable"), { type: "StripeAPIError", statusCode: 503 }),
      ),
    ).toBe(false);
    expect(
      isStripeResourceMissingError(
        Object.assign(new Error("bad key"), {
          type: "StripeAuthenticationError",
          code: "api_key_expired",
          statusCode: 401,
        }),
      ),
    ).toBe(false);
    expect(
      isStripeResourceMissingError(
        Object.assign(new Error("slow down"), { type: "StripeRateLimitError", statusCode: 429 }),
      ),
    ).toBe(false);
  });

  it("does not read a 404 without the code as 'gone'", () => {
    // The status alone is not the verdict; a proxy can answer 404 for a path
    // that exists.
    expect(
      isStripeResourceMissingError(Object.assign(new Error("not found"), { statusCode: 404 })),
    ).toBe(false);
  });

  it("is false for non-objects and null", () => {
    expect(isStripeResourceMissingError(null)).toBe(false);
    expect(isStripeResourceMissingError(undefined)).toBe(false);
    expect(isStripeResourceMissingError("resource_missing")).toBe(false);
    expect(isStripeResourceMissingError(new Error("plain"))).toBe(false);
  });
});
