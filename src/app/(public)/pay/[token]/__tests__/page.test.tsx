// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import PayByLinkPage from "../page";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
} from "@/lib/payment-recovery-contract";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

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
  default: () => <div>card-entry-form</div>,
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

describe("the public payment page survives a payload that omits its dates", () => {
  /*
    THE GUARD THAT WAS HALF THERE (CT-4, #2870 fix round).

    Every date on this page is rendered through a helper whose own docblock says
    the reason it never throws: "a public token landing page with no runtime
    schema check on the payload". That premise is the world where a field can be
    absent — and the first version of the helper called `parseInstant(value)`,
    which does `value.trim()` BEFORE any nullish check. So `formatStayDay(null)`
    threw a `TypeError` out of the very guard written to prevent a throw, and an
    unhandled throw in a client render replaces the whole page with an error
    boundary. A payer with a link in their hand gets a blank screen instead of
    the amount, the reference and the card form.

    MUTATION-VERIFIED: remove the `typeof value !== "string"` arm from
    `formatStayDay` (or from `formatLinkExpiry`) and this case goes red with
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
        <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>
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
