import { describe, expect, it } from "vitest";
import {
  canCreateImmediatePaymentIntent,
  getBookingPaymentMode,
  needsSavedCardEntry,
} from "@/lib/booking-payment-flow";

describe("getBookingPaymentMode", () => {
  it("uses setup mode only for pending bookings", () => {
    expect(getBookingPaymentMode("PENDING")).toBe("setup");
  });

  it("uses payment mode for payment-pending bookings with lifecycle already decided", () => {
    expect(getBookingPaymentMode("PAYMENT_PENDING")).toBe("payment");
    expect(getBookingPaymentMode("CONFIRMED")).toBe("payment");
    expect(getBookingPaymentMode("DRAFT")).toBe("payment");
    expect(getBookingPaymentMode("PAID")).toBe("payment");
  });
});

describe("canCreateImmediatePaymentIntent", () => {
  it("allows a normal payment-pending booking", () => {
    expect(
      canCreateImmediatePaymentIntent({
        status: "PAYMENT_PENDING",
        hasNonMembers: false,
      })
    ).toBe(true);
  });

  it("blocks an organiser-settled booking so the joiner cannot self-pay", () => {
    // ORGANISER_PAYS: the organiser settles the group total, so the joiner who
    // owns this child booking must never get a self-pay flow even though the
    // status would otherwise be payable.
    expect(
      canCreateImmediatePaymentIntent({
        status: "PAYMENT_PENDING",
        hasNonMembers: false,
        organiserSettled: true,
      })
    ).toBe(false);
  });
});

// #3266 — the booking page's "Save Payment Method" card keys on this. It used
// to key on "no SetupIntent yet", which hid the form from a member whose row
// carried an intent id but no chargeable card.
describe("needsSavedCardEntry", () => {
  it("is true when there is no payment row at all", () => {
    expect(needsSavedCardEntry(null)).toBe(true);
    expect(needsSavedCardEntry(undefined)).toBe(true);
  });

  it("is true when a SetupIntent exists but the row carries no card (abandoned replacement, or a retired card)", () => {
    const staleIntentNoCard = {
      stripePaymentMethodId: null,
      stripeSetupIntentId: "seti_stale",
      stripeCustomerId: "cus_1",
    };
    expect(needsSavedCardEntry(staleIntentNoCard)).toBe(true);
  });

  it("is false once a card is on the row", () => {
    expect(needsSavedCardEntry({ stripePaymentMethodId: "pm_live" })).toBe(false);
  });
});
