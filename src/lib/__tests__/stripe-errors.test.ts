import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  isStripeResourceMissingError,
  readStripeErrorFields,
  stripeErrorApiType,
} from "@/lib/stripe-errors";
import { stripeSdkError as sdkError } from "./support/stripe-sdk-error";

const INCIDENT_MESSAGE =
  "The provided PaymentMethod was previously used with a PaymentIntent without Customer attachment or was detached from a Customer. It may not be used again.";

// #3268 — the ONE reader of a Stripe error's provider fields. Everything that
// decides on a Stripe failure (the saved-card classifier, the setup-intent
// route's "is the card gone" question) derives from it, so where the SDK keeps
// each field is known in exactly one place.
describe("stripeErrorApiType / readStripeErrorFields (#3268)", () => {
  it("reads the API type from rawType on a thrown SDK error, whose `type` is the class name", () => {
    const err = sdkError({
      type: "card_error",
      code: "card_declined",
      decline_code: "lost_card",
      statusCode: 402,
    });
    expect(err.type).toBe("StripeCardError");
    expect(stripeErrorApiType(err)).toBe("card_error");
    expect(
      stripeErrorApiType(
        sdkError({ type: "invalid_request_error", message: INCIDENT_MESSAGE, statusCode: 400 }),
      ),
    ).toBe("invalid_request_error");
  });

  it("reads the API type from `type` on the raw API object (webhook / last_payment_error shape)", () => {
    expect(stripeErrorApiType({ type: "card_error", code: "card_declined" })).toBe("card_error");
    expect(stripeErrorApiType({ type: "invalid_request_error" })).toBe("invalid_request_error");
  });

  it("never returns an SDK class name as an API type (a connection error has no rawType)", () => {
    const err = new Stripe.errors.StripeConnectionError({ message: "socket hang up" });
    expect(err.type).toBe("StripeConnectionError");
    expect(stripeErrorApiType(err)).toBeNull();
    expect(stripeErrorApiType({ type: "StripeCardError" })).toBeNull();
  });

  it("reads code, decline_code, param, advice_code and message the same way from either shape", () => {
    const fields = {
      type: "card_error",
      code: "card_declined",
      decline_code: "do_not_honor",
      advice_code: "do_not_try_again",
      param: "payment_method",
      message: "Your card was declined.",
    };
    const expected = {
      apiType: "card_error",
      code: "card_declined",
      declineCode: "do_not_honor",
      adviceCode: "do_not_try_again",
      param: "payment_method",
      message: "Your card was declined.",
    };
    expect(readStripeErrorFields(sdkError({ ...fields, statusCode: 402 }))).toEqual(expected);
    expect(readStripeErrorFields(fields)).toEqual(expected);
  });

  it("never throws: a non-object or a plain Error yields null provider fields and the message", () => {
    expect(readStripeErrorFields(new Error("boom"))).toEqual({
      apiType: null,
      code: null,
      declineCode: null,
      param: null,
      adviceCode: null,
      message: "boom",
    });
    expect(readStripeErrorFields("resource_missing").message).toBe("resource_missing");
    expect(readStripeErrorFields(null).code).toBeNull();
    expect(readStripeErrorFields(undefined).apiType).toBeNull();
    // An empty string is "not present", never an empty code a caller could
    // compare against.
    expect(readStripeErrorFields({ type: "card_error", code: "" }).code).toBeNull();
  });
});

// #3266 — the one Stripe failure that means "the object is gone", read
// structurally so it holds across module boundaries and test doubles alike.
describe("isStripeResourceMissingError", () => {
  it("is a derivation of readStripeErrorFields — it agrees with the reader's code on every shape", () => {
    const shapes: unknown[] = [
      sdkError({ type: "invalid_request_error", code: "resource_missing", statusCode: 404 }),
      { type: "invalid_request_error", code: "resource_missing" },
      sdkError({ type: "invalid_request_error", code: "payment_method_unexpected_state", statusCode: 400 }),
      sdkError({ type: "api_error", statusCode: 503 }),
      new Error("plain"),
      null,
      "resource_missing",
    ];
    for (const shape of shapes) {
      expect(isStripeResourceMissingError(shape)).toBe(
        readStripeErrorFields(shape).code === "resource_missing",
      );
    }
    expect(shapes.filter((shape) => isStripeResourceMissingError(shape))).toHaveLength(2);
  });

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
