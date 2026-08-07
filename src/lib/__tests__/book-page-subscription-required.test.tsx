// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestData } from "@/components/guest-form";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

// The calendar and guest form have their own tests; stub them with buttons
// that drive the wizard the same way a member would.
vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    onDateSelect,
  }: {
    onDateSelect: (ci: string, co: string) => void;
  }) => (
    <button onClick={() => onDateSelect("2026-07-10", "2026-07-12")}>
      pick test dates
    </button>
  ),
}));

vi.mock("@/components/guest-form", () => ({
  GuestForm: ({
    onGuestsChange,
  }: {
    onGuestsChange: (guests: GuestData[]) => void;
  }) => (
    <button
      onClick={() =>
        onGuestsChange([
          {
            firstName: "Jo",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "member-1",
          },
        ])
      }
    >
      add test guest
    </button>
  ),
}));

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import BookPage from "@/app/(authenticated)/book/page";

const SUBSCRIPTION_INVOICE_URL =
  "https://invoices.xero.example/pay/subscription-abc123";
const SUBSCRIPTION_INVOICE_NUMBER = "INV-SUB-2026-001";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

// Mirrors the booking route's SUBSCRIPTION_REQUIRED shape (#32): the POST to
// /api/bookings fails with the code + invoice pointers the wizard maps through
// getBookingErrorPaymentTargets into a "Pay Your Subscription" link.
function stubFetch() {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({
        guests: [
          { ageTier: "ADULT", isMember: true, nights: 2, priceCents: 4000 },
        ],
        totalPriceCents: 4000,
      });
    }
    if (u.includes("/api/bookings") && init?.method === "POST") {
      return jsonResponse(
        {
          error: "Your subscription for the 2026 season is unpaid.",
          code: "SUBSCRIPTION_REQUIRED",
          invoiceUrl: SUBSCRIPTION_INVOICE_URL,
          invoiceNumber: SUBSCRIPTION_INVOICE_NUMBER,
        },
        false,
      );
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
    if (u.includes("/api/availability/check")) {
      return jsonResponse({ minAvailable: 10, nightDetails: [] });
    }
    if (u.includes("/api/booking-policies/check")) {
      return jsonResponse({ valid: true });
    }
    if (u.includes("/api/member/subscription-status")) {
      // PAID keeps the top-of-page subscription banner (which renders its own
      // identical "Pay Your Subscription" link) hidden, so the assertion below
      // is unambiguous about which link it is checking.
      return jsonResponse({
        status: "PAID",
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
    }
    if (u.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [] });
    }
    if (u.includes("/api/booking-messages")) {
      return jsonResponse({ messages: {} });
    }
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: false, rooms: [] });
    }
    if (u.includes("/api/work-parties/active")) {
      return jsonResponse({ events: [] });
    }
    if (u.includes("/api/promo-codes/available")) {
      return jsonResponse([]);
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function submitBookingThroughWizard() {
  render(<BookPage />);
  fireEvent.click(await screen.findByText("pick test dates"));
  fireEvent.click(await screen.findByText("add test guest"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // Money is owed on the quote, so the review submit CTA reads
  // "Continue to Payment" (#1063); clicking it POSTs to /api/bookings.
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue to Payment" }),
  );
}

describe("booking wizard subscription-required payment link", () => {
  beforeEach(() => {
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a Pay Your Subscription link to the returned invoice URL when the booking POST returns SUBSCRIPTION_REQUIRED", async () => {
    stubFetch();
    await submitBookingThroughWizard();

    const payLink = await screen.findByRole("link", {
      name: "Pay Your Subscription",
    });
    expect(payLink.getAttribute("href")).toBe(SUBSCRIPTION_INVOICE_URL);

    // The member is not redirected: the booking was rejected, so the wizard
    // stays put and surfaces the payment link instead.
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it("does not redirect when the subscription block is shown", async () => {
    stubFetch();
    await submitBookingThroughWizard();

    await screen.findByRole("link", { name: "Pay Your Subscription" });
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});
