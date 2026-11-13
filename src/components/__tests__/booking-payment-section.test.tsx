// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/stripe/BookingPaymentWrapper", () => ({
  default: () => <div>payment-wrapper</div>,
}));

import { BookingPaymentSection } from "@/components/booking-payment-section";

describe("BookingPaymentSection draft gate (ALP-569)", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  const renderGated = () =>
    render(<BookingPaymentSection bookingId="b1" amountCents={5000} paymentMode="payment" showOnMount={false} />);

  it("stays closed on a plain load", () => {
    window.history.replaceState(null, "", "/bookings/b1");
    renderGated();
    expect(screen.getByRole("button", { name: "Continue to Payment" })).toBeInTheDocument();
    expect(screen.queryByText("payment-wrapper")).toBeNull();
  });

  it("opens for the booking's own Stripe return, so the payment section can read it", async () => {
    window.history.replaceState(null, "", "/bookings/b1?stripe_return=booking&payment_intent=pi_1&redirect_status=succeeded");
    renderGated();
    expect(await screen.findByText("payment-wrapper")).toBeInTheDocument();
  });

  it("stays closed for another surface's return", () => {
    window.history.replaceState(null, "", "/bookings/b1?stripe_return=additional-payment&payment_intent=pi_1&redirect_status=succeeded");
    renderGated();
    expect(screen.queryByText("payment-wrapper")).toBeNull();
  });
});
