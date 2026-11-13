// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { hasStripeReturn, readStripeReturn, stripeReturnUrl, takeStripeReturn } from "@/lib/stripe-return";

const RETURN = "payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_x&redirect_status=succeeded";

function at(path: string) {
  window.history.replaceState({ keep: true }, "", path);
}

describe("stripe-return (#4955, ALP-569)", () => {
  afterEach(() => at("/"));

  it("reads only an intent id of Stripe's shape, and only as a reason to ask the server", () => {
    expect(readStripeReturn(`?${RETURN}`)).toEqual({ kind: "check", intentId: "pi_123", confirmation: "succeeded" });
    expect(readStripeReturn("?payment_intent=pi_123&redirect_status=processing")).toEqual({
      kind: "check", intentId: "pi_123", confirmation: "processing",
    });
    expect(readStripeReturn("?payment_intent=x%20y&redirect_status=succeeded")).toEqual({ kind: "none" });
    expect(readStripeReturn("?payment_intent=pi_123&redirect_status=requires_payment_method")).toEqual({ kind: "failed" });
    expect(readStripeReturn("?payment_intent=pi_123&redirect_status=weird")).toEqual({ kind: "none" });
  });

  it("names the surface in its return_url, keeping the page's own parameters", () => {
    const url = new URL(stripeReturnUrl("group-settlement", "http://localhost/bookings/b1?tab=group#pay"));
    expect(url.searchParams.get("stripe_return")).toBe("group-settlement");
    expect(url.searchParams.get("tab")).toBe("group");
    expect(url.hash).toBe("#pay");
  });

  it("drops an earlier return left in the page address from a new return_url", () => {
    const url = new URL(
      stripeReturnUrl("group-settlement", "http://localhost/bookings/b1?stripe_return=booking&payment_intent=pi_old&payment_intent_client_secret=s&redirect_status=failed"),
    );
    expect(url.search).toBe("?stripe_return=group-settlement");
  });

  it("gives a named return only to its surface and cleans the address bar", () => {
    at(`/bookings/b1?tab=group&stripe_return=additional-payment&${RETURN}#pay`);
    expect(hasStripeReturn("booking")).toBe(false);
    expect(takeStripeReturn("booking")).toEqual({ kind: "none" });
    expect(takeStripeReturn()).toEqual({ kind: "none" });
    expect(window.location.search).toContain("payment_intent=pi_123");

    expect(hasStripeReturn("additional-payment")).toBe(true);
    expect(takeStripeReturn("additional-payment")).toEqual({ kind: "check", intentId: "pi_123", confirmation: "succeeded" });
    expect(window.location.pathname).toBe("/bookings/b1");
    expect(window.location.search).toBe("?tab=group");
    expect(window.location.hash).toBe("#pay");
    expect(window.history.state).toEqual({ keep: true });
    // React strict mode's second run finds nothing.
    expect(takeStripeReturn("additional-payment")).toEqual({ kind: "none" });
  });

  it("leaves a named return alone for the unnamed pay-link reader, and the reverse", () => {
    at(`/pay/tok?${RETURN}`);
    expect(takeStripeReturn("booking")).toEqual({ kind: "none" });
    expect(takeStripeReturn()).toEqual({ kind: "check", intentId: "pi_123", confirmation: "succeeded" });
    expect(window.location.search).toBe("");
  });

  it("removes a lone surface name without reporting a return", () => {
    at("/bookings/b1?stripe_return=booking");
    expect(hasStripeReturn("booking")).toBe(false);
    expect(takeStripeReturn("booking")).toEqual({ kind: "none" });
    expect(window.location.search).toBe("");
  });
});
