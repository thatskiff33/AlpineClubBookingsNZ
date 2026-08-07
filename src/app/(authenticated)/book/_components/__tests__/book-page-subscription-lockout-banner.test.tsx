// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSubscriptionLockoutView } from "@/app/(authenticated)/book/_components/types";

// #2543, owner-side finding 19. The booking wizard's unpaid-subscription banner
// used to tell every member to "pay it before booking". That is only TRUE under
// the club's HARD_BLOCK lockout mode. Under NON_MEMBER_PRICING the member may
// book and is simply charged non-member rates; under NO_BLOCK the subscription
// does not gate booking at all. `GET /api/member/subscription-status` now returns
// `subscriptionLockoutMode` so the banner can say the true thing, and an absent
// or unrecognised mode falls back to HARD_BLOCK — the server's migration-safe
// default — so a stale cached response can never drop a warning that still holds.
//
// This file lives beside the wizard's own `_components` because the mode
// resolution it pins lives in `_components/types.ts`.

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

// #2562: the wizard reads `?replaceRequest=<id>` so a member can replace an open
// exception request from their own request list. Stubbed as an empty query here —
// these cases are not about that path.
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({ hasAdminAccess: () => false }));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: () => <div data-testid="booking-calendar" />,
}));

// The banner renders on the dates step, so the later wizard steps are inert here.
vi.mock("@/components/guest-form", () => ({ GuestForm: () => null }));

vi.mock("@/components/promo-code-input", () => ({ PromoCodeInput: () => null }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import BookPage from "@/app/(authenticated)/book/page";

const INVOICE_URL = "https://invoices.xero.example/pay/subscription-abc123";

// Deliberately not the real wording: the banner must render whatever the server
// sends, so a sentence the client could not have produced proves it is passing
// the string through rather than rebuilding it.
const SERVER_RATE_NOTICE =
  "Somebody on this booking has an unpaid 2026/2027 membership subscription, so member rates aren't available for their nights.";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/**
 * Mount the wizard with one `subscription-status` response.
 *
 * `subscription` is spread over the unpaid baseline, so a test states only the
 * field it is about — including omitting `subscriptionLockoutMode` entirely for
 * the older-cached-response case.
 */
function renderWizard(subscription: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/member/subscription-status")) {
        return jsonResponse({
          status: "UNPAID",
          seasonDisplay: "2026/2027",
          invoiceUrl: INVOICE_URL,
          invoiceNumber: "INV-SUB-2026-001",
          ...subscription,
        });
      }
      if (u.includes("/api/members/family")) {
        return jsonResponse({ familyMembers: [] });
      }
      if (u.includes("/api/booking-messages")) {
        return jsonResponse({ messages: {} });
      }
      if (u.includes("/api/payments/options")) {
        return jsonResponse({
          methods: {
            stripe: { enabled: true, default: true },
            internetBanking: { enabled: false },
          },
          groupBookingsEnabled: false,
        });
      }
      if (u.includes("/api/promo-codes/available")) {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    }),
  );
  render(<BookPage />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("booking wizard unpaid-subscription banner is lockout-mode aware (#2543)", () => {
  it("HARD_BLOCK keeps today's copy: pay the invoice before booking", async () => {
    renderWizard({ subscriptionLockoutMode: "HARD_BLOCK" });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).toHaveTextContent(
      "Use the payment link below to pay it before booking.",
    );
    // A live block on this booking, so it is announced assertively.
    expect(banner).toHaveAttribute("role", "alert");
    expect(
      screen.getByRole("link", { name: "Pay Your Subscription" }),
    ).toHaveAttribute("href", INVOICE_URL);
  });

  it("HARD_BLOCK with no invoice link keeps today's contact-the-club copy", async () => {
    renderWizard({
      subscriptionLockoutMode: "HARD_BLOCK",
      invoiceUrl: null,
      invoiceNumber: null,
    });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).toHaveTextContent("contact the club");
    expect(banner).toHaveTextContent("before booking.");
  });

  it("NON_MEMBER_PRICING drops 'before booking' and explains the reprice in the server's own words", async () => {
    renderWizard({
      subscriptionLockoutMode: "NON_MEMBER_PRICING",
      memberRateNotice: SERVER_RATE_NOTICE,
    });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    // The member CAN book, so no instruction to settle up first.
    expect(banner).not.toHaveTextContent(/before booking/i);
    expect(
      screen.getByTestId("subscription-non-member-pricing-notice"),
    ).toHaveTextContent(SERVER_RATE_NOTICE);
    // The plain statement of fact stays — the subscription really is unpaid.
    expect(banner).toHaveTextContent("season is unpaid");
    // And paying it is still offered, just not demanded.
    expect(
      screen.getByRole("link", { name: "Pay Your Subscription" }),
    ).toBeInTheDocument();
  });

  it("NON_MEMBER_PRICING invents nothing when the server sends no explanation", async () => {
    // An older cached response can carry the mode but not the sentence. The
    // banner says less rather than making up a replacement.
    renderWizard({ subscriptionLockoutMode: "NON_MEMBER_PRICING" });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).not.toHaveTextContent(/before booking/i);
    expect(
      screen.queryByTestId("subscription-non-member-pricing-notice"),
    ).not.toBeInTheDocument();
  });

  it("NO_BLOCK is neutral: no instruction, no reprice explanation, announced politely", async () => {
    renderWizard({ subscriptionLockoutMode: "NO_BLOCK" });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).not.toHaveTextContent(/before booking/i);
    expect(
      screen.queryByTestId("subscription-non-member-pricing-notice"),
    ).not.toBeInTheDocument();
    // Nothing is at stake for this booking, so it is a status rather than an
    // alert (the shared Alert's `info` variant).
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("season is unpaid");
  });

  it("falls back to HARD_BLOCK copy when the response omits the mode", async () => {
    renderWizard({});

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).toHaveTextContent(
      "Use the payment link below to pay it before booking.",
    );
    expect(banner).toHaveAttribute("role", "alert");
  });

  it("falls back to HARD_BLOCK copy on an unrecognised mode", async () => {
    renderWizard({ subscriptionLockoutMode: "SOMETHING_NEW" });

    const banner = await screen.findByTestId("subscription-unpaid-banner");
    expect(banner).toHaveTextContent(
      "Use the payment link below to pay it before booking.",
    );
  });
});

describe("readSubscriptionLockoutView (#2543)", () => {
  it("passes each recognised mode through", () => {
    for (const mode of ["NO_BLOCK", "HARD_BLOCK", "NON_MEMBER_PRICING"] as const) {
      expect(
        readSubscriptionLockoutView({ subscriptionLockoutMode: mode }).mode,
      ).toBe(mode);
    }
  });

  it("resolves absent, null, unknown and non-string modes to HARD_BLOCK", () => {
    // Failing the other way would tell a locked-out member they may book.
    expect(readSubscriptionLockoutView(null).mode).toBe("HARD_BLOCK");
    expect(readSubscriptionLockoutView(undefined).mode).toBe("HARD_BLOCK");
    expect(readSubscriptionLockoutView({}).mode).toBe("HARD_BLOCK");
    expect(
      readSubscriptionLockoutView({ subscriptionLockoutMode: null }).mode,
    ).toBe("HARD_BLOCK");
    expect(
      readSubscriptionLockoutView({ subscriptionLockoutMode: "no_block" }).mode,
    ).toBe("HARD_BLOCK");
    expect(
      readSubscriptionLockoutView({ subscriptionLockoutMode: 3 }).mode,
    ).toBe("HARD_BLOCK");
  });

  it("passes a member-rate sentence through untouched and nulls anything else", () => {
    expect(
      readSubscriptionLockoutView({ memberRateNotice: SERVER_RATE_NOTICE })
        .memberRateNotice,
    ).toBe(SERVER_RATE_NOTICE);
    expect(readSubscriptionLockoutView({}).memberRateNotice).toBeNull();
    expect(
      readSubscriptionLockoutView({ memberRateNotice: "" }).memberRateNotice,
    ).toBeNull();
    expect(
      readSubscriptionLockoutView({ memberRateNotice: 42 }).memberRateNotice,
    ).toBeNull();
  });
});
