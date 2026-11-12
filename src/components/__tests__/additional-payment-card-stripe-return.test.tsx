// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const formProps = vi.fn();
vi.mock("@/components/stripe/PaymentForm", () => ({
  default: (props: { returnUrl: string; onProcessing?: (id: string) => void }) => {
    formProps(props);
    return <button type="button" onClick={() => props.onProcessing?.("pi_inpage")}>trigger-processing</button>;
  },
}));

import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { PAYMENT_PROCESSING_BODY, PAYMENT_PROCESSING_MESSAGE } from "@/lib/payment-recovery-contract";

const fetchMock = vi.fn();
const calls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const secret = { ok: true, json: async () => ({ clientSecret: "pi_a_secret", amountCents: 5000, paymentIntentId: "pi_a" }) };
const processing = {
  ok: false,
  status: 409,
  json: async () => PAYMENT_PROCESSING_BODY,
};

function returnTo(status: string, surface = "additional-payment") {
  window.history.replaceState(
    null,
    "",
    `/bookings/b1?stripe_return=${surface}&payment_intent=pi_ret&payment_intent_client_secret=s&redirect_status=${status}`,
  );
}

function renderCard() {
  render(<StrictMode><AdditionalPaymentCard bookingId="b1" additionalAmountCents={5000} /></StrictMode>);
}

describe("AdditionalPaymentCard Stripe redirect return (ALP-569)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/bookings/b1");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("names its surface in the form's return_url", async () => {
    fetchMock.mockResolvedValue(secret);
    renderCard();
    await screen.findByText("trigger-processing");
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ returnUrl: "http://localhost:3000/bookings/b1?stripe_return=additional-payment" }),
    );
  });

  it("confirms a succeeded return with the server before saying it is paid", async () => {
    returnTo("succeeded");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    renderCard();
    expect(await screen.findByText("Payment successful!")).toBeInTheDocument();
    expect(JSON.parse(calls("/confirm-modification-payment")[0][1].body)).toEqual({ paymentIntentId: "pi_ret" });
    expect(calls("/additional-payment-secret")).toHaveLength(0);
    expect(window.location.search).toBe("");
  });

  it("falls back to the door when the server does not confirm a succeeded return", async () => {
    returnTo("succeeded");
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/confirm-modification-payment") ? { ok: false, status: 409, json: async () => ({}) } : processing,
    );
    renderCard();
    expect(await screen.findByRole("status")).toHaveTextContent(PAYMENT_PROCESSING_MESSAGE);
    expect(screen.queryByText("Payment successful!")).toBeNull();
  });

  it("asks the door, not the confirm route, for a processing return", async () => {
    returnTo("processing");
    fetchMock.mockResolvedValue(processing);
    renderCard();
    expect(await screen.findByRole("status")).toHaveTextContent(PAYMENT_PROCESSING_MESSAGE);
    expect(calls("/confirm-modification-payment")).toHaveLength(0);
  });

  it("re-asks the door after an in-page processing result", async () => {
    fetchMock.mockResolvedValue(secret);
    renderCard();
    const pay = await screen.findByText("trigger-processing");
    const asked = calls("/additional-payment-secret").length;
    fetchMock.mockResolvedValue(processing);
    fireEvent.click(pay);
    await waitFor(() => expect(calls("/additional-payment-secret").length).toBe(asked + 1));
    expect(await screen.findByRole("status")).toHaveTextContent(PAYMENT_PROCESSING_MESSAGE);
    expect(screen.queryByText("trigger-processing")).toBeNull();
  });

  it("offers the form again with a notice after a failed return", async () => {
    returnTo("failed");
    fetchMock.mockResolvedValue(secret);
    renderCard();
    expect(await screen.findByText("trigger-processing")).toBeInTheDocument();
    expect(screen.getByText(/Your payment did not go through/)).toBeInTheDocument();
  });

  it("leaves the booking's own return alone", async () => {
    returnTo("succeeded", "booking");
    fetchMock.mockResolvedValue(secret);
    renderCard();
    await screen.findByText("trigger-processing");
    await waitFor(() => expect(calls("/confirm-modification-payment")).toHaveLength(0));
    expect(window.location.search).toContain("stripe_return=booking");
  });
});
