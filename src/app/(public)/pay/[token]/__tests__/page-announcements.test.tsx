// @vitest-environment jsdom

// #4949: every outcome on the pay-link page is announced — loading and the
// post-card check through status regions, a failed card start or fresh-link
// request through a recovery alert that takes focus, and the fresh-link
// confirmation through a status region mounted before the request.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "public-token" }),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeName: "Test Lodge" }),
}));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: ({ onSuccess }: { onSuccess?: (paymentIntentId: string) => void }) => (
    <button type="button" onClick={() => onSuccess?.("pi_paid")}>
      trigger-card-success
    </button>
  ),
}));

let resolveCardCheck: (outcome: unknown) => void = () => undefined;
vi.mock("../card-success-check", () => ({
  checkCardSuccess: () =>
    new Promise((resolve) => {
      resolveCardCheck = resolve;
    }),
}));

import PayByLinkPage from "../page";

const payableContext = {
  state: "payable",
  narrative: { state: "payable", headline: "Payment due", message: "Payment is due.", nextStep: "Pay now." },
  firstName: "Riley",
  payable: {
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guestCount: 1,
    status: "CONFIRMED",
    amountCents: 12500,
    internetBankingReference: null,
    cardPaymentAvailable: true,
    expiresAt: "2026-09-10T00:00:00.000Z",
  },
  canRequestFreshLink: false,
};

const expiredContext = {
  ...payableContext,
  state: "expired_payable",
  narrative: { state: "expired_payable", headline: "Link expired", message: "This link has expired.", nextStep: "Request a fresh payment link below." },
  payable: undefined,
  canRequestFreshLink: true,
};

type Route = { ok: boolean; status?: number; body: unknown };

function installFetch(routes: Record<string, Route | Promise<Route>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/booking-messages") {
        return { ok: true, json: async () => ({ messages: {} }) } as Response;
      }
      const route = routes[url];
      if (!route) throw new Error(`Unexpected request: ${url}`);
      const { ok, status = ok ? 200 : 500, body } = await route;
      return { ok, status, json: async () => body } as Response;
    }) as typeof fetch,
  );
}

async function press(button: HTMLElement) {
  button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pay-link page announces its outcomes (#4949)", () => {
  it("says it is loading through a status region", async () => {
    let finishLoading: (route: Route) => void = () => undefined;
    installFetch({
      "/api/pay/public-token": new Promise<Route>((resolve) => {
        finishLoading = resolve;
      }),
    });
    render(<PayByLinkPage />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    await act(async () => {
      finishLoading({ ok: true, body: payableContext });
    });
    expect(await screen.findByRole("button", { name: "Pay by card" })).toBeInTheDocument();
  });

  it("puts a failed card start in a recovery alert, which takes focus", async () => {
    installFetch({
      "/api/pay/public-token": { ok: true, body: payableContext },
      "/api/pay/public-token/payment-intent": {
        ok: false,
        status: 500,
        body: { error: "Card payments are unavailable right now." },
      },
    });
    render(<PayByLinkPage />);
    await press(await screen.findByRole("button", { name: "Pay by card" }));

    const alert = document.getElementById("payment-link-intent-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Card payments are unavailable right now.");
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("announces the post-card check through a status region mounted before it", async () => {
    installFetch({
      "/api/pay/public-token": { ok: true, body: payableContext },
      "/api/pay/public-token/payment-intent": {
        ok: true,
        body: { clientSecret: "pi_secret" },
      },
    });
    render(<PayByLinkPage />);
    await screen.findByRole("button", { name: "Pay by card" });
    const status = document.getElementById("payment-link-check-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("");

    await press(screen.getByRole("button", { name: "Pay by card" }));
    await press(screen.getByRole("button", { name: "trigger-card-success" }));

    expect(document.getElementById("payment-link-check-status")).toBe(status);
    expect(status).toHaveTextContent("Checking your payment...");
    await act(async () => {
      resolveCardCheck({ kind: "paid", context: null });
    });
    expect(await screen.findByText("Payment received")).toBeInTheDocument();
  });

  it("puts a failed fresh-link request in a recovery alert, which takes focus", async () => {
    installFetch({
      "/api/pay/public-token": { ok: true, body: expiredContext },
      "/api/pay/public-token/refresh": {
        ok: false,
        status: 429,
        body: { error: "Too many requests. Try again in a minute." },
      },
    });
    render(<PayByLinkPage />);
    await screen.findByRole("button", { name: "Email me a new link" });
    const alert = document.getElementById("payment-link-refresh-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("");

    await press(screen.getByRole("button", { name: "Email me a new link" }));

    expect(alert).toHaveTextContent("Too many requests. Try again in a minute.");
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("confirms a fresh link through a status region mounted before the request", async () => {
    installFetch({
      "/api/pay/public-token": { ok: true, body: expiredContext },
      "/api/pay/public-token/refresh": { ok: true, body: { emailed: true } },
    });
    render(<PayByLinkPage />);
    const button = await screen.findByRole("button", { name: "Email me a new link" });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await press(button);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "We've emailed you a fresh payment link. Please check your inbox.",
    );
  });
});

