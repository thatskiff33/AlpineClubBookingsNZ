// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ONBOARDING_CONFIRMED_EVENT } from "@/lib/member-onboarding-events";

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

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: () => null,
}));

vi.mock("@/components/guest-form", () => ({
  GuestForm: () => null,
}));

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import BookPage from "@/app/(authenticated)/book/page";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

// Family payloads before and after the member confirms their details in the
// onboarding wizard: the same self member flips from blocked to bookable.
const blockedSelf = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT",
  relationship: "self",
  canLogin: true,
  canBeBooked: false,
  missingFields: [],
};

function stubFetch() {
  let familyCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      familyCalls += 1;
      return jsonResponse({
        familyMembers: [
          familyCalls === 1 ? blockedSelf : { ...blockedSelf, canBeBooked: true },
        ],
      });
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
    if (u.includes("/api/member/subscription-status")) {
      return jsonResponse({
        status: "PAID",
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
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

describe("booking wizard family refetch after onboarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("re-enables the member's quick-add without a reload once onboarding completes", async () => {
    const fetchMock = stubFetch();
    render(<BookPage />);

    // The onboarding wizard (layout overlay) has not run yet: the cached
    // family list marks the member as not bookable.
    const familyUrl = (u: unknown) => String(u).includes("/api/members/family");
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(1)
    );

    // Completing the wizard dispatches the confirmation event; the page must
    // refetch instead of serving the stale blocked entry.
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(2)
    );
  });

  it("stops listening after unmount", async () => {
    const fetchMock = stubFetch();
    const { unmount } = render(<BookPage />);
    const familyUrl = (u: unknown) => String(u).includes("/api/members/family");
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(1)
    );

    unmount();
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });

    expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(1);
  });
});
