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
    memberReviewJustification: "",
    useCredit: false,
    attendingWorkParty: false,
    selectedWorkPartyEventId: null,
    waitlistAlternateLodgeIds: [],
    selfSeedSettled: true,
    ...overrides,
  };
}

function storedRecord(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function stubFetch({
  policyValid = true,
  internetBanking = false,
  subscriptionStatus = "PAID",
  rooms = null,
  bookingsReply = null,
  availabilityDelayMs = 0,
}: {
  policyValid?: boolean;
  /** How long the availability check takes to answer. */
  availabilityDelayMs?: number;
  internetBanking?: boolean;
  subscriptionStatus?: string;
  /** Rooms the lodge offers for a request, or null for room requests off. */
  rooms?: Array<{ id: string; name: string; bedCount: number }> | null;
  /** Replaces the answer to every create, waitlist and draft call. */
  bookingsReply?: Response | null;
} = {}) {
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
          internetBanking: { enabled: internetBanking },
        },
        groupBookingsEnabled: false,
      });
    }
    if (u.includes("/api/member/subscription-status")) {
      return jsonResponse({
        status: subscriptionStatus,
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
    }
    if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: rooms !== null, rooms: rooms ?? [] });
    }
    if (u.includes("/api/availability/check")) {
      if (availabilityDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, availabilityDelayMs));
      }
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
      return (
        bookingsReply ??
        jsonResponse({ id: "booking-1", status: "PENDING", finalPriceCents: 20000 })
      );
    }
    if (u.includes("/api/bookings/exception-requests")) {
      return jsonResponse({ id: "request-1", proposal: {}, capacityHeld: false });
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
    stubFetch({ rooms: [{ id: "room-1", name: "Room 1", bedCount: 4 }] });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.step).toBe("guests"));
    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));
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
    saveWizardWork(savedWork({ guests: [], selfSeedSettled: true }));
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

  it("does not keep the payment method, which is payment state", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch({ internetBanking: true });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());
    await waitFor(() => expect(result.current.internetBankingEnabled).toBe(true));

    act(() => {
      result.current.setPaymentMethod("internet_banking");
      result.current.setNotes("after choosing Internet Banking");
    });

    await waitFor(() =>
      expect(storedRecord()).toMatchObject({ notes: "after choosing Internet Banking" }),
    );
    expect(storedRecord()).not.toHaveProperty("paymentMethod");
    expect(result.current.paymentMethod).toBe("internet_banking");
  });

  it("keeps the copy when a guest's own date is cleared", async () => {
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await act(async () => result.current.handleLodgeChange("lodge-b"));
    await act(async () => result.current.handleDateSelect(CHECK_IN, CHECK_OUT));
    act(() => {
      // A native date input reads '' once the member clears it.
      result.current.handleGuestsChange([SELF, { ...FRIEND, stayStart: "" }]);
      result.current.setNotes("after clearing a date");
    });

    await waitFor(() =>
      expect(storedRecord()).toMatchObject({ notes: "after clearing a date" }),
    );
    expect(storedRecord()?.guests).toEqual([SELF, FRIEND]);
  });

  it("seeds the member on return when the copy was kept before the seed had run", async () => {
    saveWizardWork(savedWork({ guests: [], selfSeedSettled: false }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.step).toBe("guests"));
    await waitFor(() => expect(result.current.guests).toEqual([SELF]));
  });

  it("records that the seed has run, so a later empty party stays the member's choice", async () => {
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await act(async () => result.current.handleLodgeChange("lodge-b"));
    await waitFor(() => expect(result.current.guests).toEqual([SELF]));
    act(() => result.current.handleGuestsChange([]));

    await waitFor(() => expect(storedRecord()).toMatchObject({ guests: [] }));
    expect(storedRecord()).toMatchObject({ selfSeedSettled: true });
  });

  it("sends a blocked member back to the dates step, with the party kept", async () => {
    saveWizardWork(savedWork({ step: "guests" }));
    const calls = stubFetch({ subscriptionStatus: "UNPAID" });
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.bookingBlockedBySubscription).toBe(true));
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/api/booking-policies/check"))).toBe(true),
    );
    await act(async () => undefined);
    expect(result.current.step).toBe("dates");
    expect(result.current.guests).toEqual([SELF, FRIEND]);
  });

  it("keeps the step the member had reached while a slow restore is still checking the dates", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch({ availabilityDelayMs: 700 });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.restoredWorkNotice).toBe("kept"));

    // Past the save debounce, with the date check still in flight.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(result.current.step).toBe("dates");
    expect(storedRecord()).toMatchObject({ step: "review" });

    await waitFor(() => expect(result.current.step).toBe("review"), { timeout: 5000 });
    expect(storedRecord()).toMatchObject({ step: "review" });
  });

  it("keeps the dates step once a restore could not get back to the step it had", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch({ policyValid: false });
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.error).toBe("Choose different dates"));
    await waitFor(() => expect(storedRecord()).toMatchObject({ step: "dates" }));
    expect(result.current.step).toBe("dates");
  });

  it("tells the member the dates went when the date check refuses them on return", async () => {
    saveWizardWork(savedWork());
    stubFetch({ policyValid: false });
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.error).toBe("Choose different dates"));
    expect(result.current.restoredWorkNotice).toBe("datesDropped");
  });

  it("stops saying the dates went once the member has chosen new ones", async () => {
    saveWizardWork(savedWork({ checkIn: "2026-06-20", checkOut: "2026-06-22" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.restoredWorkNotice).toBe("datesDropped"));

    await act(async () => result.current.handleDateSelect(CHECK_IN, CHECK_OUT));

    expect(result.current.restoredWorkNotice).toBeNull();
  });

  it("forgets a room request the lodge no longer offers", async () => {
    saveWizardWork(savedWork({ requestedRoomId: "room-9" }));
    stubFetch({ rooms: [{ id: "room-1", name: "Room 1", bedCount: 4 }] });
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));
    await waitFor(() => expect(result.current.requestedRoomId).toBeNull());
  });

  it("forgets a room request once the club has switched room requests off", async () => {
    saveWizardWork(savedWork({ requestedRoomId: "room-1" }));
    stubFetch({ rooms: null });
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.step).toBe("guests"));
    await waitFor(() => expect(result.current.requestedRoomId).toBeNull());
  });

  it("forgets the work once an exception request is sent", async () => {
    saveWizardWork(savedWork({ step: "review" }));
    stubFetch();
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

    await act(async () => {
      await result.current.submitExceptionRequest({
        memberMessage: "Please review",
        supersedeRequestId: null,
      });
    });

    expect(storedRecord()).toBeNull();
  });

  // A reply the browser cannot verify leaves the member in the wizard to try
  // again (#5035, #5036), so what they typed must still be there to try with.
  describe.each([
    ["an unreadable body", () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) as Response],
    ["a 200 with no booking id", () => jsonResponse({ status: "PENDING" })],
  ])("when the server answers with %s", (_name, reply) => {
    it.each([
      ["confirm", "handleSubmit"],
      ["waitlist", "handleJoinWaitlist"],
      ["draft", "handleSaveAsDraft"],
    ] as const)("keeps the work on the %s path", async (_path, handler) => {
      saveWizardWork(savedWork({ step: "review" }));
      stubFetch({ bookingsReply: reply() });
      const { result } = renderHook(() => useBookingWizard());
      await waitFor(() => expect(result.current.priceQuote).toBeTruthy());

      await act(async () => {
        await result.current[handler]();
      });

      expect(navigation.push).not.toHaveBeenCalled();
      expect(storedRecord()).toMatchObject({ lodgeId: "lodge-b", guests: [SELF, FRIEND] });
    });
  });
});
