import { describe, expect, it } from "vitest";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";

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
