// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PaymentForm from "@/components/stripe/PaymentForm";

const confirmPayment = vi.fn();

vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

describe("PaymentForm reports a `processing` confirmation (#4955)", () => {
  beforeEach(() => {
    confirmPayment.mockReset();
    confirmPayment.mockResolvedValue({ paymentIntent: { id: "pi_pending", status: "processing" } });
  });

  it("tells the parent which intent is processing, and not that it succeeded", async () => {
    const onSuccess = vi.fn();
    const onProcessing = vi.fn();
    render(
      <PaymentForm amountCents={12500} returnUrl="http://localhost/return" onSuccess={onSuccess} onProcessing={onProcessing} onError={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pay Now" }));

    await waitFor(() => expect(onProcessing).toHaveBeenCalledWith("pi_pending"));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText("Payment successful!")).toBeNull();
  });

  it("returns to an idle form for a caller that does not listen for it", async () => {
    const onSuccess = vi.fn();
    render(<PaymentForm amountCents={12500} returnUrl="http://localhost/return" onSuccess={onSuccess} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay Now" }));

    await waitFor(() => expect((screen.getByRole("button", { name: "Pay Now" }) as HTMLButtonElement).disabled).toBe(false));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
