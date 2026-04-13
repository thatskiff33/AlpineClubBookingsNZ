// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";

const fetchMock = vi.fn();

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-provider">{children}</div>
  ),
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: ({
    onError,
    onSuccess,
  }: {
    onError: (error: string) => void;
    onSuccess: (paymentIntentId: string) => void;
  }) => (
    <div>
      <div>payment-form</div>
      <button type="button" onClick={() => onError("Card declined")}>
        trigger-error
      </button>
      <button type="button" onClick={() => onSuccess("pi_success")}>
        trigger-success
      </button>
    </div>
  ),
}));

vi.mock("@/components/stripe/SetupForm", () => ({
  default: () => <div>setup-form</div>,
}));

describe("BookingPaymentWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("keeps the payment form mounted after a recoverable payment error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ clientSecret: "cs_test" }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());

    fireEvent.click(screen.getByText("trigger-error"));

    expect(screen.queryByText("payment-form")).not.toBeNull();
    expect(screen.queryByText("Payment Error")).toBeNull();
  });

  it("reconciles a successful payment before refreshing the page", async () => {
    const onPaymentComplete = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clientSecret: "cs_test" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={onPaymentComplete}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());

    fireEvent.click(screen.getByText("trigger-success"));

    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/bookings/booking-1/confirm-payment",
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
