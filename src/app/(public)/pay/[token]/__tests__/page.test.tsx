// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, ClubFormatTestProvider } from "@/lib/__tests__/support/club-time-render";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import PayByLinkPage from "../page";
import {
  BOOKING_ALREADY_PAID_CODE,
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_PROCESSING_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
  PREVIOUS_PAYMENT_REFUNDING_NOTICE,
  SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY,
  SUPERSEDED_CARD_PAYMENT_REFUNDING_LINK_MESSAGE,
} from "@/lib/payment-recovery-contract";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { expectOneLevelOneHeading } from "@/lib/__tests__/support/heading-outline";

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "public-token" }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeName: "Test Lodge" }),
}));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({
    children,
    clientSecret,
  }: {
    children: ReactNode;
    clientSecret: string;
  }) => (
    <div data-testid="stripe-provider" data-client-secret={clientSecret}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: ({ onSuccess, onProcessing }: { onSuccess?: (paymentIntentId: string) => void; onProcessing?: (paymentIntentId: string) => void }) => (
    <>
      <div>card-entry-form</div>
      <button type="button" onClick={() => onProcessing?.("pi_processing")}>trigger-card-processing</button>
      <button type="button" onClick={() => onSuccess?.("pi_paid")}>
        trigger-card-success
      </button>
    </>
  ),
}));

const payableContext = {
  state: "payable",
  narrative: {
    state: "payable",
    headline: "Payment due",
    message: "Payment is due.",
    nextStep: "Pay now.",
  },
  firstName: "Riley",
  payable: {
    checkIn: "2026-09-01T00:00:00.000Z",
    checkOut: "2026-09-03T00:00:00.000Z",
    guestCount: 1,
    status: "CONFIRMED",
    amountCents: 12500,
    internetBankingReference: "BOOK-123",
    cardPaymentAvailable: true,
    expiresAt: "2026-09-10T00:00:00.000Z",
  },
  canRequestFreshLink: false,
};

function installFetch(recoveryBody: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pay/public-token" && !init?.method) {
        return {
          ok: true,
          json: async () => payableContext,
        } as Response;
      }
      if (url === "/api/booking-messages") {
        return {
          ok: true,
          json: async () => ({ messages: {} }),
        } as Response;
      }
      if (
        url === "/api/pay/public-token/payment-intent" &&
        init?.method === "POST"
      ) {
        return {
          ok: false,
          status: 409,
          json: async () => recoveryBody,
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch,
  );
}

function installFreshRepaymentFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pay/public-token" && !init?.method) {
        return {
          ok: true,
          json: async () => payableContext,
        } as Response;
      }
      if (url === "/api/booking-messages") {
        return {
          ok: true,
          json: async () => ({ messages: {} }),
        } as Response;
      }
      if (
        url === "/api/pay/public-token/payment-intent" &&
        init?.method === "POST"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            clientSecret: "secret_repay",
            paymentIntentId: "pi_repay",
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch,
  );
}

/**
 * Each POST to the link's payment-intent route answers the next body, in order;
 * each GET of the link's context the next context (the last one repeats).
 */
function installIntentSequence(
  answers: Array<{ status: number; body: Record<string, unknown> }>,
  contexts: Array<Record<string, unknown>> = [payableContext],
) {
  const queue = [...answers];
  const contextQueue = [...contexts];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/pay/public-token" && !init?.method) {
      const context = contextQueue.length > 1 ? contextQueue.shift()! : contextQueue[0]!;
      return { ok: true, json: async () => context } as Response;
    }
    if (url === "/api/booking-messages") return { ok: true, json: async () => ({ messages: {} }) } as Response;
    if (url === "/api/pay/public-token/payment-intent" && init?.method === "POST") {
      const next = queue.shift();
      if (!next) throw new Error("no more payment-intent answers");
      return { ok: next.status < 400, status: next.status, json: async () => next.body } as Response;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as typeof fetch);
  return fetchMock;
}

describe("#4300 (INV-PAY-138): a superseded earlier payment on the /pay link", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  it("says the earlier payment is going back, beside the fresh payment form", async () => {
    installIntentSequence([{ status: 200, body: { clientSecret: "secret_repay", paymentIntentId: "pi_repay", previousPaymentRefunding: true } }]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

    expect(await screen.findByText(PREVIOUS_PAYMENT_REFUNDING_NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId("stripe-provider")).toHaveAttribute("data-client-secret", "secret_repay");
  });

  it("a stale tab's card success is checked with the server, and a superseded payment never reads 'confirmed'", async () => {
    const fetchMock = installIntentSequence([
      { status: 200, body: { clientSecret: "secret_stale", paymentIntentId: "pi_stale" } },
      { status: 200, body: { clientSecret: "secret_repay", paymentIntentId: "pi_repay", previousPaymentRefunding: true } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText(PREVIOUS_PAYMENT_REFUNDING_NOTICE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("stripe-provider")).toHaveAttribute("data-client-secret", "secret_repay"));
    expect(document.body.textContent).not.toMatch(/is confirmed|payment is complete/i);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/payment-intent"))).toHaveLength(2);
  });

  it("a card success the server settled reads as complete", async () => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
      { status: 200, body: { alreadyPaid: true } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText(/your payment is complete/i)).toBeInTheDocument();
  });

  it.each([
    ["410 - the webhook settled the booking first, so the link reads as used", 410, { error: "This payment link has already been used." }],
    ["429 - the link's rate limit", 429, { error: "Too many requests" }],
  ])("after a card success, a %s, ends in 'check booking status', never the pay buttons", async (_name, status, body) => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
      { status, body },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText("Payment received - check booking status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
    expect(document.body.textContent).not.toContain("BOOK-123");
    expect(document.body.textContent).not.toContain("already been used");
  });

  it("after a card success, the server's coded already-paid 410 reads as complete (#4955)", async () => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
      { status: 410, body: { error: "This payment link has already been used.", code: BOOKING_ALREADY_PAID_CODE } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText(/your payment is complete/i)).toBeInTheDocument();
    expect(screen.queryByText("Payment received - check booking status")).toBeNull();
  });

  it("after a card success the capacity-cancel 410 variant ends the same way", async () => {
    installIntentSequence(
      [
        { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
        { status: 410, body: { error: "This booking is no longer payable." } },
      ],
      [payableContext, { ...payableContext, state: "cancelled" }],
    );
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText("Payment received - check booking status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
  });

  it("after a card success, the link's own context saying paid is the answer, with no second intent request", async () => {
    const paidContext = {
      ...payableContext,
      state: "paid",
      narrative: { state: "paid", headline: "Payment received", message: "Thanks Riley — we've received your payment.", nextStep: "Nothing more to do." },
    };
    const fetchMock = installIntentSequence(
      [{ status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } }],
      [payableContext, paidContext],
    );
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText("Payment received")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/payment-intent"))).toHaveLength(1);
  });

  it("on a fresh secret after a card success, the amount shown is the new one (100 -> 120)", async () => {
    const at100 = { ...payableContext, payable: { ...payableContext.payable, amountCents: 10000 } };
    const at120 = { ...payableContext, payable: { ...payableContext.payable, amountCents: 12000 } };
    installIntentSequence(
      [
        { status: 200, body: { clientSecret: "secret_stale", paymentIntentId: "pi_stale" } },
        { status: 200, body: { clientSecret: "secret_new", paymentIntentId: "pi_new", previousPaymentRefunding: true } },
      ],
      [at100, at120],
    );
    render(<PayByLinkPage />);
    expect(await screen.findByText("Amount due: $100.00")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    await waitFor(() => expect(screen.getByTestId("stripe-provider")).toHaveAttribute("data-client-secret", "secret_new"));
    expect(screen.getByText("Amount due: $120.00")).toBeInTheDocument();
    expect(screen.queryByText("Amount due: $100.00")).toBeNull();
  });

  it("the going-back notice is the server's word alone: a different fresh intent without the flag shows none", async () => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_stale", paymentIntentId: "pi_stale" } },
      { status: 200, body: { clientSecret: "secret_new", paymentIntentId: "pi_new" } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    await waitFor(() => expect(screen.getByTestId("stripe-provider")).toHaveAttribute("data-client-secret", "secret_new"));
    expect(screen.getByTestId("previous-payment-refunding").textContent).toBe("");
  });

  it("tells the route which intent was just paid", async () => {
    const fetchMock = installIntentSequence([
      { status: 200, body: { clientSecret: "secret_stale", paymentIntentId: "pi_stale" } },
      { status: 200, body: { alreadyPaid: true } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));
    await screen.findByText(/your payment is complete/i);
    const second = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/payment-intent"))[1]!;
    expect(JSON.parse(String((second[1] as RequestInit).body))).toEqual({ paidPaymentIntentId: "pi_paid" });
  });

  it("a 410 because the webhook settled between the two reads shows the paid page, read once more", async () => {
    const paidContext = {
      ...payableContext,
      state: "paid",
      narrative: { state: "paid", headline: "Payment received", message: "Thanks Riley — we've received your payment.", nextStep: "Nothing more to do." },
    };
    installIntentSequence(
      [
        { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
        { status: 410, body: { error: "This payment link has already been used." } },
      ],
      [payableContext, payableContext, paidContext],
    );
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText("Payment received")).toBeInTheDocument();
    expect(screen.queryByText("Payment received - check booking status")).toBeNull();
  });

  it("the paid intent handed back as if unpaid is never a fresh form: 'check booking status'", async () => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } },
      { status: 200, body: { clientSecret: "secret_paid", paymentIntentId: "pi_paid" } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-success" }));

    expect(await screen.findByText("Payment received - check booking status")).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-provider")).toBeNull();
  });

  it("keeps the notice's live region mounted, and fills it only when the earlier payment is going back", async () => {
    installIntentSequence([{ status: 200, body: { clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" } }]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    await screen.findByText("card-entry-form");
    const region = screen.getByTestId("previous-payment-refunding");
    expect(region).toHaveAttribute("role", "status");
    expect(region.textContent).toBe("");
  });

  it("a capture the settle refused shows the refunding notice with a reload, and no form", async () => {
    installIntentSequence([{ status: 409, body: { ...SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY, error: "raw server text" } }]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

    expect(await screen.findByText(SUPERSEDED_CARD_PAYMENT_REFUNDING_LINK_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("Card payment being returned")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("raw server text");
    expect(screen.queryByText("card-entry-form")).toBeNull();
    expect(screen.getByRole("button", { name: "Reload payment status", hidden: true })).toBeInTheDocument();
  });
});

describe("public payment-link captured-payment recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("mounts card entry with only the fresh repayment secret and does not claim success on initialization", async () => {
    installFreshRepaymentFetch();
    render(<PayByLinkPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

    const provider = await screen.findByTestId("stripe-provider");
    expect(provider).toHaveAttribute("data-client-secret", "secret_repay");
    expect(document.body.innerHTML).not.toContain(
      "secret_refunded_must_not_be_reused",
    );
    expect(screen.queryByText(/payment successful/i)).toBeNull();
    expect(screen.getByText("card-entry-form")).toBeInTheDocument();
  });

  it.each([
    {
      name: "participant finalisation",
      body: {
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        error: "private participant detail",
        paymentReceived: true,
        finalisationPending: true,
      },
      heading: "Payment received - finalisation pending",
      message: /card payment was received, but booking finalisation is still pending/i,
    },
    {
      name: "ordinary post-capture status",
      body: {
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        error: "private database detail",
      },
      heading: "Payment received - check booking status",
      message: /could not confirm the booking status/i,
    },
    {
      name: "unclassified existing transaction",
      body: {
        ...EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
        error: "private ledger detail",
      },
      heading: "Card transaction found - check payment status",
      message: /could not confirm whether it is still paid or has been refunded/i,
    },
    {
      // #3567: an intent in the club's previous currency is still processing.
      name: "earlier payment still processing",
      body: PAYMENT_PROCESSING_BODY,
      heading: "Payment being processed",
      message: /This payment is being processed\. Refresh the page in a minute/,
    },
  ])(
    "suppresses every payment action for $name recovery",
    async ({ body, heading, message }) => {
      installFetch(body);
      render(<PayByLinkPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

      const alert = document.getElementById("payment-link-recovery-error");
      await waitFor(() => expect(alert).toHaveTextContent(heading));
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("private");
      expect(
        screen.queryByRole("button", { name: "Pay by card" }),
      ).toBeNull();
      expect(screen.queryByText("Or pay by internet banking")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Reload payment status" }),
      ).not.toBeNull();
      await expectRecoveryAlertToHoldFocus(alert);
    },
  );
});

// #2919: the "your booking is confirmed" line named the CLUB DEFAULT lodge,
// because the payment-link context carried no lodge at all. It must name the
// lodge this booking is actually at.
describe("public payment-link confirmation names the booking's lodge", () => {
  function installAlreadyPaidFetch(context: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pay/public-token" && !init?.method) {
          return { ok: true, json: async () => context } as Response;
        }
        if (url === "/api/booking-messages") {
          return { ok: true, json: async () => ({ messages: {} }) } as Response;
        }
        if (
          url === "/api/pay/public-token/payment-intent" &&
          init?.method === "POST"
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ alreadyPaid: true }),
          } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch,
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("names the booking's own lodge rather than the club default", async () => {
    installAlreadyPaidFetch({ ...payableContext, lodgeName: "Second Lodge" });
    render(<PayByLinkPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

    expect(
      await screen.findByText(/Your booking with Second Lodge is confirmed/i),
    ).toBeInTheDocument();
    // The mocked club identity ("Test Lodge") is the default-lodge name this
    // surface used to print for every booking.
    expect(screen.queryByText(/Test Lodge is confirmed/i)).toBeNull();
  });

  // INV-CAP-039: the guest is shown which lodge the money is for BEFORE paying,
  // not only in the sentence after it.
  it("names the booking's own lodge on the payable card, above the dates", async () => {
    installAlreadyPaidFetch({ ...payableContext, lodgeName: "Second Lodge" });
    render(<PayByLinkPage />);

    const lodgeLine = await screen.findByText("Lodge: Second Lodge");
    expect(lodgeLine.nextElementSibling?.textContent).toMatch(/^Dates:/);
    expect(screen.queryByText("Lodge: Test Lodge")).toBeNull();
  });

  it("leaves the lodge line out rather than naming the club default when the context carries none", async () => {
    installAlreadyPaidFetch(payableContext);
    render(<PayByLinkPage />);

    expect(await screen.findByText(/Amount due:/)).toBeInTheDocument();
    expect(screen.queryByText(/^Lodge:/)).toBeNull();
  });

  // #2919 review: this page printed the internet-banking body with only
  // {{paymentReference}} substituted, so an operator's {{CLUB_LODGE_NAME}}
  // reached the member as literal braces on the most-read surface of the four.
  it("fills in every merge field in an edited internet-banking message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pay/public-token" && !init?.method) {
          return {
            ok: true,
            json: async () => ({ ...payableContext, lodgeName: "Second Lodge" }),
          } as Response;
        }
        if (url === "/api/booking-messages") {
          return {
            ok: true,
            json: async () => ({
              messages: {
                "paymentLink.internetBanking.description":
                  "Transfer to {{CLUB_LODGE_NAME}} ({{CLUB_NAME}}) using {{paymentReference}}. Help: {{SUPPORT_EMAIL}}.",
              },
              tokens: {
                CLUB_NAME: "Alpine Club",
                // The club default, which is not this booking's lodge.
                CLUB_LODGE_NAME: "Test Lodge",
                SUPPORT_EMAIL: "support@example.test",
                BASE_URL: "https://example.test",
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch,
    );

    render(<PayByLinkPage />);

    expect(
      await screen.findByText(
        "Transfer to Second Lodge (Alpine Club) using BOOK-123. Help: support@example.test.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("{{");
  });

  it("blanks a merge field it has no value for rather than showing braces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pay/public-token" && !init?.method) {
          return { ok: true, json: async () => payableContext } as Response;
        }
        // The endpoint answered with bodies but no token values at all (an older
        // response, or a failed settings read).
        if (url === "/api/booking-messages") {
          return {
            ok: true,
            json: async () => ({
              messages: {
                "paymentLink.internetBanking.description":
                  "Pay {{CLUB_LODGE_NAME}} with {{paymentReference}}.",
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch,
    );

    render(<PayByLinkPage />);

    expect(
      await screen.findByText(/Or pay by internet banking/),
    ).toBeInTheDocument();
    // The blank is the contract: an unsupplied token renders as nothing (hence
    // the double space), never as `{{CLUB_LODGE_NAME}}` in the member's face.
    expect(document.body.textContent).toContain("Pay  with BOOK-123.");
    expect(document.body.textContent).not.toContain("{{");
  });

  it("falls back to the club lodge name when the context carries none", async () => {
    installAlreadyPaidFetch(payableContext);
    render(<PayByLinkPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

    expect(
      await screen.findByText(/Your booking with Test Lodge is confirmed/i),
    ).toBeInTheDocument();
  });
});

// #3638 delta D4: a booking switched to Internet Banking has an emailed
// invoice; its link page must not offer a card button the card door would
// refuse, and must show the bank-transfer details as the way to pay.
describe("the public payment page on a booking switched to Internet Banking (#3638)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("offers no card button and shows the internet banking details instead", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pay/public-token" && !init?.method) {
        return {
          ok: true,
          json: async () => ({
            ...payableContext,
            payable: { ...payableContext.payable, cardPaymentAvailable: false },
          }),
        } as Response;
      }
      if (url === "/api/booking-messages") {
        return { ok: true, json: async () => ({ messages: {} }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    render(<PayByLinkPage />);

    expect(
      await screen.findByText(/being paid by internet banking, so it can.t be paid by\s+card here/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
    expect(screen.getByText("Pay by internet banking")).toBeInTheDocument();
    expect(screen.getAllByText("BOOK-123").length).toBeGreaterThan(0);
    // Nothing tried to start a card payment.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/payment-intent")),
    ).toBe(false);
  });
});

describe("the public payment page survives a payload that omits its dates", () => {
  /*
    THE GUARD THAT WAS HALF THERE (CT-4, #2870 fix round).

    Every date on this page is rendered through a helper whose own docblock says
    the reason it never throws: "a public token landing page with no runtime
    schema check on the payload". That premise is the world where a field can be
    absent — and the first version of the helper called `parseInstant(value)`,
    which does `value.trim()` BEFORE any nullish check. So the old local `formatStayDay(null)`
    threw a `TypeError` out of the very guard written to prevent a throw, and an
    unhandled throw in a client render replaces the whole page with an error
    boundary. A payer with a link in their hand gets a blank screen instead of
    the amount, the reference and the card form.

    Stay dates now go through the kernel's `formatStayDateOrNull`, which answers
    `null` for an absent value (#3511). MUTATION-VERIFIED: remove the
    `typeof value !== "string"` arm from `formatLinkExpiry` and this case goes red with
    "Cannot read properties of null (reading 'trim')".
  */
  const contextWithNoDates = {
    ...payableContext,
    payable: {
      ...payableContext.payable,
      checkIn: null,
      checkOut: null,
      expiresAt: null,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pay/public-token" && !init?.method) {
          return { ok: true, json: async () => contextWithNoDates } as Response;
        }
        if (url === "/api/booking-messages") {
          return { ok: true, json: async () => ({ messages: {} }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch,
    );
  });

  it("still renders the amount and the card, with the dates simply blank", async () => {
    render(<PayByLinkPage />);

    expect(await screen.findByText("Complete Your Payment")).toBeInTheDocument();
    // The part the payer actually needs is still on screen…
    expect(screen.getByText(/Amount due/)).toBeInTheDocument();
    // …and the dates degrade to nothing rather than to "1 Jan 1970", which is
    // what the pre-CT-4 spelling rendered for a missing value: wrong, plausible,
    // and impossible to tell from a real stay.
    expect(screen.queryByText(/1 Jan 1970/)).toBeNull();
    expect(screen.getByText(/^Dates:/)).toBeInTheDocument();
  });
});

describe("the public payment page says when the link dies, in the CLUB's time", () => {
  /*
    THE ONE LINE ON THIS PAGE THAT NEEDS A ZONE, AND IT WAS ASSERTED NOWHERE
    (#2870 fix round).

    MEASURED before this block existed. Three mutants of `formatLinkExpiry`, run
    against this file and its whole `vitest related` set — the only suite in the
    repository that reaches the function at all:

      * `return club.instantDate(instant)` -> `return
        formatClubDate(calendarDateOfDateOnlyInstant(instant))`, i.e. read the
        moment as if it were a lodge night: SURVIVED 9/9;
      * `return "MUTANT-EXPIRY-NEVER-ASSERTED"`: SURVIVED 9/9;
      * `useClubTime()` ignoring the provider and binding `APP_TIME_ZONE`:
        SURVIVED 9/9.

    The fixture already carried `expiresAt`. It was rendered and never read back,
    on the only `useClubTime()`-bearing line of an UNAUTHENTICATED payment page.

    THE PAIR IS WHAT KILLS THE THIRD MUTANT. One provider zone cannot: the shared
    harness's default is `Pacific/Auckland`, deliberately equal to what
    `APP_TIME_ZONE` resolves to under test, so a page that read the environment
    gives the identical answer. The same fixture instant is rendered under two
    persisted zones and required to produce DIFFERENT text; an implementation with
    one answer to give fails a half whatever `TZ` this machine has.

    The expected strings come from raw `Intl` rather than from the kernel: a
    recomputation through the code under test would prove only that it is
    deterministic. It also sidesteps the narrow no-break space `en-NZ` puts before
    "pm", which is why nothing below writes a time out by hand.
  */
  const CLUB_ZONE = "America/Denver";
  const LEGACY_REFERENCE_ZONE = "Pacific/Auckland";

  /** The `expiresAt` the fixture at the top of this file carries. */
  const EXPIRES_AT = new Date(payableContext.payable.expiresAt);

  const deadlineIn = (zone: string) =>
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(EXPIRES_AT);

  function renderInClubZone(zone: string) {
    return render(<PayByLinkPage />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubFormatTestProvider>
          <ClubTimeProvider zone={zone} locale={CLUB_FORMAT_TEST.locale}>{children}</ClubTimeProvider>
        </ClubFormatTestProvider>
      ),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/pay/public-token" && !init?.method) {
          return { ok: true, json: async () => payableContext } as Response;
        }
        if (url === "/api/booking-messages") {
          return { ok: true, json: async () => ({ messages: {} }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch,
    );
  });

  it("the two clubs really read this moment as different deadlines", () => {
    // PREMISE AS AN ANSWER. If a runtime or a fixture edit ever put the two
    // clubs on the same reading, this fails here rather than leaving the pair
    // below asserting the same thing twice. 2026-09-10T00:00:00Z is midday on
    // the 10th in Auckland and the evening of the NINTH in Denver, so the day
    // moves as well as the time.
    expect(deadlineIn(LEGACY_REFERENCE_ZONE)).not.toBe(deadlineIn(CLUB_ZONE));
    expect(deadlineIn(LEGACY_REFERENCE_ZONE)).toMatch(/^10 Sept 2026, 12:00\spm$/);
    expect(deadlineIn(CLUB_ZONE)).toMatch(/^9 Sept 2026, 6:00\spm$/);
  });

  it("spells the deadline in a behind-UTC club's own time", async () => {
    renderInClubZone(CLUB_ZONE);

    expect(await screen.findByText("Complete Your Payment")).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      `This payment link expires on ${deadlineIn(CLUB_ZONE)}.`,
    );
    // Not the zone the environment resolves to, which is the answer a page that
    // ignored the provider would give…
    expect(document.body.textContent).not.toContain(
      deadlineIn(LEGACY_REFERENCE_ZONE),
    );
    // …and not the bare civil day, which is what this line used to show. Two
    // lines above it the stay reads "Dates: 1 Sept 2026 to 3 Sept 2026", so a
    // second bare day read as a restatement of the stay while naming a day the
    // link did not die on — the mint takes its boundary from the environment's
    // zone, so on this deployment the link lasts most of a day longer than the
    // old label claimed.
    expect(document.body.textContent).not.toContain(
      "This payment link expires on 9 Sept 2026.",
    );
  });

  it("spells the SAME deadline differently for a club ahead of UTC", async () => {
    renderInClubZone(LEGACY_REFERENCE_ZONE);

    expect(await screen.findByText("Complete Your Payment")).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      `This payment link expires on ${deadlineIn(LEGACY_REFERENCE_ZONE)}.`,
    );
    expect(document.body.textContent).not.toContain(deadlineIn(CLUB_ZONE));
  });

  it("keeps the stay dates zone-free while the deadline follows the club", async () => {
    /*
      The two kinds on one render, which is the distinction this epic exists to
      make. `checkIn`/`checkOut` are `@db.Date` lodge nights encoded at UTC
      midnight and must read as the days they are for EVERY club; `expiresAt` is
      a moment and must follow the club. Under Denver — behind Greenwich, where
      the encoding reads as the previous evening — a page that pushed the stay
      dates through the club's zone would name 31 August and 2 September.
    */
    renderInClubZone(CLUB_ZONE);

    expect(await screen.findByText("Complete Your Payment")).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      "Dates: 1 Sept 2026 to 3 Sept 2026",
    );
    expect(document.body.textContent).not.toContain("31 Aug 2026");
    // And the deadline on that same render did move, so this case cannot be
    // satisfied by a page that ignores zones altogether.
    expect(document.body.textContent).toContain(deadlineIn(CLUB_ZONE));
  });
});


describe("the /pay link has exactly one h1 in every state (#4951)", () => {
  // Reached from a booking email, this page is one card; its title is the
  // page's only heading. Before #4951 a screen reader's heading list here was
  // empty, and the loading state had no title at all.
  function installContext(response: { ok: boolean; body: Record<string, unknown> }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/pay/public-token") {
          return { ok: response.ok, json: async () => response.body } as Response;
        }
        if (url === "/api/booking-messages") {
          return { ok: true, json: async () => ({ messages: {} }) } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch,
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})) as typeof fetch);
    render(<PayByLinkPage />);
    expectOneLevelOneHeading("Payment Link");
  });

  it("a link that will not load", async () => {
    installContext({ ok: false, body: { error: "This payment link is not valid." } });
    render(<PayByLinkPage />);
    await screen.findByText("This payment link is not valid.");
    expectOneLevelOneHeading("Payment Link");
  });

  it("payable", async () => {
    installContext({ ok: true, body: payableContext });
    render(<PayByLinkPage />);
    await screen.findByRole("button", { name: "Pay by card" });
    expectOneLevelOneHeading("Complete Your Payment");
  });

  it("a narrative state (paid)", async () => {
    installContext({
      ok: true,
      body: {
        ...payableContext,
        state: "paid",
        narrative: {
          state: "paid",
          headline: "Payment received",
          message: "Thanks.",
          nextStep: "Nothing more to do.",
        },
        payable: undefined,
      },
    });
    render(<PayByLinkPage />);
    await screen.findByText("Nothing more to do.");
    expectOneLevelOneHeading("Payment received");
  });
});

describe("the /pay link keeps its one h1 on the redirect-return screens (#4951, #4955)", () => {
  // Both screens replace the whole page after a payer comes back from their
  // bank, so each must still hand a screen reader exactly one level-1 heading.
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("while the server is asked what the payment did", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=succeeded");
    const fetchMock = installIntentSequence([]);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return new Promise<Response>(() => {});
      return { ok: true, json: async () => String(input).endsWith("booking-messages") ? {} : payableContext } as Response;
    });
    render(<PayByLinkPage />);
    expect(await screen.findByText("Checking your payment...")).toBeInTheDocument();
    expectOneLevelOneHeading("Payment Link");
  });

  it("on the answer card shown when the link expired while the payer was at their bank", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=processing");
    installIntentSequence(
      [{ status: 200, body: { clientSecret: "secret_test", paymentIntentId: "pi_test" } }],
      [{ ...payableContext, payable: null, canRequestFreshLink: true }],
    );
    render(<PayByLinkPage />);
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expectOneLevelOneHeading("Your Payment");
  });
});

describe("#4955: Stripe returns to the payment link", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it.each(["succeeded", "processing"])("checks a %s return once under StrictMode, hiding pay options until the server answers", async (status) => {
    window.history.replaceState({ keep: true }, "", `/pay/public-token?keep=yes&payment_intent=pi_test&redirect_status=${status}&payment_intent_client_secret=private_secret#details`);
    let finish!: (response: Response) => void;
    const fetchMock = installIntentSequence([]);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finish = resolve; });
      return { ok: true, json: async () => String(input).endsWith("booking-messages") ? {} : payableContext } as Response;
    });
    render(<StrictMode><PayByLinkPage /></StrictMode>);
    expect(screen.getByText("Checking your payment...")).toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
    expect(screen.queryByText(/Amount due/)).toBeNull();
    expect(document.body.textContent).not.toContain("private_secret");
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#details");
    expect(window.history.state).toEqual({ keep: true });
    finish({ ok: true, json: async () => ({ alreadyPaid: true }) } as Response);
    expect(await screen.findByText(/your payment is complete/i)).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ paidPaymentIntentId: "pi_test" });
  });

  it("shows failed or cancelled payments beside the normal pay options without checking", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=failed&payment_intent_client_secret=private_secret");
    const fetchMock = installIntentSequence([]);
    render(<PayByLinkPage />);
    expect(await screen.findByRole("button", { name: "Pay by card" })).toBeInTheDocument();
    expect(screen.getByText(/Your payment did not go through/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("clears that notice once the payer starts another attempt", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=failed");
    // The new attempt fails too: its own error stands alone, not under the old notice.
    installIntentSequence([{ status: 500, body: { error: "Unable to start the payment. Please try again." } }]);
    render(<PayByLinkPage />);
    expect(await screen.findByText(/Your payment did not go through/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pay by card" }));
    expect(await screen.findByText("Unable to start the payment. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Your payment did not go through/)).toBeNull();
  });

  /*
    The webhook settled the booking before the payer came back: the server
    refuses the intent as already paid, and the context carries the server's
    paid narrative. That narrative is the answer - the amount received - not
    "could not confirm".
  */
  it("shows the server's paid narrative when the booking was settled before the return", async () => {
    const paidBeforeReturn = {
      ...payableContext,
      state: "paid",
      narrative: {
        state: "paid",
        headline: "Payment received",
        message: "Thanks Riley - we've received your payment of $125.00 on 20 Jun 2026.",
        nextStep: "Nothing more to do - we'll see you at the lodge.",
      },
      payable: null,
    };
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=succeeded");
    installIntentSequence(
      [{ status: 410, body: { error: "This payment link has already been used.", code: BOOKING_ALREADY_PAID_CODE } }],
      [paidBeforeReturn],
    );
    render(<PayByLinkPage />);
    expect(await screen.findByText(/we've received your payment of \$125\.00/)).toBeInTheDocument();
    expect(screen.queryByText("Payment received - check booking status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
  });

  it.each(["", "bad", "pi_", "pi_%3Cscript%3E", "pi_bad%2Fpath"])("ignores an absent or malformed intent id (%s)", async (id) => {
    window.history.replaceState(null, "", `?redirect_status=succeeded&payment_intent=${id}&payment_intent_client_secret=private_secret`);
    const fetchMock = installIntentSequence([]);
    render(<PayByLinkPage />);
    expect(await screen.findByRole("button", { name: "Pay by card" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(document.body.textContent).not.toContain("private_secret");
    expect(window.location.search).toBe("");
  });

  // The server's real answer for a current intent still processing: the same
  // intent handed back unpaid (it refuses with PAYMENT_PROCESSING only for a
  // superseded or old-currency one).
  const stillProcessing = { status: 200, body: { clientSecret: "secret_test", paymentIntentId: "pi_test" } };

  it("says a processing return is being processed - not received, and not paid", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=processing");
    installIntentSequence([stillProcessing]);
    render(<PayByLinkPage />);
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expect(screen.queryByText(/Payment received/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
    expect(screen.queryByText(/payment is complete/i)).toBeNull();
  });

  it("keeps the #4300 wording when a succeeded return is handed back unpaid", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=succeeded");
    installIntentSequence([stillProcessing]);
    render(<PayByLinkPage />);
    expect(await screen.findByText("Payment received - check booking status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
  });

  it("shows the paid page even when the page's own load of the link failed", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=succeeded");
    const fetchMock = installIntentSequence([{ status: 200, body: { alreadyPaid: true } }]);
    const implementation = fetchMock.getMockImplementation()!;
    let first = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/pay/public-token" && !init?.method && first) {
        first = false;
        return { ok: false, status: 429, json: async () => ({ error: "Too many requests" }) } as Response;
      }
      return implementation(input, init);
    });
    render(<PayByLinkPage />);
    expect(await screen.findByText(/your payment is complete/i)).toBeInTheDocument();
    expect(screen.queryByText("Too many requests")).toBeNull();
  });

  it("answers about the payment before offering a new link when the link expired meanwhile", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=processing");
    installIntentSequence([stillProcessing], [{ ...payableContext, payable: null, canRequestFreshLink: true }]);
    render(<PayByLinkPage />);
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
  });

  it("uses the refreshed amount for a fresh form even if the mount fetch arrives last", async () => {
    window.history.replaceState(null, "", "?payment_intent=pi_test&redirect_status=succeeded");
    let finishMount!: (response: Response) => void;
    const fetchMock = installIntentSequence([{ status: 200, body: { clientSecret: "secret_new", paymentIntentId: "pi_new", previousPaymentRefunding: true } }],
      [{ ...payableContext, payable: { ...payableContext.payable, amountCents: 15000 } }]);
    const implementation = fetchMock.getMockImplementation()!;
    let first = true;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/pay/public-token" && first) {
        first = false;
        return new Promise<Response>((resolve) => { finishMount = resolve; });
      }
      return implementation(input, init);
    });
    render(<PayByLinkPage />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    finishMount({ ok: true, json: async () => payableContext } as Response);
    expect(await screen.findByText("Amount due: $150.00")).toBeInTheDocument();
    expect(await screen.findByText(PREVIOUS_PAYMENT_REFUNDING_NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId("stripe-provider")).toHaveAttribute("data-client-secret", "secret_new");
    expect(screen.queryByText(/payment is complete/i)).toBeNull();
  });

  it("checks an in-page processing result through the same server path", async () => {
    installIntentSequence([
      { status: 200, body: { clientSecret: "secret_pending", paymentIntentId: "pi_processing" } },
      { status: 200, body: { clientSecret: "secret_pending", paymentIntentId: "pi_processing" } },
    ]);
    render(<PayByLinkPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));
    fireEvent.click(await screen.findByRole("button", { name: "trigger-card-processing" }));
    expect(await screen.findByText("Payment being processed")).toBeInTheDocument();
    expect(screen.queryByText(/Payment received/)).toBeNull();
    expect(screen.queryByText("card-entry-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay by card" })).toBeNull();
  });
});
