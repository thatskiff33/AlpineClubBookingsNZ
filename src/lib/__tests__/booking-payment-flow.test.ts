import { describe, expect, it } from "vitest";
import {
  canCreateImmediatePaymentIntent,
  getBookingPaymentMode,
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
