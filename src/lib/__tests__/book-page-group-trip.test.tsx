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

const toastMocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

import BookPage from "@/app/(authenticated)/book/page";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

function stubFetch(opts: {
  groupBookingsEnabled: boolean;
  groupCreateRejects?: boolean;
  groupCreateFails?: boolean;
}) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/api/group-bookings")) {
      if (opts.groupCreateRejects) {
        throw new Error("network down");
      }
      if (opts.groupCreateFails) {
        return jsonResponse({ error: "not in an openable state" }, false);
      }
      return jsonResponse({ code: "ABCD2345" });
    }
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({
        guests: [
          { ageTier: "ADULT", isMember: true, nights: 2, priceCents: 4000 },
        ],
        totalPriceCents: 4000,
      });
    }
    if (u.includes("/api/bookings") && init?.method === "POST") {
      return jsonResponse({ id: "booking-1", status: "PAYMENT_PENDING" });
    }
    if (u.includes("/api/payments/options")) {
      return jsonResponse({
        methods: {
          stripe: { enabled: true, default: true },
          internetBanking: { enabled: false },
        },
        groupBookingsEnabled: opts.groupBookingsEnabled,
      });
    }
    if (u.includes("/api/availability/check")) {
      return jsonResponse({ minAvailable: 10, nightDetails: [] });
    }
    if (u.includes("/api/booking-policies/check")) {
      return jsonResponse({ valid: true });
    }
    if (u.includes("/api/member/subscription-status")) {
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

async function advanceToGuestsStep() {
  render(<BookPage />);
  fireEvent.click(await screen.findByText("pick test dates"));
  await screen.findByText("add test guest");
}

async function advanceToReviewAndConfirm() {
  fireEvent.click(screen.getByText("add test guest"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // With money owed the submit CTA reads "Continue to Payment" (#1063) and
  // the card path stays in the wizard on an embedded payment step (#1084).
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue to Payment" }),
  );
  await screen.findByText("Complete Payment");
}

function groupCreateCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).includes("/api/group-bookings") &&
      (init as { method?: string } | undefined)?.method === "POST",
  );
}

describe("booking wizard group trip option", () => {
  beforeEach(() => {
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    toastMocks.info.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the group trip option when the module is off", async () => {
    stubFetch({ groupBookingsEnabled: false });
    await advanceToGuestsStep();

    expect(screen.queryByText("Make this a group trip")).toBeNull();
  });

  it("opens the group after booking creation with the chosen payment mode", async () => {
    const fetchMock = stubFetch({ groupBookingsEnabled: true });
    await advanceToGuestsStep();

    fireEvent.click(await screen.findByText("Make this a group trip"));
    fireEvent.click(
      screen.getByText("You pay for everyone (settle one combined bill)"),
    );
    await advanceToReviewAndConfirm();

    const calls = groupCreateCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0][1] as { body?: unknown })!.body))).toEqual({
      organiserBookingId: "booking-1",
      paymentMode: "ORGANISER_PAYS",
    });
    expect(toastMocks.info).not.toHaveBeenCalled();
  });

  it("does not open a group when the option is left off", async () => {
    const fetchMock = stubFetch({ groupBookingsEnabled: true });
    await advanceToGuestsStep();
    await advanceToReviewAndConfirm();

    expect(groupCreateCalls(fetchMock)).toHaveLength(0);
  });

  it("still redirects and toasts when group creation throws", async () => {
    stubFetch({ groupBookingsEnabled: true, groupCreateRejects: true });
    await advanceToGuestsStep();

    fireEvent.click(await screen.findByText("Make this a group trip"));
    await advanceToReviewAndConfirm();

    expect(toastMocks.info).toHaveBeenCalledOnce();
  });

  it("toasts when the booking can't anchor a group yet (e.g. PENDING hold)", async () => {
    stubFetch({ groupBookingsEnabled: true, groupCreateFails: true });
    await advanceToGuestsStep();

    fireEvent.click(await screen.findByText("Make this a group trip"));
    await advanceToReviewAndConfirm();

    expect(toastMocks.info).toHaveBeenCalledOnce();
  });
});
