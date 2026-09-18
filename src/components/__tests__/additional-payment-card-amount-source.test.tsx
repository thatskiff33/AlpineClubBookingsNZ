// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * The Stripe surface is stubbed down to what this test is about: WHICH client
 * secret the form is bound to, and WHICH amount sits beside it. The real
 * `<Elements>` needs a live publishable key and the Stripe script, neither of
 * which belongs in a unit test, and neither of which is the subject.
 */
vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({
    clientSecret,
    children,
  }: {
    clientSecret: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="elements" data-client-secret={clientSecret}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: ({ amountCents }: { amountCents: number }) => (
    <button data-testid="pay-button">Pay {amountCents}</button>
  ),
}));

import { AdditionalPaymentCard } from "@/components/additional-payment-card";

/*
  #3340 acceptance criterion 4 — THE RENDERED AMOUNT AND THE CONFIRMED INTENT ARE
  THE SAME INTENT'S.

  What happened before: the card fetched its client secret in an effect keyed on
  `[bookingId]` alone and displayed the amount from its SERVER PROP. A second
  booking edit re-rendered the page with a new prop while the browser kept the
  FIRST edit's secret, so the button read "Total: $300" and Stripe charged $65
  against the superseded intent. Two sources for one figure is the whole defect,
  so the fix is structural: both come from the secret response.

  Frozen clock inherited; nothing here reads a date.
*/

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function secretResponse(body: {
  clientSecret: string;
  amountCents: number;
  paymentIntentId: string;
}) {
  return { ok: true, json: async () => body };
}

describe("AdditionalPaymentCard amount source", () => {
  it("renders the amount the secret response carries, not the server prop", async () => {
    fetchMock.mockResolvedValue(
      secretResponse({
        clientSecret: "pi_new_secret",
        amountCents: 36500,
        paymentIntentId: "pi_new",
      }),
    );

    // The prop deliberately DISAGREES with the response. Before #3340 the prop
    // is what a member read.
    render(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={30000} />,
    );

    await waitFor(() => expect(screen.getByTestId("elements")).toBeVisible());
    expect(screen.getByTestId("pay-button")).toHaveTextContent("Pay 36500");
    expect(screen.getByText(/\$365\.00/)).toBeVisible();
    expect(screen.queryByText(/\$300\.00/)).toBeNull();
  });

  it("re-fetches and rebinds when the ask changes between renders", async () => {
    fetchMock.mockResolvedValueOnce(
      secretResponse({
        clientSecret: "pi_first_secret",
        amountCents: 6500,
        paymentIntentId: "pi_first",
      }),
    );

    const view = render(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={6500} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("elements")).toHaveAttribute(
        "data-client-secret",
        "pi_first_secret",
      ),
    );
    expect(screen.getByTestId("pay-button")).toHaveTextContent("Pay 6500");

    // A second edit lands. The server prop moves, which is the signal the effect
    // watches; the new response brings both the new secret and the new amount.
    fetchMock.mockResolvedValueOnce(
      secretResponse({
        clientSecret: "pi_second_secret",
        amountCents: 36500,
        paymentIntentId: "pi_second",
      }),
    );
    view.rerender(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={36500} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("elements")).toHaveAttribute(
        "data-client-secret",
        "pi_second_secret",
      ),
    );
    // The figure moved WITH the secret, never ahead of it.
    expect(screen.getByTestId("pay-button")).toHaveTextContent("Pay 36500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers no payment form at all when the secret cannot be refreshed", async () => {
    fetchMock.mockResolvedValueOnce(
      secretResponse({
        clientSecret: "pi_first_secret",
        amountCents: 6500,
        paymentIntentId: "pi_first",
      }),
    );
    const view = render(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={6500} />,
    );
    await waitFor(() => expect(screen.getByTestId("elements")).toBeVisible());

    // The replacing intent exists, so the route refuses the stale one. The card
    // must drop the old binding rather than go on offering it.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "No pending additional payment" }),
    });
    view.rerender(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={36500} />,
    );

    await waitFor(() =>
      expect(screen.getByText("No pending additional payment")).toBeVisible(),
    );
    expect(screen.queryByTestId("elements")).toBeNull();
    expect(screen.queryByTestId("pay-button")).toBeNull();
  });

  /*
    #3340 fix round — WHAT THE MEMBER SEES WHILE THE REFETCH IS IN FLIGHT.

    `setLoading(true)` alone left `clientSecret` and `askAmountCents` holding the
    PREVIOUS edit's values, and the render gates do not consult `loading`. So
    between a second edit's re-render and its response the member saw the old
    amount above a mounted, interactive PaymentElement bound to the intent that
    edit had just cancelled: bounded, because the confirm fails and no money
    moves, but it is precisely the state this change exists to remove, and the
    error path already cleared them.
  */
  it("drops the previous binding the moment a refetch starts", async () => {
    fetchMock.mockResolvedValueOnce(
      secretResponse({
        clientSecret: "pi_first_secret",
        amountCents: 6500,
        paymentIntentId: "pi_first",
      }),
    );
    const view = render(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={6500} />,
    );
    await waitFor(() => expect(screen.getByTestId("elements")).toBeVisible());

    // A response that never settles: the card is left in exactly the in-flight
    // state the member would see.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={36500} />,
    );

    await waitFor(() => expect(screen.queryByTestId("elements")).toBeNull());
    expect(screen.queryByTestId("pay-button")).toBeNull();
    // …and no figure at all, rather than the superseded one.
    expect(screen.queryByText(/\$65\.00/)).toBeNull();
  });

  /*
    #3340 fix round (money lens F10) — THE EXPLANATION SURVIVES A FAILED FETCH.

    The sentence naming the amount is gated on the RESPONSE's figure, so a 404 -
    the state a failed mint leaves behind - showed a bare red error where the
    explanation used to be, and a member had no idea what the card was for. The
    fallback names the SERVER's figure and says so; it is safe precisely because
    there is no intent here for it to disagree with.
  */
  it("still explains itself when the secret fetch fails outright", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "No pending additional payment" }),
    });

    render(
      <AdditionalPaymentCard bookingId="booking_1" additionalAmountCents={36500} />,
    );

    await waitFor(() =>
      expect(screen.getByText("No pending additional payment")).toBeVisible(),
    );
    expect(screen.getByText(/according to our records/)).toBeVisible();
    expect(screen.getByText(/\$365\.00/)).toBeVisible();
    // Still no instrument: an explanation is not an offer to charge.
    expect(screen.queryByTestId("elements")).toBeNull();
  });
});
