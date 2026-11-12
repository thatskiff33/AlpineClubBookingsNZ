// @vitest-environment jsdom

// #4949: a declined card, a failed card save and a successful payment are
// announced. The decline lands in a recovery alert that was mounted empty and
// takes focus; the success fills a status region that was mounted with the form.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const stripe = {
  confirmPayment: vi.fn(),
  confirmSetup: vi.fn(),
};

vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => stripe,
  useElements: () => ({}),
}));

import PaymentForm from "@/components/stripe/PaymentForm";
import SetupForm from "@/components/stripe/SetupForm";

const noop = () => undefined;
const DECLINE = "Your card was declined.";

beforeEach(() => {
  stripe.confirmPayment.mockReset();
  stripe.confirmSetup.mockReset();
});

async function submit(name: RegExp) {
  const button = screen.getByRole("button", { name });
  button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("PaymentForm announcements (#4949)", () => {
  it("puts a declined card in the booking's recovery alert, which takes focus", async () => {
    stripe.confirmPayment.mockResolvedValue({ error: { message: DECLINE } });
    render(
      <PaymentForm
        bookingId="bk_1"
        amountCents={12500}
        returnUrl="http://localhost/return"
        onSuccess={noop}
        onError={noop}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "payment-form-bk_1-error");
    expect(alert).toHaveTextContent("");

    await submit(/Pay Now/);

    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent(DECLINE);
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("announces a successful payment through the status region mounted with the form", async () => {
    stripe.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_1", status: "succeeded" },
    });
    render(
      <PaymentForm
        amountCents={12500}
        returnUrl="http://localhost/return"
        onSuccess={noop}
        onError={noop}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await submit(/Pay Now/);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "Payment successful!Your payment of $125.00 has been processed.",
    );
    expect(screen.queryByRole("button", { name: /Pay Now/ })).toBeNull();
  });

  it("gives two forms on one page distinct alert ids", () => {
    render(
      <>
        <PaymentForm amountCents={100} returnUrl="/r" onSuccess={noop} onError={noop} />
        <PaymentForm amountCents={200} returnUrl="/r" onSuccess={noop} onError={noop} />
      </>,
    );
    const [first, second] = screen.getAllByRole("alert");
    expect(first.id).not.toBe(second.id);
  });
});

describe("SetupForm announcements (#4949)", () => {
  it("puts a failed card save in a recovery alert, which takes focus", async () => {
    stripe.confirmSetup.mockResolvedValue({ error: { message: DECLINE } });
    render(<SetupForm returnUrl="http://localhost/return" onSuccess={noop} onError={noop} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("");

    await submit(/Save Card/);

    expect(alert).toHaveTextContent(DECLINE);
    await expectRecoveryAlertToHoldFocus(alert);
  });
});
