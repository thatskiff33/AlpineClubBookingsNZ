// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

// #2250 — the wizard's member-night 409 banner. The 409's own `error` is the
// SELF-CONTAINED sentence (situation + next step) written for callers that
// render nothing else; the wizard renders a per-conflict card underneath that
// states the nights, the booking, the buttons, and this viewer's next step. So
// the banner must carry the situation only, or the same sentence appears twice
// on the single-conflict screen.

// #2562: the wizard reads `?replaceRequest=<id>` so a member can replace an open
// exception request from their own request list. Stubbed as an empty query here —
// these cases are not about that path.
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

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Alpine Lodge" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

const CONFLICT = {
  memberId: "member-1",
  memberName: "Jo Member",
  bookingId: "booking-2",
  bookingStatus: "PAYMENT_PENDING",
  bookingOwnerName: "Jo Member",
  bookingCheckIn: "2026-06-11",
  bookingCheckOut: "2026-06-13",
  guestId: "guest-2",
  conflictingNights: ["2026-06-11"],
  isOwnBooking: true,
  canOpenBooking: true,
  canSelfRemove: false,
  isSelfGuest: true,
};

// What the server actually puts on the wire: the self-contained sentence.
const SERVER_ERROR =
  "You are already on another booking for 11 Jun 2026. Open that booking and change it.";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function stubFetch(conflictBody: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
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
    if (u.includes("/api/bookings/rooms"))
      return jsonResponse({ enabled: false, rooms: [] });
    if (u.includes("/api/bookings/quote"))
      return jsonResponse(conflictBody, false, 409);
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seatedWizard(conflictBody: Record<string, unknown>) {
  stubFetch(conflictBody);
  const { result } = renderHook(() => useBookingWizard());
  await waitFor(() => expect(result.current.guests).toHaveLength(1));

  act(() => result.current.handleLodgeChange("lodge-1"));
  await act(async () => {
    await result.current.handleDateSelect("2026-06-11", "2026-06-12");
  });
  await act(async () => {
    await result.current.handleGuestsDone();
  });
  return result;
}

describe("booking wizard member-night conflict banner (#2250)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the situation only, leaving the next step to the conflict card below", async () => {
    const result = await seatedWizard({
      code: "BOOKING_MEMBER_NIGHT_CONFLICT",
      error: SERVER_ERROR,
      conflicts: [CONFLICT],
    });

    expect(result.current.memberNightConflicts).toHaveLength(1);
    expect(result.current.error).toBe(
      "You are already on another booking for 11 Jun 2026.",
    );
    // The card renders this itself; repeating it in the banner printed the same
    // sentence twice on the single-conflict screen.
    expect(result.current.error).not.toContain("Open that booking and change it");
    expect(result.current.error).not.toBe(SERVER_ERROR);
  });

  // #2250 — an unentitled row (the requester's family member turns out to be a
  // guest on a stranger's booking) arrives with NO booking or guest ids at all,
  // because the server scopes the payload to what this viewer may see.
  it("handles a scoped conflict row that carries no booking detail", async () => {
    const result = await seatedWizard({
      code: "BOOKING_MEMBER_NIGHT_CONFLICT",
      error:
        "Bob Jones is already on a booking for 11 Jun 2026. " +
        "Ask whoever made that booking, or the club, to take them off it.",
      conflicts: [
        {
          memberId: "member-2",
          memberName: "Bob Jones",
          conflictingNights: ["2026-06-11"],
          isOwnBooking: false,
          canOpenBooking: false,
          canSelfRemove: false,
          isSelfGuest: false,
        },
      ],
    });

    expect(result.current.memberNightConflicts).toHaveLength(1);
    expect(result.current.error).toBe(
      "Bob Jones is already on a booking for 11 Jun 2026.",
    );

    // Neither button renders for such a row, and the removal call refuses to
    // build a URL out of undefined ids even if one somehow fired.
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    await act(async () => {
      await result.current.handleRemoveConflictGuest(
        result.current.memberNightConflicts[0],
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.memberNightConflicts).toHaveLength(1);
  });

  it("falls back to the server's own sentence when the 409 carries no conflict rows", async () => {
    const result = await seatedWizard({
      code: "BOOKING_MEMBER_NIGHT_CONFLICT",
      error: SERVER_ERROR,
      conflicts: [],
    });

    expect(result.current.memberNightConflicts).toHaveLength(0);
    // Nothing renders underneath, so the banner must carry the whole thing.
    expect(result.current.error).toBe(SERVER_ERROR);
  });
});
