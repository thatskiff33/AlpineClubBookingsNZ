// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBookingBlockedBySubscription,
  readSubscriptionLockoutView,
} from "@/app/(authenticated)/book/_components/types";

// #4941. Under NON_MEMBER_PRICING the banner told an unpaid member they could
// book at non-member rates, while the Select Your Dates card below it still said
// "Booking is disabled until your subscription is paid." and drew no calendar:
// the wizard treated the FACT (unpaid) as the CONSEQUENCE (blocked). Only
// HARD_BLOCK — or a response too old to name its mode, which reads as
// HARD_BLOCK — stops an unpaid member picking dates.

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

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

vi.mock("@/components/guest-form", () => ({ GuestForm: () => null }));
vi.mock("@/components/promo-code-input", () => ({ PromoCodeInput: () => null }));
vi.mock("@/components/time-picker", () => ({ TimePicker: () => null }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import BookPage from "@/app/(authenticated)/book/page";

const BLOCKED_COPY = "Booking is disabled until your subscription is paid.";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/** Mount the wizard with one lodge and the given subscription-status answer. */
function renderWizard(subscription: Record<string, unknown> | "fetch-fails") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/member/subscription-status")) {
        if (subscription === "fetch-fails") return jsonResponse({}, false);
        return jsonResponse({
          seasonDisplay: "2026/2027",
          invoiceUrl: null,
          invoiceNumber: null,
          ...subscription,
        });
      }
      if (u.includes("/api/lodges")) {
        return jsonResponse({
          lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }],
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

/**
 * With no banner to wait for, wait for the subscription-status request itself
 * and flush its state update, so a calendar drawn before the answer arrived
 * cannot pass for one drawn after it.
 */
async function subscriptionStatusSettled() {
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) =>
          String(url).includes("/api/member/subscription-status"),
        ),
    ).toBe(true),
  );
  await act(async () => {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Select Your Dates follows the club's lockout mode (#4941)", () => {
  it.each(["UNPAID", "OVERDUE"])(
    "NON_MEMBER_PRICING lets a %s member pick a lodge and dates",
    async (status) => {
      renderWizard({ status, subscriptionLockoutMode: "NON_MEMBER_PRICING" });

      // The banner still says the subscription is unpaid, and drawing it
      // proves the mode has arrived before the calendar is checked.
      expect(
        await screen.findByTestId("subscription-unpaid-banner"),
      ).toHaveTextContent("season is unpaid");
      expect(await screen.findByTestId("booking-calendar")).toBeInTheDocument();
      expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument();
    },
  );

  it("NO_BLOCK lets an unpaid member pick dates", async () => {
    renderWizard({ status: "UNPAID", subscriptionLockoutMode: "NO_BLOCK" });

    await screen.findByTestId("subscription-unpaid-banner");
    expect(await screen.findByTestId("booking-calendar")).toBeInTheDocument();
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument();
  });

  it.each(["UNPAID", "OVERDUE"])(
    "HARD_BLOCK keeps a %s member off the calendar with today's wording",
    async (status) => {
      renderWizard({ status, subscriptionLockoutMode: "HARD_BLOCK" });

      expect(await screen.findByText(BLOCKED_COPY)).toBeInTheDocument();
      expect(screen.queryByTestId("booking-calendar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("member-lodge-select")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["omits the mode", {}],
    ["sends an unrecognised mode", { subscriptionLockoutMode: "SOMETHING_NEW" }],
  ])("still blocks an unpaid member when the response %s", async (_name, extra) => {
    renderWizard({ status: "UNPAID", ...extra });

    expect(await screen.findByText(BLOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByTestId("booking-calendar")).not.toBeInTheDocument();
  });

  it("a failed subscription-status fetch blocks nobody", async () => {
    renderWizard("fetch-fails");
    await subscriptionStatusSettled();

    expect(await screen.findByTestId("booking-calendar")).toBeInTheDocument();
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument();
  });

  it("HARD_BLOCK does not block a paid-up member", async () => {
    renderWizard({ status: "PAID", subscriptionLockoutMode: "HARD_BLOCK" });
    await subscriptionStatusSettled();

    expect(await screen.findByTestId("booking-calendar")).toBeInTheDocument();
  });
});

describe("isBookingBlockedBySubscription (#4941)", () => {
  const MODES = [
    ["NO_BLOCK", false],
    ["HARD_BLOCK", true],
    ["NON_MEMBER_PRICING", false],
    [undefined, true],
    ["SOMETHING_NEW", true],
  ] as const;

  it.each(
    MODES.flatMap(([mode, blocksUnpaid]) => [
      { mode, unpaid: true, blocked: blocksUnpaid },
      { mode, unpaid: false, blocked: false },
    ]),
  )("mode $mode, unpaid $unpaid → blocked $blocked", ({ mode, unpaid, blocked }) => {
    const lockout = readSubscriptionLockoutView({ subscriptionLockoutMode: mode });
    expect(isBookingBlockedBySubscription(unpaid, lockout)).toBe(blocked);
  });
});
