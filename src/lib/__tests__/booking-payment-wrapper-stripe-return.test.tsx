// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";
import { PAYMENT_PROCESSING_MESSAGE } from "@/lib/payment-recovery-contract";

const fetchMock = vi.fn();
const formProps = vi.fn();

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: function MockPaymentForm(props: { returnUrl: string; onProcessing?: (id: string) => void }) {
    formProps(props);
    return (
      <div>
        <div>payment-form</div>
        <button type="button" onClick={() => props.onProcessing?.("pi_inpage")}>trigger-processing</button>
      </div>
    );
  },
}));

vi.mock("@/components/stripe/SetupForm", () => ({
  default: ({ returnUrl }: { returnUrl: string }) => <div data-testid="setup-return">{returnUrl}</div>,
}));

function returnTo(status: string, surface = "booking") {
  window.history.replaceState(
    null,
    "",
    `/bookings/booking-1?stripe_return=${surface}&payment_intent=pi_ret&payment_intent_client_secret=pi_ret_secret_x&redirect_status=${status}`,
  );
}

function renderWrapper(onPaymentComplete = vi.fn(), paymentMode: "payment" | "setup" = "payment") {
  // React strict mode runs the mount effect twice: the return is still asked about once.
  render(
    <BookingPaymentWrapper bookingId="booking-1" amountCents={12500} paymentMode={paymentMode} onPaymentComplete={onPaymentComplete} />,
    { reactStrictMode: true },
  );
  return onPaymentComplete;
}

const confirmCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/confirm-payment"));

describe("BookingPaymentWrapper Stripe redirect return (ALP-569)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    window.history.replaceState(null, "", "/bookings/booking-1");
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("names the booking surface in the card form's return_url", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "cs_test" }) });
    renderWrapper();
    await screen.findByText("payment-form");
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ returnUrl: "http://localhost:3000/bookings/booking-1?stripe_return=booking" }),
    );
  });

  it("asks the confirm route about a succeeded return, once, and completes only on its answer", async () => {
    returnTo("succeeded");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const onPaymentComplete = renderWrapper();
    expect(screen.getByText("Checking your payment...")).toBeInTheDocument();
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(confirmCalls()).toHaveLength(1);
    expect(JSON.parse(confirmCalls()[0][1].body)).toEqual({ paymentIntentId: "pi_ret" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("create-payment-intent"))).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("never calls a refused succeeded return received: the door offers the form again", async () => {
    returnTo("succeeded");
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/confirm-payment")
        ? { ok: false, status: 400, json: async () => ({ error: "Payment has not succeeded" }) }
        : { ok: true, json: async () => ({ clientSecret: "cs_test", paymentIntentId: "pi_ret" }) },
    );
    const onPaymentComplete = renderWrapper();
    expect(await screen.findByText("payment-form")).toBeInTheDocument();
    expect(screen.queryByText("Payment received - check booking status")).toBeNull();
    expect(screen.queryByText("Payment being processed")).toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
  });

  it("asks the door when the confirm route gives no answer, and completes on its already-paid", async () => {
    returnTo("succeeded");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/confirm-payment")) throw new Error("network");
      return { ok: true, json: async () => ({ alreadyPaid: true }) };
    });
    const onPaymentComplete = renderWrapper();
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(confirmCalls()).toHaveLength(1);
  });

  it("shows a recovery answer to a succeeded return in place of the check", async () => {
    returnTo("succeeded");
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "x", status: "CANCELLED", refunded: false }),
    });
    const onPaymentComplete = renderWrapper();
    expect(await screen.findByText("Booking cancelled - refund needs attention")).toBeInTheDocument();
    expect(screen.queryByText("Checking your payment...")).toBeNull();
    expect(onPaymentComplete).not.toHaveBeenCalled();
  });

  it("says a processing return is being processed when the door hands the same intent back", async () => {
    returnTo("processing");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "cs_ret", paymentIntentId: "pi_ret" }) });
    const onPaymentComplete = renderWrapper();
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent(PAYMENT_PROCESSING_MESSAGE);
    expect(screen.queryByText("payment-form")).toBeNull();
    expect(confirmCalls()).toHaveLength(0);
    expect(onPaymentComplete).not.toHaveBeenCalled();
  });

  it("completes a processing return the door reports as already paid", async () => {
    returnTo("processing");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ alreadyPaid: true }) });
    const onPaymentComplete = renderWrapper();
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalled());
  });

  it("re-asks the door after an in-page processing result and never re-shows the form for it", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ clientSecret: "cs_1", paymentIntentId: "pi_inpage" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "cs_1", paymentIntentId: "pi_inpage" }) });
    renderWrapper();
    fireEvent.click(await screen.findByText("trigger-processing"));
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expect(screen.queryByText("payment-form")).toBeNull();
  });

  it("offers the form again with a notice after a failed return", async () => {
    returnTo("failed");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "cs_test" }) });
    renderWrapper();
    expect(await screen.findByText("payment-form")).toBeInTheDocument();
    expect(screen.getByText(/Your payment did not go through/)).toBeInTheDocument();
    expect(confirmCalls()).toHaveLength(0);
  });

  it("leaves another surface's return alone", async () => {
    returnTo("succeeded", "additional-payment");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "cs_test" }) });
    renderWrapper();
    expect(await screen.findByText("payment-form")).toBeInTheDocument();
    expect(confirmCalls()).toHaveLength(0);
    expect(window.location.search).toContain("payment_intent=pi_ret");
  });

  it("ignores a return when saving a card", async () => {
    returnTo("succeeded");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ clientSecret: "seti_secret" }) });
    renderWrapper(vi.fn(), "setup");
    expect(await screen.findByTestId("setup-return")).toHaveTextContent("http://localhost:3000/bookings/booking-1");
    expect(confirmCalls()).toHaveLength(0);
  });
});
