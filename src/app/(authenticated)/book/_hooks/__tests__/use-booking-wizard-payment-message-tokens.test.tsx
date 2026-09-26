// @vitest-environment jsdom

// #2919 review. The wizard's three payment-method descriptions are operator-
// editable booking-message bodies, and every one of them declares every merge
// token as insertable. The wizard used to render them raw — `?? defaultBody` and
// nothing else — so an operator who wrote `{{CLUB_LODGE_NAME}}` into the
// Internet Banking wording put the literal characters `{{CLUB_LODGE_NAME}}` in
// front of the member, on the screen where they choose how to pay.
//
// These cases drive the real hook, so they cover the whole path: the endpoint's
// club-level token values, the substitution, and the lodge the member has
// actually selected winning over the club's default lodge.

import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
  hasAccessRole: () => true,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

// Two lodges, so "the lodge the member picked" is expressible at all (ADR-002).
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-a", name: "Alpha Lodge" },
      { id: "lodge-b", name: "Bravo Lodge" },
    ],
    loading: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const EDITED_MESSAGES = {
  "booking.payment.card.description":
    "Pay {{CLUB_LODGE_NAME}} now ({{CLUB_NAME}}).",
  "booking.payment.internetBanking.description":
    "Transfer to {{CLUB_LODGE_NAME}}. Questions: {{SUPPORT_EMAIL}}.",
  "booking.payment.internetBanking.unavailable":
    "{{CLUB_LODGE_NAME}} cannot take a transfer for these dates.",
};

const CLUB_TOKENS = {
  CLUB_NAME: "Alpine Club",
  // The club's DEFAULT lodge, which is not the lodge selected below.
  CLUB_LODGE_NAME: "Alpha Lodge",
  SUPPORT_EMAIL: "support@example.test",
  BASE_URL: "https://example.test",
};

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/booking-messages")) return jsonResponse(payload);
    if (u.includes("/api/members/family")) return jsonResponse({ familyMembers: [] });
    if (u.includes("/api/payments/options")) {
      return jsonResponse({
        methods: {
          stripe: { enabled: true, default: true },
          internetBanking: { enabled: true },
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
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the booking wizard's payment-method copy (#2919)", () => {
  it("substitutes every merge field, naming the lodge the member selected", async () => {
    stubFetch({ messages: EDITED_MESSAGES, tokens: CLUB_TOKENS });

    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => {
      expect(result.current.cardPaymentDescription).toContain("Alpine Club");
    });

    act(() => {
      result.current.handleLodgeChange("lodge-b");
    });

    await waitFor(() => {
      expect(result.current.cardPaymentDescription).toBe(
        "Pay Bravo Lodge now (Alpine Club)."
      );
    });
    expect(result.current.internetBankingPaymentDescription).toBe(
      "Transfer to Bravo Lodge. Questions: support@example.test."
    );
    expect(result.current.internetBankingUnavailableCopy).toBe(
      "Bravo Lodge cannot take a transfer for these dates."
    );
  });

  it("uses the club's default lodge until the member has picked one", async () => {
    stubFetch({ messages: EDITED_MESSAGES, tokens: CLUB_TOKENS });

    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => {
      expect(result.current.internetBankingPaymentDescription).toBe(
        "Transfer to Alpha Lodge. Questions: support@example.test."
      );
    });
  });

  it("blanks a merge field it has no value for rather than showing braces", async () => {
    // Bodies but no token values — an older response, or a failed settings read.
    stubFetch({ messages: EDITED_MESSAGES });

    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => {
      expect(result.current.cardPaymentDescription).toBe("Pay  now ().");
    });
    expect(result.current.internetBankingPaymentDescription).not.toContain("{{");
  });

  it("renders the shipped default bodies when the club has edited nothing", async () => {
    stubFetch({ messages: {}, tokens: CLUB_TOKENS });

    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => {
      expect(result.current.cardPaymentDescription).toBe(
        "Pay now and secure the booking immediately."
      );
    });
  });
});
