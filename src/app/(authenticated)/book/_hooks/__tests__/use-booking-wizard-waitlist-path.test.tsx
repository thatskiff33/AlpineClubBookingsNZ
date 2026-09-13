// @vitest-environment jsdom

/**
 * #2930 fix round — the review step's Join Waitlist became a PRIMARY action, and
 * three things that were harmless while it was a fallback after a 409 stopped
 * being harmless.
 *
 * 1. The post carried no applied account credit. `POST /api/bookings` runs the
 *    ordinary create first and only waitlists when capacity refuses, so if beds
 *    freed up between the advisory and the press the member got a REAL booking
 *    without the credit they had applied, owing more than the screen quoted.
 * 2. An unconfigured lodge resolves to 0 beds by design, and a ceiling of 0
 *    disabled every add-guest control at zero guests while the step still needs
 *    one guest — with the calendar inviting the member onto the waitlist.
 * 3. Switching lodge left the previous lodge's capacity standing as the party
 *    ceiling until a response arrived, which for a lodge the member cannot book
 *    is never.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// The club-identity figure: one lodge's bed count, used only as the
// pre-selection fallback. Every assertion below is about what REPLACES it.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-a", name: "Lodge A" },
      { id: "lodge-b", name: "Lodge B" },
    ],
    loading: false,
  }),
}));

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/** Dates relative to the frozen clock (2026-07-01), so both are future. */
const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

interface StubOptions {
  /** What `/api/availability/check` answers, or "refuse" for a non-200. */
  availability: { lodgeCapacity: number; nightDetails: unknown[] } | "refuse";
  /** Credit the quote reports as available to the booker. */
  availableCreditCents?: number;
}

/** Every night of the fixture stay with no free bed: the advisory goes short. */
const FULL_NIGHTS = [
  { date: "2026-08-01", availableBeds: 0 },
  { date: "2026-08-02", availableBeds: 0 },
];

const ONE_MEMBER_GUEST = [
  { firstName: "Jo", lastName: "Member", ageTier: "ADULT" as const, isMember: true },
];

function stubFetch(options: StubOptions) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [] });
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
    if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: false, rooms: [] });
    }
    if (u.includes("/api/availability/check")) {
      if (options.availability === "refuse") {
        return jsonResponse({ error: "not eligible" }, false);
      }
      return jsonResponse(options.availability);
    }
    if (u.includes("/api/booking-policies/check")) {
      return jsonResponse({ valid: true });
    }
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({
        totalPriceCents: 20000,
        availableCreditCents: options.availableCreditCents ?? 0,
        guests: [],
      });
    }
    if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
    if (u.includes("/api/bookings")) {
      return jsonResponse({ id: "booking-1", status: "WAITLISTED" }, true);
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the waitlist join carries the money the screen showed (#2930)", () => {
  it("sends the applied account credit, exactly as Confirm Booking does", async () => {
    const calls = stubFetch({
      availability: { lodgeCapacity: 20, nightDetails: [] },
      availableCreditCents: 5000,
    });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    act(() => {
      result.current.handleGuestsChange([
        { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
      ]);
    });
    await act(async () => {
      await result.current.handleGuestsDone();
    });
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

    act(() => {
      result.current.setUseCredit(true);
    });
    await waitFor(() => expect(result.current.appliedCreditCents).toBe(5000));

    await act(async () => {
      await result.current.handleJoinWaitlist();
    });

    const post = calls.filter(
      (call) => call.url.endsWith("/api/bookings") && call.body,
    );
    expect(post).toHaveLength(1);
    // The defect in one assertion: this was undefined, and the same POST can
    // create a REAL booking when beds freed up in the meantime.
    expect((post[0].body as { applyCreditCents?: number }).applyCreditCents).toBe(
      5000,
    );
    // And still no payment method — contract point 5 is unaffected.
    expect((post[0].body as { paymentMethod?: string }).paymentMethod).toBeUndefined();
    expect((post[0].body as { waitlist?: boolean }).waitlist).toBe(true);
  });
});

describe("a lodge with no configured capacity is not a dead end (#2930)", () => {
  it("imposes no client party ceiling when the lodge resolves to zero beds", async () => {
    // `getLodgeCapacityStatus` returns 0 for an unconfigured lodge BY DESIGN, so
    // it can never be overbooked before somebody configures it. Read as a
    // ceiling that is "you may add zero guests", while the calendar shows every
    // night full and offers the waitlist.
    stubFetch({ availability: { lodgeCapacity: 0, nightDetails: [] } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });

    await waitFor(() => expect(result.current.lodgeCapacity).toBeNull());

    // The proof it is not merely a different number: a guest can still be added.
    act(() => {
      result.current.handleGuestsChange([
        { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
      ]);
    });
    expect(result.current.guests).toHaveLength(1);
  });

  it("reports a real capacity as the ceiling, unchanged", async () => {
    stubFetch({ availability: { lodgeCapacity: 8, nightDetails: [] } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });

    await waitFor(() => expect(result.current.lodgeCapacity).toBe(8));
  });
});

describe("the party ceiling belongs to the lodge on screen (#2930)", () => {
  it("clears the resolved capacity when the availability check is REFUSED", async () => {
    // A member not eligible to book this lodge gets a refusal on every date, and
    // the guests step is reachable through that branch — so a capacity left
    // standing here is another lodge's number applied to this one.
    stubFetch({ availability: "refuse" });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });

    await waitFor(() => expect(result.current.lodgeCapacity).toBeNull());
  });

  it("clears it on a lodge change, before any response arrives", async () => {
    stubFetch({ availability: { lodgeCapacity: 8, nightDetails: [] } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    await waitFor(() => expect(result.current.lodgeCapacity).toBe(8));

    act(() => {
      result.current.handleLodgeChange("lodge-b");
    });

    expect(result.current.lodgeCapacity).toBeNull();
  });
});

/**
 * #2930 SECOND fix round — two findings the first round created, both about
 * state that used to be safe only because the 409 refusal prompt was the ONLY
 * door to the waitlist.
 */
describe("per-lodge state the second fix round found still standing (#2930)", () => {
  it("drops the cross-lodge waitlist opt-in when the lodge changes", async () => {
    stubFetch({ availability: { lodgeCapacity: 8, nightDetails: [] } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    // "Also waitlist me for Lodge B", ticked on the REVIEW step — which the
    // first round added and which raises no refusal prompt, so nothing on the
    // way in empties the array the way the prompt's own handler does.
    act(() => {
      result.current.setWaitlistAlternateLodgeIds(() => ["lodge-b"]);
    });
    expect(result.current.waitlistAlternateLodgeIds).toEqual(["lodge-b"]);

    act(() => {
      result.current.handleLodgeChange("lodge-b");
    });

    // Carried across, this is a box pre-ticked for a lodge chosen in another
    // context — and here it names the lodge the member just switched TO.
    expect(result.current.waitlistAlternateLodgeIds).toEqual([]);
  });

  it("closes the 409 refusal prompt once the review step offers the waitlist", async () => {
    // Both doors render at once otherwise: the prompt is drawn ABOVE a review
    // step that stays mounted, so the member gets the "Also waitlist me for ..."
    // checkboxes twice and two Join Waitlist buttons.
    stubFetch({ availability: { lodgeCapacity: 4, nightDetails: FULL_NIGHTS } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    act(() => {
      result.current.handleGuestsChange(ONE_MEMBER_GUEST);
    });
    await waitFor(() => expect(result.current.waitlistOnly).toBe(true));

    // The 409 arm: reachable because the member pressed Confirm while the
    // advisory still said the stay was confirmable, and the figures moved after.
    act(() => {
      result.current.setShowWaitlistPrompt(true);
    });

    await waitFor(() => expect(result.current.showWaitlistPrompt).toBe(false));
  });

  it("leaves the prompt open when the review step is NOT offering the waitlist", async () => {
    // The ordinary 409 path, and the one the prompt exists for: the advisory has
    // no per-night figures, so the prompt is the only door and must stay up.
    stubFetch({ availability: { lodgeCapacity: 8, nightDetails: [] } });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    expect(result.current.waitlistOnly).toBe(false);

    act(() => {
      result.current.setShowWaitlistPrompt(true);
    });

    await waitFor(() => expect(result.current.showWaitlistPrompt).toBe(true));
  });
});
