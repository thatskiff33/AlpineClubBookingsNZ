// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// The actual AdditionalPaymentCard owns the fetch and display projection. Only
// Stripe presentation is replaced; these tests use no provider or secret keys.
vi.mock("@/components/stripe/StripeProvider", () => ({ default: ({ clientSecret, children }: { clientSecret: string; children: React.ReactNode }) => <div data-testid="elements" data-client-secret={clientSecret}>{children}</div> }));
vi.mock("@/components/stripe/PaymentForm", () => ({ default: ({ amountCents }: { amountCents: number }) => <button>Pay {amountCents}</button> }));
import { BookingOutstandingPayments } from "../_components/booking-outstanding-payments";
import type { BookingOutstandingPaymentView } from "@/lib/booking-outstanding-payment";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { requireClubTimeZone } from "@/lib/club-time";
import { ADDITIONAL_PAYMENT_ALREADY_MADE_BODY, PAYMENT_PROCESSING_BODY } from "@/lib/payment-recovery-contract";

const fetchMock = vi.fn();
const base: Extract<BookingOutstandingPaymentView, { kind: "ready" }> = {
  kind: "ready", audience: "owner", bookingStatus: "COMPLETED", revision: "revision", cardDueCents: 30000,
  cardRevision: "card-first", incomplete: false, nextCursor: null, observations: [],
};
const response = (amountCents: number, clientSecret = "synthetic_secret") => ({ ok: true, json: async () => ({ clientSecret, amountCents, paymentIntentId: "synthetic_intent" }) });
function mount(initial = base) {
  return render(<BookingOutstandingPayments bookingId="booking" initial={initial} format={CLUB_FORMAT_TEST} zone={requireClubTimeZone("Pacific/Auckland")} />);
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("composed card and outstanding-banner authority (INV-ADDPAY-023)", () => {
  it("shows no mirror amount while loading, then uses the same intent amount in banner and form", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount();
    expect(screen.getByText("Checking current additional card payment details…")).toBeVisible();
    expect(screen.queryByText(/\$300\.00/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay the additional amount/ })).not.toBeInTheDocument();
    resolve(response(36500));
    await screen.findByRole("button", { name: "Pay 36500" });
    expect(await screen.findByText(/You have an additional card payment/)).toHaveTextContent("$365.00");
    expect(screen.queryByText(/\$300\.00/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pay the additional amount by card below." })).toHaveAttribute("href", "#additional-payment");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([ADDITIONAL_PAYMENT_ALREADY_MADE_BODY, PAYMENT_PROCESSING_BODY])("matches the secret route's $code outcome without another card demand", async (body) => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => body });
    mount();
    await waitFor(() => expect(screen.getAllByText(body.error)).toHaveLength(2));
    expect(screen.queryByText(/You have an additional card payment/)).not.toBeInTheDocument();
    expect(screen.queryByText("Additional payment outstanding")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$300\.00/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pay / })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay the additional amount/ })).not.toBeInTheDocument();
  });
  it("drops the old projection while a continuation discovers a replacement ask", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    let replacementStart: string | null = null;
    fetchMock.mockResolvedValueOnce(response(36500, "first_secret"));
    mount({ ...base, nextCursor: "signed" });
    await screen.findByRole("button", { name: "Pay 36500" });
    await screen.findByText(/You have an additional card payment/);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...base, cardDueCents: 40000, cardRevision: "card-replacement" }) });
    fetchMock.mockImplementationOnce(() => { replacementStart = document.body.textContent; return new Promise((done) => { resolve = done; }); });
    fireEvent.click(screen.getByRole("button", { name: "Check more invoices" }));
    await screen.findByText("Checking current additional card payment details…");
    // The "Checking…" text can render before the continuation fetch fires, so
    // wait for the fetch (which captures the page) rather than racing it.
    await waitFor(() => expect(replacementStart).not.toBeNull());
    expect(replacementStart).not.toContain("$365.00");
    expect(screen.queryByRole("button", { name: /^Pay / })).not.toBeInTheDocument();
    expect(screen.queryByText(/\$(300|365|400)\.00/)).not.toBeInTheDocument();
    resolve(response(45000, "replacement_secret"));
    await screen.findByRole("button", { name: "Pay 45000" });
    expect(await screen.findByText(/You have an additional card payment/)).toHaveTextContent("$450.00");
    expect(screen.getByTestId("elements")).toHaveAttribute("data-client-secret", "replacement_secret");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each(["failed mint", "network"])("qualifies the local record when current intent details are unavailable (%s)", async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValue(new Error("Unavailable"));
    else fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "No pending additional payment" }) });
    mount();
    const summary = await screen.findByText(/Current payment details could not be confirmed/);
    expect(summary).toHaveTextContent("Our records list an additional card amount of $300.00");
    expect(screen.getByText(/according to our records/)).toHaveTextContent("$300.00");
    expect(screen.queryByText(/You have an additional card payment/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("elements")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay the additional amount/ })).not.toBeInTheDocument();
  });
  it("keeps officers read-only and qualifies records without an owner-secret fetch", () => {
    mount({ ...base, audience: "officer" });
    expect(screen.getByText(/Our records list/)).toHaveTextContent("$300.00");
    expect(screen.getByText(/The member checks the current amount/)).toBeVisible();
    expect(screen.queryByText("Additional Payment Required")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retains the last intent-observed amount as historical after continuation failure", async () => {
    fetchMock.mockResolvedValueOnce(response(36500));
    mount({ ...base, nextCursor: "signed" });
    await screen.findByRole("button", { name: "Pay 36500" });
    await screen.findByText(/You have an additional card payment/);
    fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Check more invoices" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("last checked additional card amount was $365.00");
    expect(alert).not.toHaveTextContent("$300.00");
    expect(screen.queryByRole("button", { name: /^Pay / })).not.toBeInTheDocument();
  });
});
