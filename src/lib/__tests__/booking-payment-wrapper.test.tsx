// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE,
  PAYMENT_PROCESSING_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
  REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
  REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_MESSAGE,
} from "@/lib/payment-recovery-contract";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const fetchMock = vi.fn();
const scrollIntoView = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-provider">{children}</div>
  ),
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: function MockPaymentForm({
    onError,
    onSuccess,
    chargedAmountCents,
    isSplit,
    deferredGuestAmountCents,
  }: {
    onError: (error: string) => void;
    onSuccess: (paymentIntentId: string) => void;
    chargedAmountCents?: number | null;
    isSplit?: boolean | null;
    deferredGuestAmountCents?: number | null;
  }) {
    const [paid, setPaid] = useState(false);
    if (paid) {
      return <div>Payment successful!</div>;
    }
    return (
      <div>
        <div>payment-form</div>
        <div data-testid="charged-amount">{String(chargedAmountCents)}</div>
        <div data-testid="is-split">{String(isSplit)}</div>
        <div data-testid="deferred-amount">
          {String(deferredGuestAmountCents)}
        </div>
        <button type="button" onClick={() => onError("Card declined")}>
          trigger-error
        </button>
        <button
          type="button"
          onClick={() => {
            setPaid(true);
            onSuccess("pi_success");
          }}
        >
          trigger-success
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/stripe/SetupForm", () => ({
  default: () => <div>setup-form</div>,
}));

describe("BookingPaymentWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
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

  it("shows generic copy and never renders the raw provider error when init fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const rawProviderError = "Invalid API Key provided: sk_test_51SecretKeyMaterial";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: rawProviderError }),
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

    await waitFor(() => expect(screen.queryByText("Payment Error")).not.toBeNull());

    // Generic, member-safe copy is shown (the pay-later recovery affordance).
    expect(
      screen.queryByText(/you can\s+pay later from your booking page/i)
    ).not.toBeNull();

    // The raw provider detail (and any partial key material) must NOT reach the DOM.
    expect(document.body.textContent).not.toContain("sk_test");
    expect(document.body.textContent).not.toContain("Invalid API Key");
    expect(screen.queryByText(/Invalid API Key/i)).toBeNull();

    // The detail is reported to Sentry (scrubbed by beforeSend), NOT to the
    // member's browser console — the client console log carries bookingId only,
    // so no raw provider/key material lands in a member's DevTools (#1223).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Booking payment initialization failed",
      { bookingId: "booking-1" }
    );
    const consoleArgs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(consoleArgs).not.toContain("sk_test");
    expect(consoleArgs).not.toContain("Invalid API Key");

    consoleErrorSpy.mockRestore();
  });

  it("keeps a refunded-payment replacement failure on the retryable initialization UI", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Failed to create payment intent" }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Payment Error"));
    expect(alert).toHaveTextContent(/pay later from your booking page/i);
    expect(alert).not.toHaveTextContent(
      "Card transaction found - check payment status",
    );
    expect(alert).not.toHaveTextContent(
      "Payment received - check booking status",
    );
    consoleErrorSpy.mockRestore();
  });

  it("says an earlier payment is still processing, without reporting a payment-start failure (#3567)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ ...PAYMENT_PROCESSING_BODY, creditElection: null }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Payment being processed"));
    expect(alert).toHaveTextContent(
      "This payment is being processed. Refresh the page in a minute to see it confirmed.",
    );
    expect(screen.queryByText("Payment Error")).toBeNull();
    expect(document.body.textContent).not.toContain("We couldn't start the card payment");
    expect(screen.queryByText("payment-form")).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reports captured-card finalisation recovery instead of a payment-start failure", async () => {
    const onPaymentComplete = vi.fn();
    const retryMessage =
      "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: retryMessage,
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
        finalisationPending: true,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={onPaymentComplete}
      />,
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toContain(retryMessage));
    expect(alert.textContent).toContain(
      "Your card payment was received, but booking finalisation is still pending.",
    );
    expect(alert.textContent).toContain(
      "Reload this page and check the booking status before trying any payment again.",
    );
    expect(screen.queryByText("Payment Error")).toBeNull();
    expect(document.body.textContent).not.toContain(
      "We couldn't start the card payment",
    );
    expect(screen.queryByText("payment-form")).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(onPaymentComplete).not.toHaveBeenCalled();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("suppresses payment retry and focuses ordinary post-capture status recovery", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: "PAYMENT_RECEIVED_STATUS_UNCONFIRMED",
        error: "raw server text must not be shown",
        paymentReceived: true,
        bookingStatusUnconfirmed: true,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert).toHaveTextContent("Payment received - check booking status"),
    );
    expect(alert).toHaveTextContent(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE);
    expect(alert).not.toHaveTextContent("raw server text");
    expect(alert).not.toHaveTextContent("finalisation pending");
    expect(screen.queryByText("payment-form")).toBeNull();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("requires the exact ordinary post-capture marker before suppressing payment", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: "PAYMENT_RECEIVED_STATUS_UNCONFIRMED",
        error: "not an accepted recovery marker",
        paymentReceived: true,
        bookingStatusUnconfirmed: true,
        finalisationPending: true,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Payment Error"));
    expect(alert).not.toHaveTextContent("Payment received - check booking status");
    consoleErrorSpy.mockRestore();
  });

  it("suppresses payment without claiming receipt when only Stripe success is known", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: "EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED",
        error: "private refund lookup detail",
        existingCardTransactionFound: true,
        paymentStatusUnconfirmed: true,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert", { hidden: true });
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "Card transaction found - check payment status",
      ),
    );
    expect(alert).toHaveTextContent(
      EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE,
    );
    expect(alert).not.toHaveTextContent("private refund lookup detail");
    expect(alert).not.toHaveTextContent("Your card payment was received");
    expect(screen.queryByText("payment-form")).toBeNull();
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it.each([
    [true, "Booking cancelled - payment refunded", /card payment was refunded/i],
    [
      false,
      "Booking cancelled - refund needs attention",
      /refund could not be confirmed/i,
    ],
  ])(
    "suppresses payment for an initialization-time cancellation (refunded: %s)",
    async (refunded, heading, copy) => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "server detail is not rendered",
          status: "CANCELLED",
          refunded,
        }),
      });

      render(
        <BookingPaymentWrapper
          bookingId="booking-1"
          amountCents={12500}
          paymentMode="payment"
          returnUrl="http://localhost/bookings/booking-1"
          onPaymentComplete={vi.fn()}
        />,
      );

      const alert = screen.getByRole("alert", { hidden: true });
      await waitFor(() => expect(alert).toHaveTextContent(heading));
      expect(alert).toHaveTextContent(copy);
      expect(alert).toHaveTextContent(/Do not try another payment/i);
      expect(alert).not.toHaveTextContent("server detail");
      expect(alert).not.toHaveTextContent(/pay later from your booking page/i);
      expect(screen.queryByText("payment-form")).toBeNull();
      await expectRecoveryAlertToHoldFocus(alert);
    },
  );

  it("keeps a pre-capture participant retry on the ordinary payment-start recovery", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error:
          "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.",
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />,
    );

    expect(await screen.findByText("Payment Error")).not.toBeNull();
    expect(
      screen.queryByText("Payment received - finalisation pending"),
    ).toBeNull();
    expect(
      screen.queryByText(/your card payment was received/i),
    ).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it("forwards the server charge figures to PaymentForm for a split parent (#1976)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: "cs_test",
        chargedAmountCents: 12000,
        isSplit: true,
        deferredGuestAmountCents: 8000,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={20000}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());
    expect(screen.getByTestId("charged-amount").textContent).toBe("12000");
    expect(screen.getByTestId("is-split").textContent).toBe("true");
    expect(screen.getByTestId("deferred-amount").textContent).toBe("8000");
  });

  it("passes null deferred amount to PaymentForm for a non-split booking (#1976)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: "cs_test",
        chargedAmountCents: 12500,
        isSplit: false,
        deferredGuestAmountCents: null,
      }),
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
    expect(screen.getByTestId("charged-amount").textContent).toBe("12500");
    expect(screen.getByTestId("is-split").textContent).toBe("false");
    expect(screen.getByTestId("deferred-amount").textContent).toBe("null");
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

  it("keeps the successful payment panel mounted when hosting finalisation must be retried", async () => {
    const onPaymentComplete = vi.fn();
    const retryMessage =
      "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clientSecret: "cs_test" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: retryMessage,
          code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
          paymentReceived: true,
          finalisationPending: true,
        }),
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

    await screen.findByText("payment-form");
    const alert = screen.getByRole("alert", { hidden: true });
    expect(alert.textContent).toBe("");
    fireEvent.click(screen.getByText("trigger-success"));

    await waitFor(() => expect(alert.textContent).toContain(retryMessage));
    expect(alert.textContent).toContain(
      "Your card payment was received, but booking finalisation is still pending.",
    );
    expect(alert.classList.contains("sr-only")).toBe(false);
    expect(screen.queryByText("payment-form")).toBeNull();
    expect(screen.getByText("Payment successful!")).not.toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("keeps the successful payment panel mounted for ordinary post-capture status recovery", async () => {
    const onPaymentComplete = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clientSecret: "cs_test" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
          error: "raw server text must not be shown",
        }),
      });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={onPaymentComplete}
      />,
    );

    fireEvent.click(await screen.findByText("trigger-success"));

    const alert = screen.getByRole("alert", { hidden: true });
    await waitFor(() =>
      expect(alert).toHaveTextContent("Payment received - check booking status"),
    );
    expect(alert).toHaveTextContent(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE);
    expect(alert).not.toHaveTextContent("raw server text");
    expect(screen.getByText("Payment successful!")).not.toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("shows locally proven refund recovery without claiming payment receipt", async () => {
    const onPaymentComplete = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clientSecret: "cs_test" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          ...REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
          error: "raw server text must not be shown",
        }),
      });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={onPaymentComplete}
      />,
    );
    fireEvent.click(await screen.findByText("trigger-success"));

    const alert = screen.getByRole("alert", { hidden: true });
    await waitFor(() =>
      expect(alert).toHaveTextContent("Previous card payment refunded"),
    );
    expect(alert).toHaveTextContent(
      REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_MESSAGE,
    );
    expect(alert).not.toHaveTextContent("Payment received");
    expect(alert).not.toHaveTextContent("raw server text");
    expect(onPaymentComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Payment successful!")).not.toBeNull();
  });

  it.each([
    [
      true,
      "Booking cancelled - payment refunded",
      /card payment was refunded/i,
    ],
    [
      false,
      "Booking cancelled - refund needs attention",
      /Automatic refund recovery is pending/i,
    ],
  ])(
    "retains the cancelled-booking recovery after confirmation (refunded: %s)",
    async (refunded, heading, copy) => {
      const onPaymentComplete = vi.fn();

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ clientSecret: "cs_test" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            error: "private provider or database detail",
            status: "CANCELLED",
            refunded,
          }),
        });

      render(
        <BookingPaymentWrapper
          bookingId="booking-1"
          amountCents={12500}
          paymentMode="payment"
          returnUrl="http://localhost/bookings/booking-1"
          onPaymentComplete={onPaymentComplete}
        />,
      );

      fireEvent.click(await screen.findByText("trigger-success"));

      const alert = screen.getByRole("alert", { hidden: true });
      await waitFor(() => expect(alert).toHaveTextContent(heading));
      expect(alert).toHaveTextContent(copy);
      expect(alert).toHaveTextContent(/Do not try another payment/i);
      expect(alert).not.toHaveTextContent("private provider or database detail");
      expect(onPaymentComplete).not.toHaveBeenCalled();
      expect(screen.queryByText("payment-form")).toBeNull();
      expect(screen.getByText("Payment successful!")).not.toBeNull();
      await expectRecoveryAlertToHoldFocus(alert);
    },
  );

  it.each([
    ["refunded", { status: "CANCELLED" }],
    ["status", { refunded: false }],
  ])(
    "does not invent capacity-cancellation recovery without %s",
    async (_missingFact, partialFacts) => {
      const onPaymentComplete = vi.fn();

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ clientSecret: "cs_test" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            error: "unrecognised recovery",
            ...partialFacts,
          }),
        });

      render(
        <BookingPaymentWrapper
          bookingId="booking-1"
          amountCents={12500}
          paymentMode="payment"
          returnUrl="http://localhost/bookings/booking-1"
          onPaymentComplete={onPaymentComplete}
        />,
      );

      fireEvent.click(await screen.findByText("trigger-success"));

      await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("alert", { hidden: true }).textContent).toBe("");
      expect(screen.queryByText(/refund needs attention/i)).toBeNull();
    },
  );
});
