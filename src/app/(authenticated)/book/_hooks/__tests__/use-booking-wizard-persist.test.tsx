// @vitest-environment jsdom

/**
 * #4950 — the wizard keeps the member's work in this tab and brings it back
 * after the profile detour the guests step sends them on, or a refresh.
 *
 * Each case drives the real hook against a stubbed API. A "return" is a fresh
 * mount over whatever the previous mount left in `sessionStorage`, which is
 * exactly what following a link out of `/book` and back does.
 */
import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWizardWork,
  saveWizardWork,
  type SavedWizardWork,
} from "@/lib/booking-wizard-work";

const navigation = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: vi.fn() }),
  useSearchParams: () => navigation.searchParams,
}));

vi.mock("next-auth/react", () => ({
  signOut: vi.fn(async () => undefined),
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

const lodgeOptions = vi.hoisted(() => ({
  lodges: [
    { id: "lodge-a", name: "Lodge A" },
    { id: "lodge-b", name: "Lodge B" },
  ],
}));
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: lodgeOptions.lodges, loading: false }),
}));

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { signOutMember } from "@/lib/member-sign-out";
import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

const STORAGE_KEY = "booking-wizard-work";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/** Relative to the frozen clock (2026-07-01): future dates. */
const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

const SELF = {
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT" as const,
  isMember: true,
  memberId: "member-1",
};
const FRIEND = {
  firstName: "Sam",
  lastName: "Friend",
  ageTier: "ADULT" as const,
  isMember: false,
};

function savedWork(overrides: Partial<SavedWizardWork> = {}): SavedWizardWork {
  return {
    memberId: "member-1",
    lodgeId: "lodge-b",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    step: "guests",
    guests: [SELF, FRIEND],
    notes: "Arriving after dark",
    perGuestDatesEnabled: false,
    multiDateRangesEnabled: false,
    expectedArrivalTime: null,
    requestedRoomId: null,
    cancelIfGuestsBumped: false,
    groupTrip: false,
    groupPaymentMode: "EACH_PAYS_OWN",
    paymentMethod: "stripe",
    memberReviewJustification: "",
    useCredit: false,
    attendingWorkParty: false,
    selectedWorkPartyEventId: null,
    waitlistAlternateLodgeIds: [],
    ...overrides,
  };
}

function storedRecord(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function stubFetch({ policyValid = true } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.includes("/api/members/family")) {
      return jsonResponse({
        familyMembers: [
          {
            id: "member-1",
            firstName: "Jo",
            lastName: "Member",
            ageTier: "ADULT",
            relationship: "self",
            canLogin: true,
            canBeBooked: true,
            missingFields: [],
          },
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
    if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: false, rooms: [] });
    }
    if (u.includes("/api/availability/check")) {
      return jsonResponse({ lodgeCapacity: 20, nightDetails: [] });
    }
    if (u.includes("/api/booking-policies/check")) {
      return jsonResponse({ valid: policyValid, message: "Choose different dates" });
    }
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({
        totalPriceCents: 20000,
        availableCreditCents: 0,
        guests: [],
      });
    }
    if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
    if (u.endsWith("/api/bookings")) {
      return jsonResponse({ id: "booking-1", status: "PENDING", finalPriceCents: 20000 });
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  window.sessionStorage.clear();
  navigation.searchParams = new URLSearchParams();
  lodgeOptions.lodges = [
    { id: "lodge-a", name: "Lodge A" },
    { id: "lodge-b", name: "Lodge B" },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the booking wizard keeps the member's work in this tab (#4950)", () => {
  it("saves the inputs as they change, and nothing fetched or priced", async () => {
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-b");
    });
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    act(() => {
      result.current.handleGuestsChange([SELF, FRIEND]);
      result.current.setNotes("Arriving after dark");
    });

    await waitFor(() =>
      expect(storedRecord()).toMatchObject({
        memberId: "member-1",
        lodgeId: "lodge-b",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        step: "guests",
        guests: [SELF, FRIEND],
        notes: "Arriving after dark",
      }),
    );
    const stored = JSON.stringify(storedRecord());
    for (const derived of ["priceQuote", "Cents", "promo", "availableCredit", "familyMembers"]) {
      expect(stored).not.toContain(derived);
    }
  });

  it("flushes the latest edit on the profile detour and restores after remount", async () => {
    stubFetch();
    const first = renderHook(() => useBookingWizard());
    await act(async () => first.result.current.handleLodgeChange("lodge-b"));
    await act(async () => first.result.current.handleDateSelect(CHECK_IN, CHECK_OUT));
    act(() => {
      first.result.current.handleGuestsChange([SELF, FRIEND]);
      first.result.current.setNotes("Last edit before profile");
    });
    first.unmount(); // before the debounce completes
    const returned = renderHook(() => useBookingWizard());
    await waitFor(() => expect(returned.result.current.step).toBe("guests"));
    expect(returned.result.current.guests).toEqual([SELF, FRIEND]);
    expect(returned.result.current.notes).toBe("Last edit before profile");
  });

  it("does not write guest details back after sign-out, even on pagehide or unmount", async () => {
    saveWizardWork(savedWork());
    stubFetch();
    const mounted = renderHook(() => useBookingWizard());
    await waitFor(() => expect(mounted.result.current.step).toBe("guests"));
    act(() => mounted.result.current.setNotes("Pending edit"));
    await act(async () => signOutMember({ redirect: false }));
    act(() => window.dispatchEvent(new Event("pagehide")));
    mounted.unmount();
    expect(storedRecord()).toBeNull();
    const returned = renderHook(() => useBookingWizard());
    await waitFor(() => expect(returned.result.current.familyMembersLoaded).toBe(true));
    expect(returned.result.current.checkIn).toBeNull();
    expect(returned.result.current.guests).not.toContainEqual(FRIEND);
  });

  it("keeps chosen per-guest nights and review choices without restoring derived state", async () => {
    const guests = [SELF, { ...FRIEND, nights: [CHECK_IN] }];
    saveWizardWork(savedWork({
      guests,
      multiDateRangesEnabled: true,
      expectedArrivalTime: "18:00",
      requestedRoomId: "room-1",
      cancelIfGuestsBumped: true,
      groupTrip: true,
      useCredit: true,
      attendingWorkParty: true,
      selectedWorkPartyEventId: "event-1",
      waitlistAlternateLodgeIds: ["lodge-a"],
    }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.step).toBe("guests"));
    expect(result.current).toMatchObject({
      guests,
      multiDateRangesEnabled: true,
      expectedArrivalTime: "18:00",
      requestedRoomId: "room-1",
      cancelIfGuestsBumped: true,
      groupTrip: true,
      useCredit: true,
      attendingWorkParty: true,
      selectedWorkPartyEventId: "event-1",
      waitlistAlternateLodgeIds: ["lodge-a"],
      priceQuote: null,
    });
  });

  it("drops dates rejected by the current date checks, keeping the party", async () => {
    saveWizardWork(savedWork());
    stubFetch({ policyValid: false });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.error).toBe("Choose different dates"));
    expect(result.current.step).toBe("dates");
    expect(result.current.checkIn).toBeNull();
    expect(result.current.guests).toEqual([SELF, FRIEND]);
  });

  it("brings the work back on return: same step, lodge, dates, party and notes", async () => {
    saveWizardWork(savedWork());
    const calls = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.step).toBe("guests"));
    expect(result.current.lodgeId).toBe("lodge-b");
    expect(result.current.checkIn).toBe(CHECK_IN);
    expect(result.current.checkOut).toBe(CHECK_OUT);
    expect(result.current.guests).toEqual([SELF, FRIEND]);
    expect(result.current.notes).toBe("Arriving after dark");
    expect(result.current.restoredWorkNotice).toBe("kept");
    // The dates were checked afresh, against the restored lodge.
    expect(
      calls.some(
        (call) =>
          call.url.includes("/api/availability/check") &&
          call.url.includes("lodge-b"),
      ),
    ).toBe(true);
    // The family list is fetched, never restored.
    expect(calls.some((call) => call.url.includes("/api/members/family"))).toBe(true);
    // The member's own self seed does not run over the restored party.
    await waitFor(() => expect(result.current.familyMembersLoaded).toBe(true));
    expect(result.current.guests).toEqual([SELF, FRIEND]);
  });

  it("keeps a party the member emptied, rather than adding them back", async () => {
    saveWizardWork(savedWork({ guests: [] }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.step).toBe("guests"));
    await waitFor(() => expect(result.current.familyMembersLoaded).toBe(true));
    expect(result.current.guests).toEqual([]);
  });

  it("re-quotes a copy that had reached review, rather than restoring a price", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    const calls = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.step).toBe("review"));
    expect(result.current.priceQuote).toMatchObject({ totalPriceCents: 20000 });
    expect(calls.filter((call) => call.url.includes("/api/bookings/quote"))).toHaveLength(1);
  });

  it("forgets the work once the booking is submitted, and keeps nothing after", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(storedRecord()).toBeNull();
    act(() => {
      result.current.setNotes("typed after the submit");
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(storedRecord()).toBeNull();
  });

  it("forgets the work once it is saved as a draft", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

    await act(async () => {
      await result.current.handleSaveAsDraft();
    });

    expect(navigation.push).toHaveBeenCalledWith("/bookings/booking-1");
    expect(storedRecord()).toBeNull();
  });

  it("forgets the work once the member joins the waitlist", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

    await act(async () => {
      await result.current.handleJoinWaitlist();
    });

    expect(storedRecord()).toBeNull();
  });

  it("discards a copy that belongs to another member", async () => {
    saveWizardWork(savedWork({ memberId: "member-2" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(storedRecord()).toBeNull());
    expect(result.current.step).toBe("dates");
    expect(result.current.checkIn).toBeNull();
    expect(result.current.guests).not.toContainEqual(FRIEND);
    expect(result.current.restoredWorkNotice).toBeNull();
  });

  it("discards a copy with an unknown version", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...savedWork(), version: 99 }),
    );
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(storedRecord()).toBeNull());
    expect(result.current.step).toBe("dates");
    expect(result.current.guests).not.toContainEqual(FRIEND);
  });

  it("discards a copy naming a lodge the member can no longer book", async () => {
    lodgeOptions.lodges = [{ id: "lodge-a", name: "Lodge A" }];
    saveWizardWork(savedWork({ lodgeId: "lodge-b" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.familyMembersLoaded).toBe(true));
    expect(result.current.lodgeId).not.toBe("lodge-b");
    expect(result.current.guests).not.toContainEqual(FRIEND);
    expect(result.current.restoredWorkNotice).toBeNull();
    expect(storedRecord()?.lodgeId ?? null).not.toBe("lodge-b");
  });

  it("drops dates that have passed, keeps the party, and lands on the dates step", async () => {
    saveWizardWork(
      savedWork({
        checkIn: "2026-06-20",
        checkOut: "2026-06-22",
        perGuestDatesEnabled: true,
        guests: [SELF, { ...FRIEND, stayStart: "2026-06-20", stayEnd: "2026-06-21" }],
      }),
    );
    const calls = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.restoredWorkNotice).toBe("datesDropped"));
    expect(result.current.step).toBe("dates");
    expect(result.current.checkIn).toBeNull();
    expect(result.current.checkOut).toBeNull();
    expect(result.current.perGuestDatesEnabled).toBe(false);
    expect(result.current.guests).toEqual([SELF, FRIEND]);
    expect(result.current.lodgeId).toBe("lodge-b");
    expect(calls.some((call) => call.url.includes("/api/availability/check"))).toBe(false);
  });

  it("yields to a ?replaceRequest= visit", async () => {
    navigation.searchParams = new URLSearchParams("replaceRequest=req-1");
    saveWizardWork(savedWork());
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.familyMembersLoaded).toBe(true));
    expect(result.current.step).toBe("dates");
    expect(result.current.checkIn).toBeNull();
    expect(result.current.guests).not.toContainEqual(FRIEND);
    expect(result.current.restoredWorkNotice).toBeNull();
  });

  it("forgets the work when the member chooses to start again", async () => {
    saveWizardWork(savedWork());
    stubFetch();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.restoredWorkNotice).toBe("kept"));

    act(() => {
      result.current.startAgain();
    });

    expect(storedRecord()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/book");
    clearWizardWork();
  });
});
